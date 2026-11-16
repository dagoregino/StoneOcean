import './tutorial.css';
import { TutorialSpotlight } from './TutorialSpotlight';
import { markTutorialDone } from './TutorialPrompt';
import { FINAL_STEP, buildSteps, type TutorialStep } from './steps';

const STEP_MS = 4500;

export class TutorialController {
  private spotlight: TutorialSpotlight;
  private steps: TutorialStep[];
  private index = 0;
  private timer: number | null = null;
  private paused = false;
  private remaining = STEP_MS;
  private lastTick = 0;
  private cleanup: ((keep: boolean) => void) | null = null;
  private card: HTMLElement;
  private timerFill: HTMLElement;
  private stepCount: HTMLElement;
  private titleEl: HTMLElement;
  private descEl: HTMLElement;
  private backBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private skipBtn: HTMLButtonElement;
  private pauseBtn: HTMLButtonElement;
  private keyHandler: (e: KeyboardEvent) => void;
  private clickHandlers: Array<{ el: Element; fn: EventListener }> = [];

  constructor(steps: TutorialStep[]) {
    this.steps = steps.length > 0 ? steps : [FINAL_STEP];
    this.spotlight = new TutorialSpotlight();

    // Build card
    this.card = document.createElement('div');
    this.card.className = 'tut-card';
    const head = document.createElement('div');
    head.className = 'tut-card-head';
    const avatar = document.createElement('div');
    avatar.className = 'tut-avatar';
    avatar.textContent = 'H';
    this.titleEl = document.createElement('div');
    this.titleEl.className = 'tut-title';
    this.stepCount = document.createElement('div');
    this.stepCount.className = 'tut-step-count';
    head.append(avatar, this.titleEl, this.stepCount);

    this.descEl = document.createElement('div');
    this.descEl.className = 'tut-desc';

    const timer = document.createElement('div');
    timer.className = 'tut-timer';
    this.timerFill = document.createElement('div');
    this.timerFill.className = 'tut-timer-fill';
    timer.append(this.timerFill);

    this.backBtn = document.createElement('button');
    this.backBtn.className = 'tut-btn';
    this.backBtn.textContent = 'Back';
    this.backBtn.addEventListener('click', () => this.back());

    this.nextBtn = document.createElement('button');
    this.nextBtn.className = 'tut-btn primary';
    this.nextBtn.textContent = 'Next';
    this.nextBtn.addEventListener('click', () => this.next());

    this.skipBtn = document.createElement('button');
    this.skipBtn.className = 'tut-btn';
    this.skipBtn.textContent = 'Skip';
    this.skipBtn.addEventListener('click', () => this.finish());

    this.pauseBtn = document.createElement('button');
    this.pauseBtn.className = 'tut-pause';
    this.pauseBtn.textContent = 'Pause';
    this.pauseBtn.addEventListener('click', () => this.togglePause());

    const actions = document.createElement('div');
    actions.className = 'tut-actions';
    const spacer = document.createElement('div');
    spacer.className = 'spacer';
    actions.append(this.backBtn, spacer, this.pauseBtn, this.nextBtn);

    this.card.append(head, this.descEl, timer, actions);
    // skip button at top-right
    const skipWrap = document.createElement('div');
    skipWrap.style.position = 'absolute';
    skipWrap.style.top = '8px';
    skipWrap.style.right = '10px';
    skipWrap.append(this.skipBtn);
    this.card.append(skipWrap);

    this.spotlight.setCard(this.card);

    this.keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't close if a dialog is open
        if (document.querySelector('dialog[open]')) return;
        this.finish();
      } else if (e.key === 'ArrowRight') {
        this.next();
      } else if (e.key === 'ArrowLeft') {
        this.back();
      }
    };
    document.addEventListener('keydown', this.keyHandler);
    this.goTo(0);
  }

  private goTo(i: number): void {
    if (i < 0) i = 0;
    if (i >= this.steps.length) { this.finish(); return; }
    this.leaveStep();
    this.index = i;
    const step = this.steps[i];
    this.stepCount.textContent = `${i + 1} / ${this.steps.length}`;
    this.titleEl.textContent = step.title;
    this.descEl.textContent = step.description;
    this.backBtn.disabled = i === 0;
    this.nextBtn.textContent = i === this.steps.length - 1 ? 'Got it' : 'Next';

    // enter
    const restore = step.enter?.();
    this.cleanup = typeof restore === 'function' ? restore : null;

    // target
    let els: Element[] = [];
    try {
      const t = step.target();
      if (Array.isArray(t)) els = t.filter(Boolean) as Element[];
      else if (t instanceof Element) els = [t];
      else if (t && typeof (t as any).getBoundingClientRect === 'function') els = []; // DOMRect, no element
    } catch {
      els = [];
    }
    this.spotlight.setTarget(els.length > 0 ? els : null);
    this.spotlight.announce(`${step.title}. ${step.description}`);

    // click targets
    this.attachClickTargets(step.clickTargets());

    // settle
    const settle = step.settleMs ?? 300;
    setTimeout(() => this.startTimer(), settle);
  }

  private attachClickTargets(targets: Element[]): void {
    this.detachClickTargets();
    for (const el of targets) {
      const fn = () => {
        setTimeout(() => this.next(), 250);
      };
      el.addEventListener('click', fn);
      this.clickHandlers.push({ el, fn });
    }
  }

  private detachClickTargets(): void {
    for (const { el, fn } of this.clickHandlers) el.removeEventListener('click', fn);
    this.clickHandlers = [];
  }

  private leaveStep(): void {
    this.detachClickTargets();
    this.stopTimer();
    if (this.cleanup) {
      try { this.cleanup(false); } catch { /* ignore */ }
      this.cleanup = null;
    }
  }

  private startTimer(): void {
    if (this.paused) return;
    this.remaining = STEP_MS;
    this.lastTick = Date.now();
    this.timerFill.style.width = '100%';
    this.timer = window.setInterval(() => {
      if (this.paused) return;
      const now = Date.now();
      this.remaining -= now - this.lastTick;
      this.lastTick = now;
      const pct = Math.max(0, (this.remaining / STEP_MS) * 100);
      this.timerFill.style.width = `${pct}%`;
      if (this.remaining <= 0) {
        this.stopTimer();
        this.next();
      }
    }, 100);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private togglePause(): void {
    this.paused = !this.paused;
    this.pauseBtn.textContent = this.paused ? 'Resume' : 'Pause';
    if (this.paused) {
      this.stopTimer();
    } else {
      this.lastTick = Date.now();
      this.startTimer();
    }
  }

  private next(): void {
    this.goTo(this.index + 1);
  }

  private back(): void {
    this.goTo(this.index - 1);
  }

  private finish(): void {
    this.leaveStep();
    this.spotlight.destroy();
    document.removeEventListener('keydown', this.keyHandler);
    markTutorialDone();
    // remove card (spotlight destroyed removes card)
  }

  destroy(): void {
    this.finish();
  }
}

// Re-export for convenience
export function startTutorial(): void {
  const steps = buildSteps();
  new TutorialController(steps);
}