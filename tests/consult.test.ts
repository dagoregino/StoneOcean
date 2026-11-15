import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroundLink } from '../src/data/GroundLink';
import { HealthStore } from '../src/data/HealthStore';
import { ENVIRONMENTS } from '../src/domain/catalog/environments';
import {
  ACCELERATED_PLAYBACK_SEC,
  CONSULT_PHASES,
  consultLatency,
  consultPlayback,
  consultProgress,
  latencyLadder,
  PREPARING_SEC,
  phaseMissionTime,
  phaseSchedule,
  SENDING_SEC,
} from '../src/domain/consult';
import { WITHHELD_STEP } from '../src/domain/medicalPlan';
import type { EnvironmentId } from '../src/domain/types';

/** A store with a critical heart rate: the triage asks for the ground. */
const critical = (env: EnvironmentId = 'iss'): HealthStore => {
  const store = new HealthStore(env);
  store.ingest([{ indicatorId: 'heartRate', value: 150, t: 600, source: 'sensor' }], 600);
  return store;
};

describe('latency to Earth', () => {
  it('reuses the environment delay: light twice, plus relays and ground handling', () => {
    for (const env of Object.values(ENVIRONMENTS)) {
      const latency = consultLatency(env);
      expect(latency.oneWaySec).toBe(env.commsDelaySec);
      expect(latency.lightRoundTripSec).toBe(2 * env.commsDelaySec);
      expect(latency.roundTripSec).toBe(2 * env.commsDelaySec + env.linkHandlingSec);
    }
  });

  it('is almost immediate from the station, seconds from the Moon, tens of minutes in transit and about 44 min from Mars', () => {
    const rt = (id: EnvironmentId) => consultLatency(ENVIRONMENTS[id]).roundTripSec;
    expect(rt('iss')).toBeLessThan(5);
    expect(rt('lunar')).toBeGreaterThanOrEqual(5);
    expect(rt('lunar')).toBeLessThanOrEqual(14);
    expect(rt('transit')).toBeGreaterThan(rt('lunar'));
    expect(rt('transit')).toBeLessThan(rt('mars'));
    expect(rt('mars') / 60).toBeCloseTo(44, 0);
    expect(consultLatency(ENVIRONMENTS.iss).realtime).toBe(true);
    expect(consultLatency(ENVIRONMENTS.mars).realtime).toBe(false);
  });

  it('orders the environments nearest first for the EIMO ladder', () => {
    expect(latencyLadder().map((s) => s.id)).toEqual(['iss', 'lunar', 'transit', 'mars']);
  });
});

describe('demo playback', () => {
  it('plays short waits in real time and compresses long ones, saying by how much', () => {
    const moon = consultPlayback(consultLatency(ENVIRONMENTS.lunar));
    expect(moon).toMatchObject({ speedup: 1, accelerated: false });
    const mars = consultPlayback(consultLatency(ENVIRONMENTS.mars));
    expect(mars.accelerated).toBe(true);
    expect(mars.speedup).toBeCloseTo(2640 / ACCELERATED_PLAYBACK_SEC);
    expect(mars.totalSec).toBeCloseTo(PREPARING_SEC + SENDING_SEC + ACCELERATED_PLAYBACK_SEC);
  });

  it('walks through the phases in order, with the signal out and then back', () => {
    const latency = consultLatency(ENVIRONMENTS.mars);
    const playback = consultPlayback(latency);
    const schedule = phaseSchedule(latency, playback);
    expect(schedule.map((s) => s.phase)).toEqual([...CONSULT_PHASES]);
    for (let i = 1; i < schedule.length; i++) expect(schedule[i].atSec).toBeGreaterThan(schedule[i - 1].atSec);

    const at = (sec: number) => consultProgress(latency, playback, sec);
    expect(at(0.5).phase).toBe('preparing');
    expect(at(PREPARING_SEC + 0.5).phase).toBe('sending');
    const halfwayOut = PREPARING_SEC + SENDING_SEC + latency.oneWaySec / 2 / playback.speedup;
    expect(at(halfwayOut)).toMatchObject({ phase: 'en-route', inbound: null });
    expect(at(halfwayOut).outbound).toBeCloseTo(0.5);
    const atEarth = PREPARING_SEC + SENDING_SEC + (latency.oneWaySec + 1) / playback.speedup;
    expect(at(atEarth)).toMatchObject({ phase: 'awaiting', outbound: 1, inbound: null });
    const coming = at(schedule[4].atSec - 1);
    expect(coming.phase).toBe('awaiting');
    expect(coming.inbound).toBeGreaterThan(0.5);
    expect(at(schedule[4].atSec + 0.01)).toMatchObject({ phase: 'received', remainingSec: 0 });
  });

  it('dates history events on the link, not on the accelerated playback', () => {
    const latency = consultLatency(ENVIRONMENTS.mars);
    const received = phaseMissionTime(1000, latency, 'received');
    expect(received - 1000).toBeCloseTo(44, 0);
    expect(phaseMissionTime(1000, latency, 'awaiting') - 1000).toBeCloseTo(20, 0);
  });
});

