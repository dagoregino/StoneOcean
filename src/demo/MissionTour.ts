import type { AppActions } from '../app/actions';
import type { HealthStore } from '../data/HealthStore';
import { ENVIRONMENTS } from '../domain/catalog/environments';
import { consultLatency, formatRoundTrip } from '../domain/consult';
import { ruleById } from '../domain/evidence/catalog';
import { INDICATOR_RULES } from '../domain/evidence/indicatorRules';
import { severity } from '../domain/status';
import type { SymptomReport } from '../domain/symptoms';
import type { EnvironmentId, SystemEvaluation } from '../domain/types';

/**
 * "Play the Mission": a guided run of one health episode, from detection to onboard action
 * and verification, for someone who has never seen HELIOS.
 *
 * The tour is a conductor and nothing else. Every change on screen is made by calling the
 * same actions and store methods the crew member uses; it holds no clinical logic, sets no
 * status and writes no reading of its own. Mission time is advanced in fixed steps with the
 * clock stopped, and the simulator is reseeded at the start, so the same run plays the same
 * way every time: it can be recorded.
 */

export const TOUR_STEPS = ['intro', 'astronaut', 'scan', 'alert', 'symptom', 'guidance', 'stationConsult', 'mars', 'marsConsult', 'action', 'verify', 'ending'] as const;
export type MissionTourStep = (typeof TOUR_STEPS)[number];

/** What the tour needs drawn. Implemented by the UI; faked in tests. */
export interface TourStage {
  /** The opening card. Resolves when the viewer starts or skips. */
  intro(): Promise<'start' | 'skip'>;
  /** One or two sentences at the bottom of the screen. */
  caption(text: string, options?: { title?: string; tone?: 'neutral' | 'alert' | 'ok' }): void;
  /** Which step is playing, for the progress marks. */
  progress(step: MissionTourStep): void;
  /** A small diagram above the scene; null removes it. */
  card(card: TourCard | null): void;
  /** A brief full-screen transition between two places. */
  transition(from: string, to: string): void;
  /** Shows "What should I do now?" for a report, without blocking the tour. Returns how to close it. */
  showGuidance(report: SymptomReport): () => void;
  /** The closing card. Resolves with what the viewer chose. */
  ending(): Promise<'explore' | 'restart'>;
  /** Pause, resume and skip buttons report here. */
  onControl(handler: (control: 'pause' | 'resume' | 'skip') => void): void;
  setPaused(paused: boolean): void;
  dispose(): void;
}

export type TourCard =
  | { kind: 'loop'; active: 'detect' | 'act' | 'verify' }
  | { kind: 'delay'; near: { name: string; roundTrip: string }; far: { name: string; roundTrip: string } }
  | { kind: 'verify'; before: string; action: string; after: string; verified: boolean };

