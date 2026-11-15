import { describe, expect, it } from 'vitest';
import type { AppActions } from '../src/app/actions';
import { HISTORY_DAYS, MISSION_START_MINUTES } from '../src/config';
import { GroundLink, type LinkTimers } from '../src/data/GroundLink';
import { HealthStore } from '../src/data/HealthStore';
import { MissionClock } from '../src/data/MissionClock';
import { scenarioById } from '../src/data/sources/scenarios';
import { SimulatedSource } from '../src/data/sources/SimulatedSource';
import { MissionTour, TOUR_STEPS, type MissionTourStep, type TourCard, type TourStage } from '../src/demo/MissionTour';
import { changesSinceYesterday, planForToday } from '../src/domain/checkIn';
import { thresholdsFor } from '../src/domain/engine/evaluate';
import { buildEpisodes, episodeSummary } from '../src/domain/episode';
import { formatContactCountdown, isLinkUp } from '../src/domain/link';

/** Timers that run only when told to, so wall-clock behaviour is exact in tests. */
class ManualTimers implements LinkTimers {
  private time = 0;
  private queue: { at: number; callback: () => void; id: number }[] = [];
  private seq = 0;
  now = (): number => this.time;
  setTimeout = (callback: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.queue.push({ at: this.time + ms, callback, id });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.queue = this.queue.filter((entry) => entry.id !== handle);
  };
  advance(ms: number): void {
    const until = this.time + ms;
    for (;;) {
      const next = this.queue.filter((entry) => entry.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.queue = this.queue.filter((entry) => entry !== next);
      this.time = next.at;
      next.callback();
    }
    this.time = until;
  }
}

function mission(environment: 'iss' | 'mars' = 'iss') {
  const store = new HealthStore(environment);
  const clock = new MissionClock(MISSION_START_MINUTES);
  const simulator = new SimulatedSource(clock, () => store.environment);
  simulator.connect(store);
  simulator.seedHistory(HISTORY_DAYS);
  const timers = new ManualTimers();
  const link = new GroundLink(store, timers);
  const advance = (minutes: number): void => {
    for (let left = minutes; left > 0; left -= 60) {
      const previous = clock.now;
      clock.now = previous + Math.min(60, left);
      store.ingest(simulator.advance(previous, clock.now), clock.now);
    }
  };
  const actions: AppActions = {
    logReading: () => undefined,
    setScenario: (id) => simulator.setScenario(scenarioById(id)),
    setSpeed: (speed) => clock.setSpeed(speed),
    setAutoLog: () => undefined,
    resetMission() {
      clock.now = MISSION_START_MINUTES;
      store.reset(clock.now);
      simulator.seedHistory(HISTORY_DAYS);
    },
    startIntervention(id, text, level) {
      store.startIntervention(id, text, level);
      simulator.applyCountermeasure(id);
    },
    setDrugsPreauthorized: (enabled) => store.setDrugsPreauthorized(enabled),
    reportSymptom: (input) => void store.reportSymptom(input),
    removeSymptom: (id) => store.removeSymptom(id),
    sendToFlightSurgeon: () => void (isLinkUp(store.link) ? store.requestConsult(timers.now()) : store.queueConsult()),
    advanceMission: advance,
    setLossOfSignal: (seconds) => (seconds === null ? link.restore() : link.beginLoss(seconds * 1000)),
  };
  return { store, clock, simulator, timers, link, actions, advance };
}

/** A stage that draws nothing and records what it was asked to show. */
function fakeStage(onStep: (step: MissionTourStep) => void = () => undefined, ending: 'explore' | 'restart' = 'explore') {
  const log = { steps: [] as MissionTourStep[], captions: [] as string[], cards: [] as (TourCard | null)[], guidance: 0, guidanceClosed: 0, disposed: 0, transitions: [] as string[] };
  let endings = 0;
  const stage: TourStage = {
    intro: async () => 'start',
    caption: (text, options) => void log.captions.push(`${options?.title ? `${options.title}: ` : ''}${text}`),
    progress: (step) => {
      log.steps.push(step);
      onStep(step);
    },
    card: (card) => void log.cards.push(card),
    transition: (from, to) => void log.transitions.push(`${from}>${to}`),
    showGuidance: () => {
      log.guidance++;
      return () => void log.guidanceClosed++;
    },
    ending: async () => (endings++ === 0 ? ending : 'explore'),
    onControl: () => undefined,
    setPaused: () => undefined,
    dispose: () => void log.disposed++,
  };
  return { stage, log };
}

/** Runs timers as fast as promises allow: the whole tour in a few milliseconds. */
const instant = { setTimeout: (callback: () => void): unknown => (queueMicrotask(callback), 0), clearTimeout: (): void => undefined };

describe('Play the Mission', () => {
  const run = async (ending: 'explore' | 'restart' = 'explore') => {
    const m = mission('iss');
    // The radio link runs on its own clock: let it move while the tour plays.
    const { stage, log } = fakeStage(() => m.timers.advance(20_000), ending);
    let restored = 0;
    const tour = new MissionTour({ actions: m.actions, store: m.store, stage, suspendSimulator: () => () => void restored++, ...instant });
    // Snapshots taken while it plays.
    const seen = { consultEnvironments: [] as string[], statusAtAction: '', outcome: '', before: '', after: '' };
    m.store.events.on('consults', (consults) => {
      const last = consults[consults.length - 1];
      if (last && !seen.consultEnvironments.includes(`${last.id}:${last.environment}`)) seen.consultEnvironments.push(`${last.id}:${last.environment}`);
    });
    m.store.events.on('interventions', (interventions) => {
      const last = interventions[interventions.length - 1];
      if (!last) return;
      if (last.outcome === 'pending') seen.statusAtAction = m.store.evaluation.triage.status;
      else seen.outcome = last.outcome;
    });
    await tour.start();
    return { m, log, seen, restored, tour };
  };

  it('plays every step in order and ends with the episode verified', async () => {
    const { log, seen } = await run();
    expect(log.steps).toEqual([...TOUR_STEPS]);
    expect(seen.statusAtAction).toBe('critical');
    expect(seen.outcome).toBe('verified');
    expect(log.guidance).toBe(1);
    expect(log.guidanceClosed).toBeGreaterThanOrEqual(1);
    expect(log.transitions).toEqual(['Station>Mars']);
    const verify = log.cards.find((card) => card?.kind === 'verify');
    expect(verify).toMatchObject({ kind: 'verify', verified: true });
  });

  it('consults the ground near Earth first, then from Mars with its real delay', async () => {
    const { log, seen } = await run();
    expect(seen.consultEnvironments).toEqual(['1:iss', '2:mars']);
    const delay = log.cards.find((card) => card?.kind === 'delay');
    expect(delay).toMatchObject({ near: { name: 'Station', roundTrip: '2.5 s' }, far: { name: 'Mars', roundTrip: '44 min' } });
    expect(log.captions.some((c) => c.includes('Round-trip delay ≈ 44 min'))).toBe(true);
  });

  it('is deterministic: two runs show exactly the same thing', async () => {
    const first = await run();
    const second = await run();
    expect(second.log.captions).toEqual(first.log.captions);
    expect(second.log.cards).toEqual(first.log.cards);
  });

  it('leaves the app as it found it', async () => {
    const m = mission('mars');
    const { stage, log } = fakeStage();
    let restored = 0;
    const tour = new MissionTour({ actions: m.actions, store: m.store, stage, suspendSimulator: () => () => void restored++, ...instant });
    await tour.start();
    expect(tour.active).toBe(false);
    expect(restored).toBe(1);
    expect(log.disposed).toBe(1);
    expect(m.store.environment.id).toBe('mars');
    expect(m.store.twinView).toBe('astronaut');
    expect(m.store.selected).toBeNull();
    expect(m.store.reportMode).toBe(false);
  });

  it('can be skipped at any step, and still restores everything', async () => {
    for (const at of ['scan', 'guidance', 'marsConsult', 'verify'] as const) {
      const m = mission('iss');
      let tour!: MissionTour;
      const { stage, log } = fakeStage((step) => {
        if (step === at) tour.skip();
      });
      let restored = 0;
      tour = new MissionTour({ actions: m.actions, store: m.store, stage, suspendSimulator: () => () => void restored++, ...instant });
      await tour.start();
      expect(tour.active).toBe(false);
      expect(log.steps[log.steps.length - 1]).toBe(at);
      expect(restored).toBe(1);
      expect(log.disposed).toBe(1);
      expect(m.store.twinView).toBe('astronaut');
    }
  });

  it('plays again on "Restart mission"', async () => {
    const { log } = await run('restart');
    expect(log.steps.filter((step) => step === 'intro')).toHaveLength(2);
    expect(log.steps.filter((step) => step === 'ending')).toHaveLength(2);
  });

  it('never writes a reading or a status itself: a report during the tour changes nothing', async () => {
    const { m } = await run();
    // Whatever was flagged during the tour came from the simulator through the rules engine.
    const statusEvents = m.store.missionLog.filter((event) => event.kind === 'status');
    expect(statusEvents.every((event) => event.source === 'measured')).toBe(true);
  });
});

describe('loss of signal: store and forward', () => {
  const critical = () => {
    const m = mission('mars');
    m.actions.setScenario('sans');
    m.advance(30 * 60);
    expect(m.store.consultReason).not.toBeNull();
    return m;
  };

  it('does not change the triage', () => {
    const m = critical();
    const before = JSON.stringify(m.store.evaluation);
    m.link.beginLoss(60_000);
    expect(JSON.stringify(m.store.evaluation)).toBe(before);
    expect(m.store.link.state).toBe('loss-of-signal');
  });

  it('queues the report instead of sending it, and loses nothing', () => {
    const m = critical();
    m.link.beginLoss(60_000);
    m.actions.reportSymptom({ systemId: 'sensory', position: { x: 0, y: 1.6, z: 0 }, intensity: 7, type: 'dizziness' });
    m.actions.sendToFlightSurgeon();
    expect(m.store.consults).toHaveLength(0);
    expect(m.store.queuedConsult).not.toBeNull();
    expect(m.store.queuedConsult!.request.summary.length).toBeGreaterThan(0);
    expect(m.store.requestConsult(0)).toBeNull();
  });

  it('counts down to the next contact window and reacquires before it opens', () => {
    const m = critical();
    m.link.beginLoss(1_122_000);
    expect(formatContactCountdown(m.store.link, m.timers.now())).toBe('00:18:42');
    m.timers.advance(1_122_000 - 2000);
    expect(m.store.link.state).toBe('reacquiring');
  });

  it('sends the queued report automatically at acquisition of signal, and records it', () => {
    const m = critical();
    m.link.beginLoss(60_000);
    m.actions.sendToFlightSurgeon();
    const packed = m.store.queuedConsult!.request;
    m.timers.advance(60_000);
    expect(m.store.link.state).toBe('available');
    expect(m.store.queuedConsult).toBeNull();
    expect(m.store.consults).toHaveLength(1);
    expect(m.store.consults[0].request).toEqual(packed);
    const texts = m.store.missionLog.map((event) => event.text);
    const order = ['LOS: loss of signal', 'report queued on board', 'AOS: acquisition of signal', 'Queued medical report transmitted'].map((part) => texts.findIndex((text) => text.includes(part)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('restores on demand and sends nothing when nothing was queued', () => {
    const m = critical();
    m.link.beginLoss(60_000);
    m.link.restore();
    expect(m.store.link.state).toBe('available');
    expect(m.store.consults).toHaveLength(0);
    m.timers.advance(120_000);
    expect(m.store.link.state).toBe('available');
  });
});

describe('episode record', () => {
  const episode = () => {
    const m = mission('iss');
    m.actions.setScenario('sans');
    m.advance(30 * 60);
    const system = Object.values(m.store.evaluation.systems).find((s) => s.status === 'critical')!;
    m.actions.reportSymptom({ systemId: system.def.id, position: { x: 0, y: 1.6, z: 0 }, intensity: 6, type: 'dizziness', notes: 'Light-headed' });
    m.actions.sendToFlightSurgeon();
    m.timers.advance(20_000);
    m.actions.startIntervention(system.driver!.def.id, 'Follow the medical checklist with the Crew Medical Officer.', 2);
    m.advance(40 * 60);
    return { m, system, episodes: buildEpisodes(m.store.missionLog) };
  };

  it('opens when a system leaves nominal and closes when it is measured back', () => {
    const { episodes, system } = episode();
    const record = episodes.find((e) => e.systemId === system.def.id)!;
    expect(record).toBeDefined();
    expect(record.outcome).toBe('resolved');
    expect(record.closedAt).toBeGreaterThan(record.startedAt);
  });

  it('files each entry under the right SOAP heading, with its source', () => {
    const { episodes, system } = episode();
    const record = episodes.find((e) => e.systemId === system.def.id)!;
    expect(record.subjective.every((line) => line.source === 'reported')).toBe(true);
    expect(record.subjective[0].text).toMatch(/Discomfort reported: dizziness/);
    expect(record.objective.every((line) => line.source === 'measured')).toBe(true);
    expect(record.assessment.every((line) => line.source === 'triage')).toBe(true);
    expect(record.plan.some((line) => line.text.includes('Onboard protocol step carried out'))).toBe(true);
    expect(record.plan.some((line) => line.source === 'ground')).toBe(true);
    expect(record.plan.some((line) => line.text.startsWith('Verified'))).toBe(true);
  });

  it('keeps the timeline in the order things happened and invents nothing', () => {
    const { episodes, system, m } = episode();
    const record = episodes.find((e) => e.systemId === system.def.id)!;
    const times = record.timeline.map((event) => event.t);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const logged = new Set(m.store.missionLog.map((event) => event.id));
    expect(record.timeline.every((event) => logged.has(event.id))).toBe(true);
  });

  it('exports a readable summary that says it is not a diagnosis', () => {
    const { episodes } = episode();
    const text = episodeSummary(episodes[0], (t) => `T+${Math.round(t)}`);
    expect(text).toContain('S - Subjective');
    expect(text).toContain('not a diagnosis');
    expect(JSON.parse(JSON.stringify(episodes[0])).id).toBe(episodes[0].id);
  });
});

describe('daily check-in', () => {
  it('reports no change on a steady day and real changes when a scenario bites', () => {
    const steady = mission('iss');
    const sd = (store: HealthStore) => (id: Parameters<HealthStore['baselineOf']>[0]) => store.baselineOf(id)?.baseline.sd;
    const quiet = changesSinceYesterday((id) => steady.store.history(id), steady.store.missionTime, sd(steady.store));
    const m = mission('iss');
    m.actions.setScenario('sleep-loss');
    m.advance(36 * 60);
    const changes = changesSinceYesterday((id) => m.store.history(id), m.store.missionTime, sd(m.store));
    expect(quiet.map((c) => c.def.id)).toEqual([]);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes.length).toBeLessThanOrEqual(3);
    expect(changes.some((c) => c.def.id === 'sleepHours' && c.delta < 0)).toBe(true);
    for (const change of changes) expect(change.delta).toBeCloseTo(change.today - change.yesterday, 9);
  });

  it('builds the plan only from tasks that already exist', () => {
    const m = mission('iss');
    m.actions.setScenario('sans');
    m.advance(30 * 60);
    const system = Object.values(m.store.evaluation.systems).find((s) => s.status === 'critical')!;
    m.actions.startIntervention(system.driver!.def.id, 'Follow the medical checklist with the Crew Medical Officer.', 2);
    const plan = planForToday(m.store.evaluation, m.store.interventions, m.store.medicalPlan, (def) => thresholdsFor(def, m.store.environment));
    const protocol = plan.find((item) => item.kind === 'protocol')!;
    const guidance = system.driver!.def.guidance.critical;
    expect(guidance.some((step) => protocol.text.endsWith(step))).toBe(true);
    expect(plan.some((item) => item.kind === 'verify')).toBe(true);
    expect(plan.filter((item) => item.kind === 'target').map((item) => item.indicatorId)).toEqual(['resistiveExercise', 'aerobicExercise']);
  });

  it('saves the answers as given and changes no status', () => {
    const m = mission('iss');
    const before = JSON.stringify(m.store.evaluation);
    m.store.recordCheckIn({ sleep: 'poor', mood: 'low', discomfort: true });
    expect(JSON.stringify(m.store.evaluation)).toBe(before);
    expect(m.store.checkIns[0]).toMatchObject({ sleep: 'poor', mood: 'low', discomfort: true });
    expect(m.store.missionLog[m.store.missionLog.length - 1].kind).toBe('check-in');
  });
});
