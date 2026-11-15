import type { MissionMinutes, Reading } from '../domain/types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 100;
const HEIGHT = 40;
const PAD = 4;
const WINDOW_MIN = 7 * 1440;
const MAX_POINTS = 64;

const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

/**
 * The last 7 days of one indicator, drawn large enough to read at a glance: the trace, a soft
 * fill under it, and a dot on the latest value. No axes: the number beside it gives the value,
 * and `range` gives the span the trace covers. Decorative for assistive technology.
 *
 * Only the path data changes when new readings arrive; the elements are created once.
 */
export class Sparkline {
  readonly element: SVGSVGElement;
  private readonly area = el('path', { class: 'sparkline-area' });
  private readonly line = el('polyline', { class: 'sparkline-line' });
  /** A zero-length round-capped line: stays a round dot however the chart is stretched. */
  private readonly dot = el('line', { class: 'sparkline-dot' });
  private signature = '';
  /** Lowest and highest value drawn, for a caption; null while there is too little to draw. */
  range: { min: number; max: number } | null = null;

  constructor() {
    this.element = el('svg', { class: 'sparkline', viewBox: `0 0 ${WIDTH} ${HEIGHT}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    this.element.append(this.area, this.line, this.dot);
  }

  /** Returns true when the drawing changed. */
  update(readings: readonly Reading[], now: MissionMinutes): boolean {
    const last = readings[readings.length - 1];
    // Redrawn at most every 10 simulated minutes: the shape does not change faster than that.
    const signature = last ? `${readings.length}:${last.t}:${Math.floor(now / 10)}` : '';
    if (signature === this.signature) return false;
    this.signature = signature;

    const start = now - WINDOW_MIN;
    let first = 0;
    while (first < readings.length && readings[first].t < start) first++;
    const count = readings.length - first;
    this.element.toggleAttribute('data-empty', count < 2);
    if (count < 2) {
      this.line.setAttribute('points', '');
      this.area.setAttribute('d', '');
      this.dot.setAttribute('visibility', 'hidden');
      this.range = null;
      return true;
    }
    // Bucket means keep a dense sensor trace readable at this size.
    const size = Math.ceil(count / MAX_POINTS);
    const xs: number[] = [];
    const values: number[] = [];
    let min = Infinity;
    let max = -Infinity;
    for (let i = first; i < readings.length; i += size) {
      const end = Math.min(readings.length, i + size);
      let sum = 0;
      for (let k = i; k < end; k++) sum += readings[k].value;
      const value = sum / (end - i);
      xs.push(((readings[end - 1].t - start) / WINDOW_MIN) * (WIDTH - PAD * 2) + PAD);
      values.push(value);
      if (value < min) min = value;
      if (value > max) max = value;
    }
    const span = max - min || 1;
    let points = '';
    for (let i = 0; i < xs.length; i++) points += `${xs[i].toFixed(1)},${(HEIGHT - PAD - ((values[i] - min) / span) * (HEIGHT - PAD * 2)).toFixed(1)} `;
    const lastX = xs[xs.length - 1].toFixed(1);
    const lastY = (HEIGHT - PAD - ((values[values.length - 1] - min) / span) * (HEIGHT - PAD * 2)).toFixed(1);
    this.line.setAttribute('points', points);
    this.area.setAttribute('d', `M${xs[0].toFixed(1)},${HEIGHT} L${points.trim().replace(/ /g, ' L')} L${lastX},${HEIGHT} Z`);
    for (const [key, value] of [['x1', lastX], ['x2', lastX], ['y1', lastY], ['y2', lastY]] as const) this.dot.setAttribute(key, value);
    this.dot.setAttribute('visibility', 'visible');
    this.range = { min, max };
    return true;
  }
}
