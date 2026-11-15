import { TOUR_STEPS, type MissionTourStep, type TourCard, type TourStage } from '../demo/MissionTour';
import type { SymptomReport } from '../domain/symptoms';
import { h, setText } from './dom';

type Control = 'pause' | 'resume' | 'skip';
const PLAYED_STEPS = TOUR_STEPS.filter((step) => step !== 'intro' && step !== 'ending');

/**
 * A subtitle for the guided demo: large, readable, one or two sentences on dark glass at
 * the bottom of the screen. It fades between lines and never covers the controls it sits above.
 */
export class MissionCaption {
  readonly element = h('div', { class: 'tour-caption', role: 'status', 'aria-live': 'polite', hidden: true });
  private readonly title = h('p', { class: 'tour-caption-title' });
  private readonly text = h('p', { class: 'tour-caption-text' });
  private swap: number | null = null;

  constructor() {
    this.element.append(this.title, this.text);
  }

  show(text: string, options: { title?: string; tone?: 'neutral' | 'alert' | 'ok' } = {}): void {
    const apply = (): void => {
      setText(this.title, options.title ?? '');
      this.title.hidden = !options.title;
      setText(this.text, text);
      this.element.dataset.tone = options.tone ?? 'neutral';
      this.element.hidden = false;
      this.element.classList.remove('is-leaving');
    };
    if (this.swap !== null) window.clearTimeout(this.swap);
    if (this.element.hidden) return apply();
    // Fade the old line out, then the new one in.
    this.element.classList.add('is-leaving');
    this.swap = window.setTimeout(apply, 180);
  }

  dispose(): void {
    if (this.swap !== null) window.clearTimeout(this.swap);
    this.element.remove();
  }
}

/**
 * Everything the guided demo draws: the opening and closing cards, the subtitles, the small
 * diagrams, the progress marks and the pause and skip buttons. It decides nothing; the tour
 * tells it what to show.
 */
export class MissionTourStage implements TourStage {
  private readonly root = h('div', { class: 'tour', 'aria-label': 'HELIOS mission demo' });
  private readonly subtitle = new MissionCaption();
  private readonly cardSlot = h('div', { class: 'tour-card-slot', 'aria-hidden': 'true' });
  private readonly marks = h('ol', { class: 'tour-marks', 'aria-hidden': 'true' }, ...PLAYED_STEPS.map(() => h('li')));
  private readonly pauseButton: HTMLButtonElement;
  private readonly bar: HTMLElement;
  private readonly timers: number[] = [];
  private control: (control: Control) => void = () => {};
  private settle: (() => void) | null = null;
  private paused = false;

  constructor(private readonly showGuidanceFor: (report: SymptomReport) => () => void) {
    this.pauseButton = h('button', { class: 'button button-quiet button-small', type: 'button', onclick: () => this.control(this.paused ? 'resume' : 'pause') }, 'Pause demo');
    this.bar = h(
      'div',
      { class: 'tour-bar', hidden: true },
      this.subtitle.element,
      h('div', { class: 'tour-controls' }, this.marks, this.pauseButton, h('button', { class: 'button button-quiet button-small', type: 'button', onclick: () => this.control('skip') }, 'Skip demo')),
    );
    this.root.append(this.cardSlot, this.bar);
    document.body.append(this.root);
    document.addEventListener('keydown', this.onKey);
  }

  intro(): Promise<'start' | 'skip'> {
    return this.choice(
      'tour-intro',
      [
        h('p', { class: 'tour-eyebrow' }, 'HELIOS Mission Demo'),
        h('h2', null, 'Follow one health episode from detection to onboard action and verification.'),
        h('p', { class: 'tour-note' }, 'About 90 seconds. It plays by itself; you can pause or skip at any time.'),
      ],
      [
        ['start', 'Start mission', true],
        ['skip', 'Skip', false],
      ],
      'skip',
    );
  }

  ending(): Promise<'explore' | 'restart'> {
    this.bar.hidden = true;
    this.card(null);
    return this.choice(
      'tour-ending',
      [
        h('p', { class: 'tour-loop-words' }, h('span', null, 'Detect'), h('span', null, 'Act'), h('span', null, 'Verify')),
        h('h2', null, 'HELIOS'),
        h('p', { class: 'tour-ending-line' }, 'When Earth cannot answer in time, the crew can still act.'),
        h('p', { class: 'tour-note' }, 'A step toward Earth-Independent Medical Operations.'),
      ],
      [
        ['explore', 'Explore HELIOS', true],
        ['restart', 'Restart mission', false],
      ],
      'explore',
    );
  }

