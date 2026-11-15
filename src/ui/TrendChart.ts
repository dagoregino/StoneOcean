import { classify } from '../domain/engine/evaluate';
import { STATUS_COLOR, STATUS_GLYPH, STATUS_LABEL } from '../domain/status';
import type { IndicatorDef, MissionMinutes, Range, Reading, Thresholds } from '../domain/types';
import { h } from './dom';
import { formatValue, formatWhen } from './format';

const MINUTES_PER_DAY = 1440;
const HEIGHT = 250;
const TOP = 26;
const BOTTOM = 34;
const LEFT = 46;
const RIGHT_PLAIN = 14;
const RIGHT_AXIS = 46;
const SPARSE_LIMIT = 28;
const MILESTONE_REACH_PX = 9;
/** Not status colors: those are reserved for status. */
const COMPARE_COLOR = '#38c6d9';
const SYMPTOM_COLOR = '#b48cff';

export const TREND_WINDOWS = ['24h', '7d', '14d', 'mission'] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];
const WINDOW_MINUTES: Record<Exclude<TrendWindow, 'mission'>, number> = { '24h': MINUTES_PER_DAY, '7d': 7 * MINUTES_PER_DAY, '14d': 14 * MINUTES_PER_DAY };

/** The person's own baseline, when the indicator is judged against it. */
export interface TrendBaseline {
  mean: number;
  sd: number;
  /** Where 95% of the person's days fall. */
  usualRange: Range;
  days: number;
  /** End of the calibration window. */
  until: MissionMinutes;
  /** True when the baseline is one of daily means and the chart shows single sensor readings. */
  ofDailyMeans: boolean;
}

export interface TrendSeries {
  def: IndicatorDef;
  readings: readonly Reading[];
  /** Status bands: fixed thresholds, or the single-value limits around the baseline. */
  thresholds: Thresholds;
  baseline?: TrendBaseline;
  /** False when single readings are not judged against the bands (a sensor against a daily baseline). */
  judged: boolean;
}

const MILESTONE_GLYPH: Record<TrendMilestone['kind'], string> = { treatment: '▼', symptom: '✚', consult: '◉' };

export interface TrendMilestone {
  t: MissionMinutes;
  kind: 'treatment' | 'symptom' | 'consult';
  label: string;
}

export interface TrendChartData {
  primary: TrendSeries;
  compare: TrendSeries | null;
  milestones: readonly TrendMilestone[];
  window: TrendWindow;
  now: MissionMinutes;
}

interface Scale {
  min: number;
  max: number;
}

const css = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Round tick values (1, 2, 2.5, 5 × 10ⁿ) covering a range. */
function niceTicks({ min, max }: Scale, target: number): number[] {
  const raw = (max - min) / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
}

const signed = (z: number): string => `${z >= 0 ? '+' : '−'}${Math.abs(z).toFixed(2)}`;

/**
 * Interactive time chart of one indicator, optionally with a second one overlaid on its
 * own axis. It shows the selected time window, the person's usual range when a baseline
 * exists (the status bands otherwise), and the moments something was done or reported.
 * Hovering, or the arrow keys, reads out one point: time, value and distance from baseline.
 */
export class TrendChart {
  readonly element: HTMLDivElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly tip: HTMLDivElement;
  private readonly observer: ResizeObserver;
  private data: TrendChartData | null = null;
  private visible: Reading[] = [];
  private visibleCompare: Reading[] = [];
  private start: MissionMinutes = 0;
  private yPrimary: Scale = { min: 0, max: 1 };
  private yCompare: Scale = { min: 0, max: 1 };
  private hovered = -1;
  private width = 0;

