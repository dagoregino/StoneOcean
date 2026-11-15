import { isConsultActive, phaseSchedule, type FlightSurgeonConsult } from '../domain/consult';
import { LINK_AVAILABLE } from '../domain/link';
import type { HealthStore } from './HealthStore';

/** How long before the window opens the link is shown as coming back. */
const REACQUIRING_MS = 3000;

export interface LinkTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const BROWSER_TIMERS: LinkTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * The simulated radio link to the ground. It plays each consultation's phases on time
 * (preparing, sending, en route, awaiting, received) and tells the store; the store records
 * them in the mission history. The timing itself is the domain's (`phaseSchedule`): this class
 * only turns it into timers, so it can be replaced by a real link later.
 */
export class GroundLink {
  private readonly scheduled = new Map<number, unknown[]>();
  private lossTimers: unknown[] = [];

  constructor(private readonly store: HealthStore, private readonly timers: LinkTimers = BROWSER_TIMERS) {
    store.events.on('consults', (consults) => this.sync(consults));
    this.sync(store.consults);
  }

  /**
   * Loss of signal for `durationMs`: Earth is unreachable until the next contact window.
   * Consultations already on their way keep going; new ones are queued on board by the store.
   */
  beginLoss(durationMs: number): void {
    this.clearLoss();
    const nextContactAt = this.timers.now() + durationMs;
    this.store.setLinkWindow({ state: 'loss-of-signal', nextContactAt });
    this.lossTimers = [
      this.timers.setTimeout(() => this.store.setLinkWindow({ state: 'reacquiring', nextContactAt }), Math.max(0, durationMs - REACQUIRING_MS)),
      this.timers.setTimeout(() => this.restore(), durationMs),
    ];
  }

  /** Acquisition of signal: the link is back, and whatever waited on board is sent at once. */
  restore(): void {
    this.clearLoss();
    if (this.store.link.state === 'available') return;
    this.store.setLinkWindow(LINK_AVAILABLE);
    this.store.transmitQueued(this.timers.now());
  }

  private clearLoss(): void {
    this.lossTimers.forEach((handle) => this.timers.clearTimeout(handle));
    this.lossTimers = [];
  }

  private sync(consults: readonly FlightSurgeonConsult[]): void {
    const present = new Set(consults.map((c) => c.id));
    // A mission reset removes consultations: their pending phases must not fire.
    for (const [id, handles] of this.scheduled) {
      if (!present.has(id)) {
        handles.forEach((handle) => this.timers.clearTimeout(handle));
        this.scheduled.delete(id);
      }
    }
    for (const consult of consults) {
      if (!isConsultActive(consult) || this.scheduled.has(consult.id)) continue;
      const elapsedMs = this.timers.now() - consult.startedAtMs;
      const handles = phaseSchedule(consult.latency, consult.playback)
        .filter((step) => step.phase !== 'preparing')
        .map((step) =>
          this.timers.setTimeout(() => {
            this.store.advanceConsult(consult.id, step.phase);
            if (step.phase === 'received') this.scheduled.delete(consult.id);
          }, Math.max(0, step.atSec * 1000 - elapsedMs)),
        );
      this.scheduled.set(consult.id, handles);
    }
  }
}