describe('when to offer "Send to Flight Surgeon"', () => {
  it('not when everything is nominal or only drifting', () => {
    const store = new HealthStore('iss');
    store.ingest([{ indicatorId: 'heartRate', value: 64, t: 10, source: 'sensor' }], 10);
    expect(store.consultReason).toBeNull();
    expect(store.requestConsult(0)).toBeNull();
  });

  it('when the triage escalates to the ground', () => {
    const store = critical();
    expect(store.evaluation.triage.level).toBe('ground-consult');
    expect(store.consultReason?.kind).toBe('critical');
  });
});

describe('consultation in the store', () => {
  it('sends a summary, one at a time, records the history and gets an answer, without touching the evaluation', () => {
    const store = critical('mars');
    const before = JSON.stringify(store.evaluation);
    const seen: string[] = [];
    store.events.on('consults', (list) => seen.push(list[list.length - 1]?.status ?? 'none'));

    const consult = store.requestConsult(5_000)!;
    expect(consult.environment).toBe('mars');
    expect(consult.request.summary[0]).toMatch(/^Reason:/);
    expect(consult.request.findings[0].indicatorId).toBe('heartRate');
    expect(store.requestConsult(6_000)).toBeNull();

    for (const phase of ['sending', 'en-route', 'awaiting', 'received'] as const) store.advanceConsult(consult.id, phase);
    const done = store.consults[0];
    expect(done.events.map((e) => e.label)).toEqual(['Consultation requested', 'Signal sent', 'Awaiting Earth response', 'Earth response received']);
    expect(done.events[3].t - done.events[0].t).toBeCloseTo(44, 0);
    expect(seen).toEqual(['preparing', 'sending', 'en-route', 'awaiting', 'received']);
    expect(store.activeConsult).toBeNull();
    expect(JSON.stringify(store.evaluation)).toBe(before);

    // Phases never go back, and a second consultation can now be sent.
    store.advanceConsult(consult.id, 'en-route');
    expect(store.consults[0].status).toBe('received');
    expect(store.requestConsult(9_000)?.id).toBe(2);
  });

  it('answers with the protocol, never a withheld drug, and says where the answer comes from', () => {
    const store = critical('mars');
    const consult = store.requestConsult(0)!;
    store.advanceConsult(consult.id, 'received');
    const answer = store.consults[0].response!;
    expect(answer.lines[0]).toMatch(/Recheck Resting heart rate now/);
    expect(answer.lines.some((l) => /onboard protocol/.test(l))).toBe(true);
    expect(answer.lines[answer.lines.length - 1]).toMatch(/^Escalate again/);
    expect(answer.lines.join(' ')).not.toContain(WITHHELD_STEP);
    expect(answer.lines.join(' ')).not.toMatch(/medication|mg\b/i);
    expect(answer.note).toMatch(/Simulated reply/);
  });

  it('forgets consultations on reset', () => {
    const store = critical();
    store.requestConsult(0);
    store.reset(0);
    expect(store.consults).toEqual([]);
  });
});

describe('ground link', () => {
  afterEach(() => vi.useRealTimers());

  it('plays the phases on time and stops when the mission is reset', () => {
    vi.useFakeTimers();
    const timers = { now: () => Date.now(), setTimeout: (f: () => void, ms: number) => setTimeout(f, ms), clearTimeout: (h: unknown) => clearTimeout(h as number) };
    const store = critical('lunar');
    new GroundLink(store, timers);
    const consult = store.requestConsult(Date.now())!;
    const schedule = phaseSchedule(consult.latency, consult.playback);

    vi.advanceTimersByTime(schedule[2].atSec * 1000 + 1);
    expect(store.consults[0].status).toBe('en-route');
    vi.advanceTimersByTime((schedule[4].atSec - schedule[2].atSec) * 1000);
    expect(store.consults[0].status).toBe('received');
    expect(store.consults[0].response).not.toBeNull();

    const second = store.requestConsult(Date.now())!;
    expect(second.status).toBe('preparing');
    store.reset(0);
    vi.advanceTimersByTime(60_000);
    expect(store.consults).toEqual([]);
  });
});