export interface TourDeps {
  actions: AppActions;
  store: HealthStore;
  stage: TourStage;
  /** Stops the live simulator for the tour and returns how to put it back as it was. */
  suspendSimulator(): () => void;
  /** Timers, injectable so tests can run the whole tour instantly. */
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** The scenario the tour plays: an existing one, chosen because it is detected, treated and verified cleanly. */
const SCENARIO_ID = 'sans';
const NEAR: EnvironmentId = 'iss';
const FAR: EnvironmentId = 'mars';
/** Where the discomfort is pinned: the side of the head, in the body's frame. */
const PIN = { x: 0.07, y: 1.66, z: 0.06 };
const HOUR = 60;

class TourCancelled extends Error {}

export class MissionTour {
  private step: MissionTourStep = 'intro';
  private running = false;
  private paused = false;
  private cancelled = false;
  private timer: unknown = null;
  /** True while the opening or closing card is waiting for the viewer. */
  private awaitingChoice = false;
  private resumeWait: (() => void) | null = null;
  private rejectWait: ((error: Error) => void) | null = null;
  private closeGuidance: (() => void) | null = null;
  private restoreSimulator: (() => void) | null = null;
  private previousEnvironment: EnvironmentId = NEAR;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: TourDeps) {
    this.setTimer = deps.setTimeout ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.clearTimer = deps.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** True from the opening card until the tour has put everything back. */
  get active(): boolean {
    return this.running;
  }
  get currentStep(): MissionTourStep {
    return this.step;
  }

  /** Plays the tour. Resolves when it has ended, been skipped, or been disposed, with the app restored. */
  async start(): Promise<void> {
    if (this.running) return;
    const { stage, store } = this.deps;
    this.running = true;
    this.cancelled = false;
    this.paused = false;
    this.previousEnvironment = store.environment.id;
    stage.onControl((control) => {
      if (control === 'skip') this.skip();
      else if (control === 'pause') this.pause();
      else this.resume();
    });
    let again = false;
    try {
      this.enter('intro');
      if ((await this.choose(stage.intro())) === 'skip') return;
      this.guard();
      this.restoreSimulator = this.deps.suspendSimulator();
      await this.play();
      this.enter('ending');
      again = (await this.choose(stage.ending())) === 'restart';
    } catch (error) {
      if (!(error instanceof TourCancelled)) throw error;
    } finally {
      this.cleanup();
    }
    if (again) await this.start();
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.deps.stage.setPaused(true);
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.deps.stage.setPaused(false);
    this.resumeWait?.();
  }

  /** Stops the tour now and puts the app back as it was. */
  skip(): void {
    if (!this.running) return;
    this.cancelled = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.rejectWait?.(new TourCancelled());
    // Waiting on the opening or closing card: there is no timer to reject, so finish here.
    // Anywhere else the step in progress stops at its next wait and `start` cleans up.
    if (this.awaitingChoice) this.cleanup();
  }

  private async choose<T>(answer: Promise<T>): Promise<T> {
    this.awaitingChoice = true;
    try {
      return await answer;
    } finally {
      this.awaitingChoice = false;
    }
  }

  /** Stops timers and listeners and restores the app; safe to call at any time. */
  dispose(): void {
    this.skip();
  }

  // ---------- The episode ----------

  private async play(): Promise<void> {
    const { actions, store, stage } = this.deps;

    // A clean, known start: the same every time.
    actions.resetMission();
    actions.setScenario('nominal');
    store.setEnvironment(NEAR);
    store.select(null);
    store.setTwinView('astronaut');

    this.enter('astronaut');
    stage.caption('HELIOS continuously compares the crew member against their individual baseline.', { title: 'Station · low Earth orbit' });
    await this.wait(5000);

    this.enter('scan');
    stage.caption('The crew member’s body becomes the interface.');
    store.setTwinView('anatomy');
    await this.wait(5500);

    this.enter('alert');
    stage.card({ kind: 'loop', active: 'detect' });
    stage.caption('Days pass. HELIOS keeps watching for change.');
    actions.setScenario(SCENARIO_ID);
    let flagged = await this.advanceUntil(() => this.worstSystem(), 60);
    // Let the change settle to its final status, so the rest of the story does not shift under the captions.
    await this.advance(4);
    flagged = this.worstSystem() ?? flagged;
    if (!flagged?.driver) throw new TourCancelled();
    const system = flagged;
    const driver = flagged.driver;
    stage.caption(`${system.def.name}: ${driver.def.name.toLowerCase()} has moved out of range.`, { title: 'Change detected', tone: 'alert' });
    store.select(system.def.id);
    await this.wait(5000);

    this.enter('symptom');
    stage.caption('The astronaut can add subjective symptoms directly to the health twin.');
    actions.reportSymptom({ systemId: system.def.id, position: PIN, intensity: 6, type: 'dizziness', notes: 'Light-headed when turning the head.' });
    await this.wait(6000);

    this.enter('guidance');
    stage.card({ kind: 'loop', active: 'act' });
    stage.caption('HELIOS answers the question that matters first.', { title: 'What should I do now?' });
    const report = store.symptoms[store.symptoms.length - 1];
    if (report) this.closeGuidance = stage.showGuidance(report);
    await this.wait(7500);
    this.closeGuidance?.();
    this.closeGuidance = null;

    this.enter('stationConsult');
    stage.card(null);
    store.select(null);
    stage.caption('Near Earth, ground support is available almost immediately.', { title: `Send to Flight Surgeon · round trip ${this.roundTrip(NEAR)}` });
    actions.sendToFlightSurgeon();
    await this.wait(6500);

    this.enter('mars');
    stage.transition(ENVIRONMENTS[NEAR].shortName, ENVIRONMENTS[FAR].shortName);
    store.setEnvironment(FAR);
    stage.caption('But the same workflow changes far from Earth.', { title: 'Mars surface' });
    await this.wait(5500);

    this.enter('marsConsult');
    stage.card({ kind: 'delay', near: { name: ENVIRONMENTS[NEAR].shortName, roundTrip: this.roundTrip(NEAR) }, far: { name: ENVIRONMENTS[FAR].shortName, roundTrip: this.roundTrip(FAR) } });
    stage.caption('Waiting for Earth is no longer the first option.', { title: `Round-trip delay ≈ ${this.roundTrip(FAR)}`, tone: 'alert' });
    actions.sendToFlightSurgeon();
    await this.wait(6500);

    this.enter('action');
    stage.card({ kind: 'loop', active: 'act' });
    stage.caption('HELIOS supports onboard action while Earth is still responding.', { title: 'Start onboard protocol' });
    // The first step of the existing protocol that needs no drug authorization.
    const step = ruleById(INDICATOR_RULES[driver.def.id].ruleId)?.treat.find((s) => !s.requiresPreauthorization);
    if (step) actions.startIntervention(driver.def.id, step.text, step.authorityLevel);
    store.select(system.def.id);
    await this.wait(5500);

    this.enter('verify');
    stage.card({ kind: 'loop', active: 'verify' });
    stage.caption('Then HELIOS measures again, to see whether it worked.');
    const intervention = store.latestIntervention(driver.def.id);
    await this.advanceUntil(() => (intervention && intervention.outcome !== 'pending' ? intervention : null), 60);
    const shown = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : `${value.toFixed(driver.def.decimals)}${driver.def.unit ? ` ${driver.def.unit}` : ''}`);
    const verified = intervention?.outcome === 'verified';
    stage.card({ kind: 'verify', before: shown(intervention?.valueBefore), action: intervention?.stepText ?? '—', after: shown(intervention?.valueAfter), verified });
    stage.caption(verified ? `${driver.def.name} is back in range. The episode can be closed.` : `${driver.def.name} is still out of range: the protocol moves to the next authority level.`, {
      title: verified ? 'Verified' : 'Not verified',
      tone: verified ? 'ok' : 'alert',
    });
    await this.wait(6500);
  }