  constructor() {
    this.canvas = h('canvas', { class: 'trend-canvas', role: 'img', tabIndex: 0 });
    this.tip = h('div', { class: 'chart-tip trend-tip', hidden: true });
    this.element = h('div', { class: 'chart trend-chart' }, this.canvas, this.tip);
    this.canvas.addEventListener('pointermove', (e) => this.onPointer(e));
    this.canvas.addEventListener('pointerdown', (e) => this.onPointer(e));
    this.canvas.addEventListener('pointerleave', () => this.setHovered(-1));
    this.canvas.addEventListener('blur', () => this.setHovered(-1));
    this.canvas.addEventListener('keydown', (e) => this.onKey(e));
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.element);
  }

  update(data: TrendChartData): void {
    const changedSeries = this.data?.primary.def.id !== data.primary.def.id || this.data?.window !== data.window;
    const pinned = this.hovered >= 0 && !changedSeries ? this.visible[this.hovered] : undefined;
    this.data = data;
    this.layout();
    // Keep reading out the same point while new data streams in.
    this.hovered = pinned ? this.visible.findIndex((r) => r.t === pinned.t) : -1;
    this.describe();
    this.draw();
    this.showTip();
  }

  dispose(): void {
    this.observer.disconnect();
  }

  // ---------- Layout ----------

  private get right(): number {
    return this.data?.compare ? RIGHT_AXIS : RIGHT_PLAIN;
  }

  private layout(): void {
    const data = this.data;
    if (!data) return;
    const { primary, compare, now } = data;
    const first = primary.readings[0]?.t ?? now - MINUTES_PER_DAY;
    // "Mission" spans the recorded history: older readings are not kept in memory.
    this.start = data.window === 'mission' ? Math.min(first, now - MINUTES_PER_DAY) : now - WINDOW_MINUTES[data.window];
    const inWindow = (readings: readonly Reading[]): Reading[] => {
      const index = readings.findIndex((r) => r.t >= this.start);
      // One reading before the window keeps the line running to the left edge.
      return index < 0 ? [] : readings.slice(Math.max(0, index - 1));
    };
    this.visible = inWindow(primary.readings);
    this.visibleCompare = compare ? inWindow(compare.readings) : [];
    this.yPrimary = this.fit(primary, this.visible);
    if (compare) this.yCompare = this.fit(compare, this.visibleCompare);
  }

  /** Vertical range: the data, plus the reference it is read against, with a little air. */
  private fit(series: TrendSeries, readings: Reading[]): Scale {
    const { display } = series.def;
    const values = readings.map((r) => r.value);
    const reference = series.baseline
      ? [series.baseline.usualRange.min, series.baseline.usualRange.max, series.baseline.mean]
      : [series.thresholds.nominal.min, series.thresholds.nominal.max];
    for (const value of reference) if (Number.isFinite(value) && value > display.min && value < display.max) values.push(value);
    if (values.length === 0) return { ...display };
    let min = Math.min(...values);
    let max = Math.max(...values);
    const pad = Math.max((max - min) * 0.14, (display.max - display.min) * 0.02);
    min = Math.max(display.min, min - pad);
    max = Math.min(display.max, max + pad);
    return max > min ? { min, max } : { ...display };
  }

  private xOf(t: MissionMinutes): number {
    const span = (this.data?.now ?? 1) - this.start || 1;
    return LEFT + ((t - this.start) / span) * (this.width - LEFT - this.right);
  }

  private yOf(value: number, scale: Scale): number {
    const clamped = Math.min(scale.max, Math.max(scale.min, value));
    return TOP + (1 - (clamped - scale.min) / (scale.max - scale.min)) * (HEIGHT - TOP - BOTTOM);
  }

  private resize(): void {
    const width = Math.floor(this.element.clientWidth);
    if (width === this.width || width === 0) return;
    this.width = width;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(HEIGHT * dpr);
    this.canvas.style.height = `${HEIGHT}px`;
    this.draw();
    this.showTip();
  }

  // ---------- Reading out a point ----------

  private onPointer(event: PointerEvent): void {
    const x = event.clientX - this.canvas.getBoundingClientRect().left;
    let best = -1;
    let bestDistance = Infinity;
    this.visible.forEach((r, i) => {
      const d = Math.abs(this.xOf(r.t) - x);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    this.setHovered(best);
  }

  private onKey(event: KeyboardEvent): void {
    const last = this.visible.length - 1;
    if (last < 0) return;
    const current = this.hovered < 0 ? last + 1 : this.hovered;
    const next: Record<string, number> = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: last };
    if (event.key === 'Escape') this.setHovered(-1);
    else if (event.key in next) this.setHovered(Math.min(last, Math.max(0, next[event.key])));
    else return;
    event.preventDefault();
  }

  private setHovered(index: number): void {
    if (index === this.hovered) return;
    this.hovered = index;
    this.draw();
    this.showTip();
  }

  private showTip(): void {
    const data = this.data;
    const reading = this.visible[this.hovered];
    if (!data || !reading || this.width === 0) {
      this.tip.hidden = true;
      return;
    }
    const { primary, compare } = data;
    const { def, baseline } = primary;
    const lines: HTMLElement[] = [h('strong', null, `${formatValue(reading.value, def)} ${def.unit}`), h('span', null, formatWhen(reading.t))];
    if (baseline) {
      const z = (reading.value - baseline.mean) / baseline.sd;
      lines.push(h('span', { class: 'trend-tip-z' }, `z = ${signed(z)} σ`, h('small', null, baseline.ofDailyMeans ? ' vs. your baseline of daily means' : ' vs. your baseline')));
    }
    if (primary.judged) {
      const status = classify(reading.value, primary.thresholds);
      lines.push(h('span', { class: 'chart-tip-status' }, h('span', { class: 'status-glyph', dataset: { status } }, STATUS_GLYPH[status]), STATUS_LABEL[status]));
    }
    if (reading.source === 'manual') lines.push(h('span', null, 'Logged by hand'));
    if (compare) {
      const other = nearest(this.visibleCompare, reading.t);
      if (other) {
        lines.push(
          h('span', { class: 'trend-tip-compare' }, h('span', { class: 'trend-key', style: `background:${COMPARE_COLOR}` }), `${compare.def.name}: ${formatValue(other.value, compare.def)} ${compare.def.unit}`),
        );
      }
    }
    const x = this.xOf(reading.t);
    for (const milestone of data.milestones) {
      if (Math.abs(this.xOf(milestone.t) - x) > MILESTONE_REACH_PX) continue;
      lines.push(h('span', { class: 'trend-tip-milestone', dataset: { kind: milestone.kind } }, `${MILESTONE_GLYPH[milestone.kind]} ${milestone.label}`));
    }
    this.tip.replaceChildren(...lines);
    this.tip.hidden = false;
    // The readout hangs under the time axis, at the pointer: it never hides the data it describes.
    const tipWidth = this.tip.offsetWidth;
    const left = Math.min(this.width - tipWidth, Math.max(0, x - tipWidth / 2));
    this.tip.style.transform = `translate(${left}px, ${HEIGHT - 4}px)`;
  }

  private describe(): void {
    const data = this.data;
    if (!data) return;
    const { def, baseline } = data.primary;
    const latest = this.visible[this.visible.length - 1];
    const windowLabel = data.window === 'mission' ? 'whole recorded mission' : `last ${data.window === '24h' ? '24 hours' : data.window === '7d' ? '7 days' : '14 days'}`;
    const parts = [`${def.name}, ${windowLabel}.`];
    if (latest) parts.push(`Latest ${formatValue(latest.value, def)} ${def.unit}.`);
    else parts.push('No readings in this window.');
    if (baseline) parts.push(`Your baseline is ${baseline.mean.toFixed(def.decimals + 1)} plus or minus ${baseline.sd.toFixed(def.decimals + 1)} ${def.unit}.`);
    if (data.compare) parts.push(`Compared with ${data.compare.def.name}.`);
    parts.push('Use the left and right arrow keys to read single points.');
    this.canvas.setAttribute('aria-label', parts.join(' '));
  }

  // ---------- Drawing ----------

  private draw(): void {
    const ctx = this.canvas.getContext('2d');
    const data = this.data;
    if (!ctx || !data || this.width === 0) return;
    const dpr = this.canvas.width / this.width;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, HEIGHT);

    const surface = css('--surface');
    const muted = css('--muted');
    const grid = css('--grid');
    const seriesColor = css('--series');
    const x0 = LEFT;
    const x1 = this.width - this.right;
    const y0 = TOP;
    const y1 = HEIGHT - BOTTOM;
    const { primary, compare, now } = data;
    const scale = this.yPrimary;
    const y = (value: number): number => this.yOf(value, scale);
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

    const wash = (from: number, to: number, color: string, alpha: number): void => {
      const a = Math.max(scale.min, from);
      const b = Math.min(scale.max, to);
      if (!(b > a)) return;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.fillRect(x0, y(b), x1 - x0, y(a) - y(b));
      ctx.globalAlpha = 1;
    };
    const rule = (value: number, color: string, dash: number[]): void => {
      if (!Number.isFinite(value) || value <= scale.min || value >= scale.max) return;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(y(value)) + 0.5);
      ctx.lineTo(x1, Math.round(y(value)) + 0.5);
      ctx.stroke();
      ctx.restore();
    };

    const { nominal, caution } = primary.thresholds;
    if (primary.baseline) {
      // The person's usual range is the reference; the alert limits are thin lines around it.
      const { usualRange, mean, until, days } = primary.baseline;
      wash(usualRange.min, usualRange.max, seriesColor, 0.16);
      rule(mean, seriesColor, [5, 4]);
      for (const limit of [nominal.min, nominal.max]) rule(limit, STATUS_COLOR.caution, [2, 4]);
      for (const limit of [caution.min, caution.max]) rule(limit, STATUS_COLOR.critical, [2, 4]);
      // The days the baseline was learned from, as a bar over the plot.
      const from = Math.max(x0, this.xOf(until - days * MINUTES_PER_DAY));
      const to = Math.min(x1, this.xOf(until));
      if (to - from > 6) {
        ctx.fillStyle = seriesColor;
        ctx.globalAlpha = 0.55;
        ctx.fillRect(from, y0 - 9, to - from, 3);
        ctx.globalAlpha = 1;
        if (to - from > 96) {
          ctx.fillStyle = muted;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(`Baseline window · ${days} d`, from, y0 - 13);
        }
      }
    } else {
      wash(scale.min, caution.min, STATUS_COLOR.critical, 0.11);
      wash(caution.max, scale.max, STATUS_COLOR.critical, 0.11);
      wash(caution.min, nominal.min, STATUS_COLOR.caution, 0.11);
      wash(nominal.max, caution.max, STATUS_COLOR.caution, 0.11);
      wash(nominal.min, nominal.max, STATUS_COLOR.nominal, 0.11);
    }

    // Value axes: the primary on the left, the comparison on the right in its own color.
    ctx.textBaseline = 'middle';
    const label = (value: number, def: IndicatorDef): string => (Number.isInteger(value) ? String(value) : value.toFixed(Math.max(1, def.decimals)));
    ctx.textAlign = 'right';
    for (const tick of niceTicks(scale, 4)) {
      const ty = Math.round(y(tick)) + 0.5;
      ctx.fillStyle = grid;
      ctx.globalAlpha = 0.7;
      ctx.fillRect(x0, ty - 0.5, x1 - x0, 1);
      ctx.globalAlpha = 1;
      ctx.fillStyle = muted;
      ctx.fillText(label(tick, primary.def), x0 - 7, ty);
    }
    if (compare) {
      ctx.textAlign = 'left';
      ctx.fillStyle = COMPARE_COLOR;
      for (const tick of niceTicks(this.yCompare, 4)) ctx.fillText(label(tick, compare.def), x1 + 7, this.yOf(tick, this.yCompare));
    }

    this.drawTimeAxis(ctx, x0, x1, y1, grid, muted);

    if (this.visible.length === 0) {
      ctx.fillStyle = muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No readings in this window', (x0 + x1) / 2, (y0 + y1) / 2);
    }

    // Series, clipped to the plot.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0 - 6, x1 - x0 + 6, y1 - y0 + 12);
    ctx.clip();
    const trace = (readings: Reading[], s: Scale, color: string, width: number): void => {
      if (readings.length === 0) return;
      ctx.beginPath();
      readings.forEach((r, i) => {
        const px = this.xOf(r.t);
        const py = this.yOf(r.value, s);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    };
    const dot = (r: Reading, s: Scale, color: string, radius: number): void => {
      ctx.beginPath();
      ctx.arc(this.xOf(r.t), this.yOf(r.value, s), radius + 2, 0, Math.PI * 2);
      ctx.fillStyle = surface;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(this.xOf(r.t), this.yOf(r.value, s), radius, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    if (compare) trace(this.visibleCompare, this.yCompare, COMPARE_COLOR, 1.5);
    trace(this.visible, scale, seriesColor, 2);
    if (this.visible.length <= SPARSE_LIMIT) this.visible.forEach((r) => dot(r, scale, seriesColor, 3.5));
    else if (this.visible.length > 0) dot(this.visible[this.visible.length - 1], scale, seriesColor, 3.5);
    ctx.restore();

    // Milestones sit on the time axis, with a faint line up through the plot.
    for (const milestone of data.milestones) {
      if (milestone.t < this.start || milestone.t > now) continue;
      const mx = Math.round(this.xOf(milestone.t)) + 0.5;
      const color = milestone.kind === 'symptom' ? SYMPTOM_COLOR : milestone.kind === 'consult' ? css('--earth') : css('--text');
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.35;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(mx, y0);
      ctx.lineTo(mx, y1);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = surface;
      ctx.beginPath();
      ctx.arc(mx, y1, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath();
      if (milestone.kind === 'symptom') {
        // A cross: something was felt.
        ctx.rect(mx - 1.5, y1 - 5, 3, 10);
        ctx.rect(mx - 5, y1 - 1.5, 10, 3);
      } else if (milestone.kind === 'consult') {
        // A dot in a ring: a message to or from Earth.
        ctx.arc(mx, y1, 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.arc(mx, y1, 5.5, 0, Math.PI * 2);
        ctx.stroke();
        continue;
      } else {
        // A downward triangle: something was done.
        ctx.moveTo(mx - 5, y1 - 4);
        ctx.lineTo(mx + 5, y1 - 4);
        ctx.lineTo(mx, y1 + 5);
        ctx.closePath();
      }
      ctx.fill();
    }

    const hovered = this.visible[this.hovered];
    if (hovered) {
      const hx = Math.round(this.xOf(hovered.t)) + 0.5;
      ctx.fillStyle = css('--text-2');
      ctx.fillRect(hx - 0.5, y0, 1, y1 - y0);
      dot(hovered, scale, seriesColor, 5);
      const other = compare ? nearest(this.visibleCompare, hovered.t) : null;
      if (other) dot(other, this.yCompare, COMPARE_COLOR, 4);
    }
  }

  private drawTimeAxis(ctx: CanvasRenderingContext2D, x0: number, x1: number, y1: number, grid: string, muted: string): void {
    const now = this.data?.now ?? 0;
    const span = now - this.start;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const tick = (t: MissionMinutes, text: string): void => {
      const x = this.xOf(t);
      if (x < x0 + 16 || x > x1 - 12) return;
      ctx.fillStyle = grid;
      ctx.fillRect(Math.round(x) - 0.5, y1, 1, 4);
      ctx.fillStyle = muted;
      ctx.fillText(text, x, HEIGHT - 8);
    };
    ctx.fillStyle = grid;
    ctx.fillRect(x0, y1, x1 - x0, 1);
    if (span <= 2 * MINUTES_PER_DAY) {
      // Hours of the mission day.
      const step = span <= MINUTES_PER_DAY ? 240 : 480;
      for (let t = Math.ceil(this.start / step) * step; t <= now; t += step) {
        const minutes = ((t % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
        tick(t, `${String(Math.floor(minutes / 60)).padStart(2, '0')}:00`);
      }
      return;
    }
    const days = span / MINUTES_PER_DAY;
    // As many day labels as fit without touching.
    const step = Math.max(1, Math.ceil(days / Math.max(2, Math.floor((x1 - x0) / 62))));
    for (let day = Math.floor(now / MINUTES_PER_DAY); day * MINUTES_PER_DAY >= this.start; day -= step) tick(day * MINUTES_PER_DAY, `Day ${day + 1}`);
  }
}

/** The reading closest in time, or null when the series is empty. */
function nearest(readings: Reading[], t: MissionMinutes): Reading | null {
  let best: Reading | null = null;
  for (const r of readings) if (!best || Math.abs(r.t - t) < Math.abs(best.t - t)) best = r;
  return best;
}