  caption(text: string, options?: { title?: string; tone?: 'neutral' | 'alert' | 'ok' }): void {
    this.bar.hidden = false;
    this.subtitle.show(text, options);
  }

  progress(step: MissionTourStep): void {
    const index = PLAYED_STEPS.indexOf(step as (typeof PLAYED_STEPS)[number]);
    Array.from(this.marks.children).forEach((mark, i) => ((mark as HTMLElement).dataset.state = index < 0 ? '' : i < index ? 'done' : i === index ? 'current' : ''));
  }

  card(card: TourCard | null): void {
    if (!card) return void this.cardSlot.replaceChildren();
    const arrow = (): HTMLElement => h('span', { class: 'tour-arrow' }, '→');
    if (card.kind === 'loop') {
      const word = (id: 'detect' | 'act' | 'verify', label: string): HTMLElement => h('span', { class: 'tour-loop-step', dataset: { active: String(card.active === id) } }, label);
      this.cardSlot.replaceChildren(h('div', { class: 'tour-card tour-loop' }, word('detect', 'Detect'), arrow(), word('act', 'Act'), arrow(), word('verify', 'Verify')));
      return;
    }
    if (card.kind === 'delay') {
      const side = (place: { name: string; roundTrip: string }, far: boolean): HTMLElement =>
        h('div', { class: 'tour-delay-side', dataset: { far: String(far) } }, h('span', { class: 'tour-delay-name' }, place.name), h('strong', null, place.roundTrip), h('span', { class: 'tour-delay-bar' }), h('span', { class: 'tour-delay-label' }, 'round trip to Earth'));
      this.cardSlot.replaceChildren(h('div', { class: 'tour-card tour-delay' }, side(card.near, false), side(card.far, true)));
      return;
    }
    const cell = (label: string, value: string): HTMLElement => h('div', { class: 'tour-verify-cell' }, h('span', null, label), h('strong', null, value));
    this.cardSlot.replaceChildren(h('div', { class: 'tour-card tour-verify', dataset: { verified: String(card.verified) } }, cell('Before', card.before), arrow(), cell('Action', card.action), arrow(), cell('After', card.after)));
  }

  transition(from: string, to: string): void {
    const veil = h('div', { class: 'tour-transition' }, h('span', null, from), h('span', { class: 'tour-arrow' }, '→'), h('strong', null, to));
    this.root.append(veil);
    this.timers.push(window.setTimeout(() => veil.remove(), 1700));
  }

  showGuidance(report: SymptomReport): () => void {
    return this.showGuidanceFor(report);
  }

  onControl(handler: (control: Control) => void): void {
    this.control = handler;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    setText(this.pauseButton, paused ? 'Resume demo' : 'Pause demo');
    this.root.classList.toggle('is-paused', paused);
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKey);
    this.timers.forEach((timer) => window.clearTimeout(timer));
    this.subtitle.dispose();
    this.root.remove();
    // Anything still waiting on a card is released.
    this.settle?.();
    this.settle = null;
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.control('skip');
  };

  private choice<T extends string>(className: string, content: HTMLElement[], buttons: [T, string, boolean][], fallback: T): Promise<T> {
    return new Promise((resolve) => {
      const card = h('div', { class: `tour-screen ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': 'HELIOS mission demo' });
      const done = (answer: T): void => {
        this.settle = null;
        card.remove();
        resolve(answer);
      };
      this.settle = () => done(fallback);
      card.append(
        h(
          'div',
          { class: 'tour-screen-card' },
          ...content,
          h('div', { class: 'tour-screen-actions' }, ...buttons.map(([answer, label, primary]) => h('button', { class: primary ? 'button' : 'button button-quiet', type: 'button', onclick: () => done(answer) }, label))),
        ),
      );
      this.root.append(card);
      card.querySelector<HTMLElement>('.button')?.focus({ preventScroll: true });
    });
  }
}
