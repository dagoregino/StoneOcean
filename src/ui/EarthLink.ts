import type { HealthStore } from '../data/HealthStore';
import { consultLatency, consultProgress, formatRoundTrip, type FlightSurgeonConsult } from '../domain/consult';
import type { EnvironmentId } from '../domain/types';
import { h, setText } from './dom';

const SVG = 'http://www.w3.org/2000/svg';

/** Earth gets smaller as it gets farther: a visual cue only, not to scale. */
const EARTH_SIZE: Record<EnvironmentId, number> = { iss: 46, lunar: 32, transit: 22, mars: 16 };
/** Where the crew is drawn from: the middle of the 3D view, about chest height. */
const HABITAT = { x: 0.5, y: 0.42 };
/** How long the path stays after the answer arrives. */
const AFTERGLOW_MS = 2600;

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] => {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
};

/**
 * A small Earth in the corner of the 3D view, always there, smaller the farther the mission is,
 * with the round trip written under it. When a consultation is sent, a pulse leaves the crew,
 * travels to Earth at the pace of the real delay (or of the labeled demo playback) and comes
 * back with the answer. With reduced motion the path and the states stay, the pulse does not move.
 */
export class EarthLink {
  private readonly root: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly globe: HTMLElement;
  private readonly label = h('span', { class: 'earth-label' });
  private readonly sublabel = h('span', { class: 'earth-sublabel' });
  private readonly layer: SVGSVGElement;
  private readonly path: SVGPathElement;
  private readonly lit: SVGPathElement;
  private readonly pulse: SVGGElement;
  private readonly habitat: SVGCircleElement;
  private frame = 0;
  private length = 0;
  private hideAt = 0;
  private readonly reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');

  constructor(stage: HTMLElement, private readonly store: HealthStore) {
    this.layer = svg('svg', { class: 'signal-layer', 'aria-hidden': 'true', focusable: 'false' });
    this.path = svg('path', { class: 'signal-path' });
    this.lit = svg('path', { class: 'signal-lit' });
    this.habitat = svg('circle', { class: 'signal-habitat', r: '5' });
    this.pulse = svg('g', { class: 'signal-pulse' });
    this.pulse.append(svg('circle', { class: 'signal-pulse-glow', r: '9' }), svg('circle', { class: 'signal-pulse-core', r: '3.5' }));
    this.layer.append(this.path, this.lit, this.habitat, this.pulse);

    this.globe = h('span', { class: 'earth-globe', 'aria-hidden': 'true' });
    this.badge = h(
      'div',
      { class: 'earth-badge', role: 'img', title: 'HELIOS is a step toward EIMO (Earth-Independent Medical Operations): the farther from Earth, the more the crew must act alone first.' },
      this.globe,
      h('span', { class: 'earth-text' }, this.label, this.sublabel),
    );
    this.root = h('div', { class: 'earth-link', dataset: { state: 'idle' } });
    this.root.append(this.layer, this.badge);
    stage.append(this.root);

    new ResizeObserver(() => this.layout()).observe(stage);
    store.events.on('environment', () => this.renderEarth());
    store.events.on('consults', () => this.onConsults());
    this.reducedMotion?.addEventListener?.('change', () => this.draw());
    this.renderEarth();
    this.onConsults();
  }

  private renderEarth(): void {
    const env = this.store.environment;
    const latency = consultLatency(env);
    const size = EARTH_SIZE[env.id];
    this.globe.style.setProperty('--earth-size', `${size}px`);
    setText(this.label, 'Earth');
    this.badge.setAttribute('aria-label', `Earth. Round trip for a consultation from ${env.shortName}: ${formatRoundTrip(latency.roundTripSec)}.`);
    if (!this.store.activeConsult) setText(this.sublabel, `Round trip ${formatRoundTrip(latency.roundTripSec)}`);
    this.layout();
  }

  /** Recomputes the curve from the crew to Earth for the current size of the view. */
  private layout(): void {
    const box = this.root.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const globe = this.globe.getBoundingClientRect();
    const ex = globe.left + globe.width / 2 - box.left;
    const ey = globe.top + globe.height / 2 - box.top;
    const hx = box.width * HABITAT.x;
    const hy = box.height * HABITAT.y;
    // A gentle arc above the straight line, like a signal leaving the habitat.
    const cx = (hx + ex) / 2 + box.width * 0.08;
    const cy = Math.min(hy, ey) - box.height * 0.18;
    this.layer.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    const d = `M ${hx.toFixed(1)} ${hy.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
    this.path.setAttribute('d', d);
    this.lit.setAttribute('d', d);
    this.habitat.setAttribute('cx', hx.toFixed(1));
    this.habitat.setAttribute('cy', hy.toFixed(1));
    this.length = this.path.getTotalLength?.() ?? 0;
    this.lit.style.strokeDasharray = `${this.length}`;
    this.draw();
  }

  private onConsults(): void {
    const consults = this.store.consults;
    const last = consults[consults.length - 1];
    if (last?.status === 'received' && this.root.dataset.state !== 'idle' && this.root.dataset.state !== 'received') {
      this.hideAt = performance.now() + AFTERGLOW_MS;
    }
    if (!last) this.hideAt = 0;
    this.draw();
  }

  /** One frame. Keeps animating while a consultation is in flight or its afterglow lasts. */
  private draw(): void {
    cancelAnimationFrame(this.frame);
    const consult = this.store.activeConsult;
    const last = this.store.consults[this.store.consults.length - 1];
    if (consult) {
      this.drawConsult(consult);
      this.frame = requestAnimationFrame(() => this.draw());
      return;
    }
    if (last?.status === 'received' && performance.now() < this.hideAt) {
      this.root.dataset.state = 'received';
      this.setLit(1);
      this.pulse.style.visibility = 'hidden';
      setText(this.sublabel, 'Answer received');
      this.frame = requestAnimationFrame(() => this.draw());
      return;
    }
    this.root.dataset.state = 'idle';
    this.pulse.style.visibility = 'hidden';
    this.setLit(0);
    setText(this.sublabel, `Round trip ${formatRoundTrip(consultLatency(this.store.environment).roundTripSec)}`);
  }

  private drawConsult(consult: FlightSurgeonConsult): void {
    const progress = consultProgress(consult.latency, consult.playback, (Date.now() - consult.startedAtMs) / 1000);
    const still = Boolean(this.reducedMotion?.matches);
    this.root.dataset.state = progress.phase;
    let at: number | null = null;
    if (progress.phase === 'preparing' || progress.phase === 'sending') {
      at = 0;
      this.setLit(0);
      setText(this.sublabel, 'Transmitting…');
    } else if (progress.phase === 'en-route') {
      at = progress.outbound;
      this.setLit(still ? 1 : progress.outbound);
      setText(this.sublabel, 'Signal en route');
    } else {
      // At Earth, then the answer travels back.
      at = progress.inbound === null ? null : 1 - progress.inbound;
      this.setLit(1);
      setText(this.sublabel, progress.inbound === null ? 'Flight surgeon reviewing' : 'Answer on its way');
    }
    if (still || at === null || this.length === 0) {
      this.pulse.style.visibility = 'hidden';
      return;
    }
    const point = this.path.getPointAtLength(this.length * at);
    this.pulse.style.visibility = 'visible';
    this.pulse.setAttribute('transform', `translate(${point.x.toFixed(1)} ${point.y.toFixed(1)})`);
  }

  private setLit(fraction: number): void {
    this.lit.style.strokeDashoffset = `${this.length * (1 - fraction)}`;
  }
}
