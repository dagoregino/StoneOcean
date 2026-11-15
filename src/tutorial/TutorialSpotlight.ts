import { h, setText } from '../ui/dom';
import { assistantAvatar } from './TutorialPrompt';

export type SpotlightPosition = 'top' | 'bottom' | 'left' | 'right' | 'auto';

/** What to light up: elements (their combined box) or a box computed by the caller. */
export type SpotlightTarget = () => Element[] | DOMRect | null;

export interface SpotlightContent {
  target: SpotlightTarget;
  title: string;
  description: string;
  position: SpotlightPosition;
  /** "2 / 6"; omitted on the closing card. */
  progress?: { step: number; total: number };
}

export interface SpotlightControls {
  onBack(): void;
  onNext(): void;
  onSkip(): void;
  onTogglePause(): void;
}

const PAD = 8;
const GAP = 16;
const EDGE = 10;

/** The union box of some elements, ignoring the ones that are not on screen. */
export function unionRect(elements: readonly Element[]): DOMRect | null {
  const boxes = elements.map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((r) => r.left));
  const top = Math.min(...boxes.map((r) => r.top));
  const right = Math.max(...boxes.map((r) => r.right));
  const bottom = Math.max(...boxes.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

/** The parts of a DOMRect the placement reads. */
export type RectLike = Pick<DOMRect, 'left' | 'top' | 'right' | 'bottom' | 'width' | 'height'>;

export interface Placement {
  x: number;
  y: number;
  side: Exclude<SpotlightPosition, 'auto'>;
  /** Where the arrow meets the card, along its edge, in px. */
  arrow: number;
}

/**
 * Where the card goes next to a target: on the preferred side if it fits, otherwise the side
 * with room, otherwise the bottom-right corner. Pure, so it can be tested without a browser.
 */
export function placeCard(target: RectLike | null, card: { width: number; height: number }, viewport: { width: number; height: number }, preferred: SpotlightPosition): Placement {
  const { width: W, height: H } = card;
  const corner: Placement = { x: viewport.width - W - 20, y: viewport.height - H - 20, side: 'top', arrow: -1 };
  if (!target) return corner;
  const cx = target.left + target.width / 2;
  const cy = target.top + target.height / 2;
  const options: Record<Placement['side'], { x: number; y: number; fits: boolean }> = {
    bottom: { x: cx - W / 2, y: target.bottom + GAP, fits: target.bottom + GAP + H <= viewport.height - EDGE },
    top: { x: cx - W / 2, y: target.top - GAP - H, fits: target.top - GAP - H >= EDGE },
    right: { x: target.right + GAP, y: cy - H / 2, fits: target.right + GAP + W <= viewport.width - EDGE },
    left: { x: target.left - GAP - W, y: cy - H / 2, fits: target.left - GAP - W >= EDGE },
  };
  const order: Placement['side'][] = preferred === 'auto' ? ['bottom', 'right', 'left', 'top'] : [preferred, ...(['bottom', 'right', 'left', 'top'] as const).filter((s) => s !== preferred)];
  const side = order.find((s) => options[s].fits);
  if (!side) return corner;
  const x = Math.max(EDGE, Math.min(viewport.width - W - EDGE, options[side].x));
  const y = Math.max(EDGE, Math.min(viewport.height - H - EDGE, options[side].y));
  const vertical = side === 'top' || side === 'bottom';
  const arrow = vertical ? Math.max(18, Math.min(W - 18, cx - x)) : Math.max(18, Math.min(H - 18, cy - y));
  return { x, y, side, arrow };
}

/**
 * The tour's spotlight: the page dims slightly, one target stays clear inside a soft cyan
 * outline, and the assistant's card points at it. The dim layer lets every click through, so
 * the highlighted control works as usual; only the card takes clicks of its own.
 */
export class TutorialSpotlight {
  readonly card: HTMLElement;
  readonly next: HTMLButtonElement;
  private readonly layer: HTMLElement;
  private readonly hole = h('div', { class: 'tut-hole', 'aria-hidden': 'true' });
  private readonly title = h('h2', { class: 'tut-title', id: 'tut-card-title' });
  private readonly text = h('p', { class: 'tut-text', id: 'tut-card-text' });
  private readonly counter = h('span', { class: 'tut-counter' });
  private readonly bar = h('span', { class: 'tut-timer-fill' });
  private readonly timer = h('span', { class: 'tut-timer', 'aria-hidden': 'true' }, this.bar);
  private readonly back: HTMLButtonElement;
  private readonly pause: HTMLButtonElement;
  private readonly skip: HTMLButtonElement;
  private content: SpotlightContent | null = null;
  private readonly onResize = (): void => this.place();

  constructor(controls: SpotlightControls) {
    this.back = h('button', { class: 'button button-quiet tut-btn', type: 'button', onclick: () => controls.onBack() }, 'Back');
    this.next = h('button', { class: 'button tut-btn tut-primary', type: 'button', onclick: () => controls.onNext() }, 'Next');
    this.skip = h('button', { class: 'tut-link', type: 'button', onclick: () => controls.onSkip() }, 'Skip');
    this.pause = h('button', { class: 'tut-pause', type: 'button', 'aria-label': 'Pause the tour', 'aria-pressed': 'false', onclick: () => controls.onTogglePause() });
    this.card = h(
      'section',
      { class: 'tut-card', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tut-card-title', 'aria-describedby': 'tut-card-text' },
      h('span', { class: 'tut-arrow', 'aria-hidden': 'true' }),
      h('header', { class: 'tut-card-head' }, assistantAvatar('sm'), h('span', { class: 'tut-card-name' }, 'HELIOS assistant'), this.counter, this.pause),
      // Each step is announced once, politely, when it changes.
      h('div', { class: 'tut-card-copy', 'aria-live': 'polite' }, this.title, this.text),
      this.timer,
      h('footer', { class: 'tut-card-foot' }, this.skip, h('span', { class: 'tut-spacer' }), this.back, this.next),
    );
    this.layer = h('div', { class: 'tut-layer' }, this.hole, this.card);
    document.body.append(this.layer);
    window.addEventListener('resize', this.onResize);
    // Any scroll (the page, a panel) moves the target: measure again. Events only, no loop.
    window.addEventListener('scroll', this.onResize, { capture: true, passive: true });
    requestAnimationFrame(() => this.layer.classList.add('is-on'));
  }

  /** Shows one step. `durationMs` drives the small progress line; 0 hides it. */
  show(content: SpotlightContent, options: { durationMs: number; canGoBack: boolean; finalLabel?: string }): void {
    this.content = content;
    setText(this.title, content.title);
    setText(this.text, content.description);
    this.counter.hidden = !content.progress;
    if (content.progress) {
      setText(this.counter, `${content.progress.step} / ${content.progress.total}`);
      this.counter.setAttribute('aria-label', `Step ${content.progress.step} of ${content.progress.total}`);
    }
    this.back.hidden = !options.canGoBack;
    this.skip.hidden = Boolean(options.finalLabel);
    setText(this.next, options.finalLabel ?? 'Next');
    this.pause.hidden = options.durationMs === 0;
    this.timer.hidden = options.durationMs === 0;
    this.restartTimer(options.durationMs);
    this.revealTarget();
    this.place();
  }

  /** On small screens the target can be below the fold: bring it into view first. */
  private revealTarget(): void {
    const found = this.content?.target();
    const first = Array.isArray(found) ? found[0] : null;
    if (!first) return;
    const box = first.getBoundingClientRect();
    if (box.top >= 0 && box.bottom <= window.innerHeight * 0.8) return;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    first.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  }

  /** Re-measures the target: after the page itself moved (a drawer opened, a tab changed). */
  place(): void {
    const content = this.content;
    if (!content) return;
    const found = content.target();
    const rect = found instanceof DOMRect ? found : found ? unionRect(found) : null;
    if (rect) {
      Object.assign(this.hole.style, { left: `${rect.left - PAD}px`, top: `${rect.top - PAD}px`, width: `${rect.width + PAD * 2}px`, height: `${rect.height + PAD * 2}px` });
      this.hole.classList.remove('is-empty');
    } else {
      this.hole.classList.add('is-empty');
    }
    const padded = rect ? new DOMRect(rect.left - PAD, rect.top - PAD, rect.width + PAD * 2, rect.height + PAD * 2) : null;
    const spot = placeCard(padded, { width: this.card.offsetWidth, height: this.card.offsetHeight }, { width: window.innerWidth, height: window.innerHeight }, content.position);
    this.card.style.left = `${Math.round(spot.x)}px`;
    this.card.style.top = `${Math.round(spot.y)}px`;
    this.card.dataset.side = spot.arrow < 0 ? 'none' : spot.side;
    this.card.style.setProperty('--arrow', `${Math.round(spot.arrow)}px`);
  }

  setPaused(paused: boolean): void {
    this.card.classList.toggle('is-paused', paused);
    this.pause.setAttribute('aria-pressed', String(paused));
    this.pause.setAttribute('aria-label', paused ? 'Resume the tour' : 'Pause the tour');
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('scroll', this.onResize, { capture: true });
    this.layer.classList.remove('is-on');
    this.layer.classList.add('is-leaving');
    setTimeout(() => this.layer.remove(), 220);
  }

  private restartTimer(durationMs: number): void {
    this.bar.classList.remove('is-running');
    this.card.classList.remove('is-paused');
    this.bar.style.setProperty('--duration', `${durationMs}ms`);
    // Restart the CSS transition: one reflow, then let it run to the end of the step.
    void this.bar.offsetWidth;
    if (durationMs > 0) this.bar.classList.add('is-running');
  }
}
