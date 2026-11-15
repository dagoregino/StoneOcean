import { isConsultActive, phaseSchedule, type FlightSurgeonConsult } from '../domain/consult';
import type { HealthStore } from './HealthStore';

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

  constructor(private readonly store: HealthStore, private readonly timers: LinkTimers = BROWSER_TIMERS) {
    store.events.on('consults', (consults) => this.sync(consults));
    this.sync(store.consults);
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