  // ---------- Helpers ----------

  private enter(step: MissionTourStep): void {
    this.guard();
    this.step = step;
    this.deps.stage.progress(step);
    // Skipped from the stage while the step was being announced: stop before it does anything.
    this.guard();
  }

  private guard(): void {
    if (this.cancelled) throw new TourCancelled();
  }

  private roundTrip(environment: EnvironmentId): string {
    return formatRoundTrip(consultLatency(ENVIRONMENTS[environment]).roundTripSec);
  }

  /** The body system that most needs attention now, according to the rules engine. */
  private worstSystem(): SystemEvaluation | null {
    const flagged = Object.values(this.deps.store.evaluation.systems)
      .filter((system) => severity(system.status) >= severity('caution'))
      .sort((a, b) => severity(b.status) - severity(a.status));
    return flagged[0]?.status === 'critical' ? flagged[0] : null;
  }

  /** Moves the mission forward two hours at a time, visibly, until `done` returns something or `maxHours` pass. */
  private async advanceUntil<T>(done: () => T | null, maxHours: number): Promise<T | null> {
    for (let hours = 0; hours < maxHours; hours += 2) {
      const result = done();
      if (result) return result;
      await this.advance(2);
    }
    return done();
  }

  private async advance(hours: number): Promise<void> {
    this.deps.actions.advanceMission(hours * HOUR);
    await this.wait(200);
  }

  /** Waits, honouring pause and skip. Every wait of the tour goes through this one timer. */
  private wait(ms: number): Promise<void> {
    this.guard();
    return new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        this.timer = null;
        this.resumeWait = null;
        this.rejectWait = null;
        // Paused when the time ran out: hold here until resumed.
        if (this.paused) {
          this.resumeWait = finish;
          this.rejectWait = reject;
          return;
        }
        resolve();
      };
      this.rejectWait = reject;
      this.timer = this.setTimer(finish, ms);
    });
  }

  private cleanup(): void {
    if (!this.running) return;
    const { stage, store } = this.deps;
    this.running = false;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.resumeWait = null;
    this.rejectWait = null;
    this.closeGuidance?.();
    this.closeGuidance = null;
    stage.dispose();
    // Leave the app as a fresh, healthy mission in the environment the viewer had chosen.
    store.setReportMode(false);
    store.select(null);
    this.restoreSimulator?.();
    this.restoreSimulator = null;
    store.setEnvironment(this.previousEnvironment);
    store.setTwinView('astronaut');
  }
}
