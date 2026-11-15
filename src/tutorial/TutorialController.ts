import { FINAL_STEP, TUTORIAL_STEPS, type StepCleanup, type TutorialStep } from './steps';
import { TutorialSpotlight } from './TutorialSpotlight';

/** About 4.5 s per step: six steps make the 30-second tour. */
export const STEP_MS = 4500;

export interface TutorialHost {
  /** Puts the monitoring console on screen: the tour starts there. */
  showMonitoring(): void;
  /** Called once the tour has closed, however it closed. */
  onEnd?(): void;
}

/**
 * Runs the interface tour: one step at a time, on a short timer the person can pause, step
 * back through or skip. Everything it starts (timers, listeners, a drawer it opened) is undone
 * when it ends. It drives no data and never starts Play the Mission.
 */
export class TutorialController {
  private spotlight: TutorialSpotlight | null = null;
  private index = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settle: ReturnType<typeof setTimeout> | null = null;
  /** The short wait between clicking a highlighted control and the next step. */
  private advance: ReturnType<typeof setTimeout> | null = null;
  private cleanup: StepCleanup | null = null;
  private paused = false;
  private remaining = STEP_MS;
  private startedAt = 0;
  private returnFocus: HTMLElement | null = null;
  private detachTargets: (() => void) | null = null;

  constructor(private readonly host: TutorialHost, private readonly steps: TutorialStep[] = TUTORIAL_STEPS) {}

  get active(): boolean {
    return this.spotlight !== null;
  }

  start(): void {
    if (this.active) return;
    this.returnFocus = document.activeElement as HTMLElement | null;
    this.host.showMonitoring();
    this.spotlight = new TutorialSpotlight({
      onBack: () => this.go(this.index - 1),
      // On the closing card the same button reads "Got it" and ends the tour.
      onNext: () => (this.index >= this.steps.length ? this.end() : this.go(this.index + 1)),
      onSkip: () => this.end(),
      onTogglePause: () => this.togglePause(),
    });
    document.addEventListener('keydown', this.onKey, true);
    this.go(0);
    this.spotlight.next.focus({ preventScroll: true });
  }

  /** Closes the tour from wherever it is: Skip, Esc, "Got it", or Play the Mission starting. */
  end(): void {
    if (!this.spotlight) return;
    this.leaveStep(false);
    this.clearTimers();
    document.removeEventListener('keydown', this.onKey, true);
    this.spotlight.destroy();
    this.spotlight = null;
    this.index = -1;
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.host.onEnd?.();
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !this.spotlight) return;
    // A dialog the person opened keeps its own Esc.
    if (document.querySelector('dialog[open]')) return;
    event.preventDefault();
    event.stopPropagation();
    this.end();
  };

  /** Moves to step `index`; one past the last step is the closing card. */
  private go(index: number, keep = false): void {
    const spotlight = this.spotlight;
    if (!spotlight || index < 0) return;
    this.leaveStep(keep);
    this.clearTimers();
    this.index = index;

    if (index >= this.steps.length) {
      spotlight.show({ ...FINAL_STEP }, { durationMs: 0, canGoBack: true, finalLabel: 'Got it' });
      this.watchClicks([], () => {});
      spotlight.next.focus({ preventScroll: true });
      return;
    }

    const step = this.steps[index];
    this.cleanup = step.enter?.() ?? null;
    spotlight.show(
      { target: step.target, title: step.title, description: step.description, position: step.position, progress: { step: index + 1, total: this.steps.length } },
      { durationMs: STEP_MS, canGoBack: index > 0 },
    );
    if (step.settleMs) this.settle = setTimeout(() => this.spotlight?.place(), step.settleMs);
    // Trying the highlighted control is the best way through: it moves the tour on.
    this.watchClicks(step.clickTargets(), () => {
      if (this.advance) clearTimeout(this.advance);
      this.advance = setTimeout(() => this.go(this.index + 1, true), 250);
    });
    this.remaining = STEP_MS;
    // Someone who paused is reading at their own pace: the tour stays paused until resumed.
    spotlight.setPaused(this.paused);
    if (!this.paused) this.schedule();
  }

  private leaveStep(keep: boolean): void {
    this.detachTargets?.();
    this.detachTargets = null;
    const cleanup = this.cleanup;
    this.cleanup = null;
    cleanup?.(keep);
  }

  /** Listens for a real click (not the end of a drag) on the highlighted controls. */
  private watchClicks(targets: Element[], onClick: () => void): void {
    let down: { x: number; y: number } | null = null;
    const pointerDown = (event: Event): void => {
      const e = event as PointerEvent;
      down = { x: e.clientX, y: e.clientY };
    };
    const click = (event: Event): void => {
      const e = event as MouseEvent;
      // Dragging to rotate the astronaut is not a click on it.
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      onClick();
    };
    for (const target of targets) {
      target.addEventListener('pointerdown', pointerDown);
      target.addEventListener('click', click);
    }
    this.detachTargets = () => {
      for (const target of targets) {
        target.removeEventListener('pointerdown', pointerDown);
        target.removeEventListener('click', click);
      }
    };
  }

  private schedule(): void {
    this.startedAt = Date.now();
    this.timer = setTimeout(() => this.go(this.index + 1), this.remaining);
  }

  private togglePause(): void {
    if (!this.spotlight || this.index >= this.steps.length) return;
    this.paused = !this.paused;
    this.spotlight.setPaused(this.paused);
    if (this.paused) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
    } else {
      this.schedule();
    }
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.settle) clearTimeout(this.settle);
    if (this.advance) clearTimeout(this.advance);
    this.timer = null;
    this.settle = null;
    this.advance = null;
  }
}
