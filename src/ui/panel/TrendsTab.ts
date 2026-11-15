import { formatRoundTrip } from '../../domain/consult';
import { INDICATOR_LIST, INDICATORS } from '../../domain/catalog/indicators';
import { SYSTEMS } from '../../domain/catalog/systems';
import { thresholdsFor } from '../../domain/engine/evaluate';
import { SYMPTOM_TYPE_LABEL } from '../../domain/symptoms';
import { SYSTEM_IDS, type Evaluation, type IndicatorEvaluation, type IndicatorId } from '../../domain/types';
import { h, setText } from '../dom';
import { formatRange, formatValue, formatWhen, statusBadge, updateBadge } from '../format';
import { TREND_WINDOWS, TrendChart, type TrendMilestone, type TrendSeries, type TrendWindow } from '../TrendChart';
import type { PanelContext, PanelTab } from './context';

const WINDOW_LABEL: Record<TrendWindow, string> = { '24h': '24 h', '7d': '7 days', '14d': '14 days', mission: 'Mission' };
const WINDOW_TITLE: Record<TrendWindow, string> = {
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '14d': 'Last 14 days: the length of the baseline calibration window',
  mission: 'Everything recorded so far',
};
const TABLE_ROWS = 8;

/** Remembered while the app is open, so the reader does not set it again on every visit to the tab. */
let lastWindow: TrendWindow = '7d';
let lastCompare: IndicatorId | '' = '';

function indicatorOptions(exclude: IndicatorId | null): HTMLElement[] {
  return SYSTEM_IDS.map((systemId) => {
    const options = INDICATOR_LIST.filter((def) => def.systemId === systemId && def.id !== exclude).map((def) => h('option', { value: def.id }, def.name));
    return options.length > 0 ? h('optgroup', { label: SYSTEMS[systemId].name }, ...options) : null;
  }).filter((group): group is HTMLOptGroupElement => group !== null);
}

/**
 * Tab 2: one indicator over time. The reader picks the window, can overlay a second
 * indicator to look for a relationship, and reads single points off the chart.
 */
export class TrendsTab implements PanelTab {
  readonly element = h('div', { class: 'tab-view' });
  private readonly chart = new TrendChart();
  private readonly indicatorSelect = h('select', { id: 'trend-indicator' });
  private readonly compareSelect = h('select', { id: 'trend-compare' });
  private readonly windowButtons: HTMLButtonElement[];
  private readonly badge = statusBadge('unknown');
  private readonly current = h('span', { class: 'trend-current' });
  private readonly reference = h('p', { class: 'trend-reference' });
  private readonly legend = h('div', { class: 'trend-legend' });
  private readonly tableHead = h('th');
  private readonly tableBody = h('tbody');
  private indicator: IndicatorId;
  private legendSignature = '';
  private tableSignature = '';

  constructor(private readonly context: PanelContext) {
    const { store, system } = context;
    const fallback = system ? (store.evaluation.systems[system].driver ?? store.evaluation.systems[system].indicators[0])?.def.id : undefined;
    this.indicator = context.indicator ?? fallback ?? 'heartRate';
    if (lastCompare === this.indicator) lastCompare = '';

    this.indicatorSelect.append(...indicatorOptions(null));
    this.indicatorSelect.value = this.indicator;
    this.indicatorSelect.addEventListener('change', () => context.openTrend(this.indicatorSelect.value as IndicatorId));
    this.fillCompare();
    this.compareSelect.addEventListener('change', () => {
      lastCompare = this.compareSelect.value as IndicatorId | '';
      this.update(store.evaluation);
    });

    this.windowButtons = TREND_WINDOWS.map((id) =>
      h(
        'button',
        {
          class: 'segment',
          type: 'button',
          title: WINDOW_TITLE[id],
          onclick: () => {
            lastWindow = id;
            this.update(store.evaluation);
          },
        },
        WINDOW_LABEL[id],
      ),
    );

    this.element.append(
      h(
        'section',
        { class: 'trend-controls' },
        h('div', { class: 'field' }, h('label', { for: 'trend-indicator' }, 'Indicator'), this.indicatorSelect),
        h('div', { class: 'field' }, h('label', { for: 'trend-compare' }, 'Compare with'), this.compareSelect),
      ),
      h(
        'section',
        { class: 'trend-main' },
        h('div', { class: 'trend-head' }, this.current, this.badge),
        h('div', { class: 'segmented trend-windows', role: 'group', 'aria-label': 'Time window' }, ...this.windowButtons),
        this.chart.element,
        this.legend,
        this.reference,
        h('button', { class: 'link-button', type: 'button', onclick: () => context.openProtocol(this.indicator) }, 'Protocol and evidence for this indicator →'),
      ),
      h(
        'details',
        { class: 'fold' },
        h('summary', null, 'Recent readings'),
        h('table', { class: 'readings-table' }, h('thead', null, h('tr', null, h('th', null, 'When'), this.tableHead, h('th', null, 'Source'))), this.tableBody),
      ),
    );
  }

  update(evaluation: Evaluation): void {
    const { store } = this.context;
    const primary = this.find(evaluation, this.indicator);
    const compareId = lastCompare && lastCompare !== this.indicator ? lastCompare : null;
    const compare = compareId ? this.find(evaluation, compareId) : null;
    const { def } = primary;

    this.windowButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(TREND_WINDOWS[i] === lastWindow)));
    setText(this.current, primary.latest ? `${formatValue(primary.latest.value, def)} ${def.unit}` : 'No reading yet');
    updateBadge(this.badge, primary.status);

    const milestones: TrendMilestone[] = [
      ...store.interventions
        .filter((i) => i.indicatorId === this.indicator || i.indicatorId === compareId)
        .map((i) => ({ t: i.startedAt, kind: 'treatment' as const, label: `Treatment (${INDICATORS[i.indicatorId].name}): ${i.stepText}` })),
      ...store.symptoms.map((s) => ({ t: s.t, kind: 'symptom' as const, label: `Reported: ${SYMPTOM_TYPE_LABEL[s.type].toLowerCase()}, ${s.intensity}/10 (${SYSTEMS[s.systemId].name.toLowerCase()})` })),
      // Flight surgeon consultations: the request and the answer, at their mission times.
      ...store.consults.flatMap((c) =>
        c.events.filter((e) => e.phase === 'preparing' || e.phase === 'received').map((e) => ({ t: e.t, kind: 'consult' as const, label: `${e.label} (round trip ${formatRoundTrip(c.latency.roundTripSec)})` })),
      ),
    ];
    this.chart.update({ primary: this.series(primary), compare: compare ? this.series(compare) : null, milestones, window: lastWindow, now: evaluation.missionTime });

    const { drift } = primary;
    if (drift) {
      const precise = (value: number): string => value.toFixed(def.decimals + 1);
      const z = drift.current ? ` Now ${drift.current.z >= 0 ? '+' : '−'}${Math.abs(drift.current.z).toFixed(2)} σ.` : '';
      setText(this.reference, `Judged against your own baseline of ${drift.baselineDays} days: ${precise(drift.baselineMean)} ± ${precise(drift.baselineSd)} ${def.unit}.${z}`);
    } else {
      const nominal = formatRange(thresholdsFor(def, store.environment).nominal, def);
      setText(this.reference, nominal === 'any' ? 'No limit set: this indicator is tracked only.' : `Judged against a fixed range: nominal ${nominal} ${def.unit}. No individual baseline for this indicator.`);
    }
    this.renderLegend(primary, compare, milestones);
    this.renderTable(primary);
  }

  dispose(): void {
    this.chart.dispose();
  }

  private find(evaluation: Evaluation, id: IndicatorId): IndicatorEvaluation {
    return evaluation.systems[INDICATORS[id].systemId].indicators.find((i) => i.def.id === id)!;
  }

  private series(indicator: IndicatorEvaluation): TrendSeries {
    const { def, drift } = indicator;
    const sensor = def.cadenceHours <= 2;
    return {
      def,
      readings: this.context.store.history(def.id),
      // Against the baseline, the bands are the single-value limits. They apply to a day's value.
      thresholds: drift ? drift.bands : thresholdsFor(def, this.context.store.environment),
      baseline: drift
        ? { mean: drift.baselineMean, sd: drift.baselineSd, usualRange: drift.usualRange, days: drift.baselineDays, until: drift.baselineUntil, ofDailyMeans: sensor }
        : undefined,
      judged: !drift || !sensor,
    };
  }

  private fillCompare(): void {
    this.compareSelect.replaceChildren(h('option', { value: '' }, 'Nothing'), ...indicatorOptions(this.indicator));
    this.compareSelect.value = lastCompare;
  }

  private renderLegend(primary: IndicatorEvaluation, compare: IndicatorEvaluation | null, milestones: TrendMilestone[]): void {
    const kinds = new Set(milestones.map((m) => m.kind));
    const signature = `${primary.def.id}|${compare?.def.id ?? ''}|${Boolean(primary.drift)}|${[...kinds].join()}`;
    if (signature === this.legendSignature) return;
    this.legendSignature = signature;
    const item = (key: string, text: string): HTMLElement => h('span', { class: 'trend-legend-item' }, h('span', { class: `trend-key trend-key-${key}`, 'aria-hidden': 'true' }), text);
    const unit = (i: IndicatorEvaluation): string => (i.def.unit ? ` (${i.def.unit})` : '');
    const items: (HTMLElement | null)[] = [
      item('primary', `${primary.def.name}${unit(primary)}`),
      compare ? item('compare', `${compare.def.name}${unit(compare)}, right axis`) : null,
      primary.drift ? item('band', 'Your usual range (95% of your days)') : item('zones', 'Nominal / caution / critical bands'),
      primary.drift ? item('limits', 'Alert limits') : null,
      kinds.has('treatment') ? item('treatment', 'Treatment') : null,
      kinds.has('symptom') ? item('symptom', 'Reported discomfort') : null,
      kinds.has('consult') ? item('consult', 'Flight surgeon consultation') : null,
    ];
    this.legend.replaceChildren(...items.filter((el): el is HTMLElement => el !== null));
  }

  private renderTable(indicator: IndicatorEvaluation): void {
    const { def } = indicator;
    const recent = this.context.store.history(def.id).slice(-TABLE_ROWS).reverse();
    const signature = `${def.id}|${recent.map((r) => `${r.t}:${r.value}`).join('|')}`;
    if (signature === this.tableSignature) return;
    this.tableSignature = signature;
    setText(this.tableHead, def.unit || 'Value');
    this.tableBody.replaceChildren(
      ...recent.map((r) =>
        h('tr', null, h('td', null, formatWhen(r.t)), h('td', null, formatValue(r.value, def)), h('td', null, r.source === 'manual' ? 'Logged by hand' : r.source === 'sensor' ? 'Sensor' : 'Simulated')),
      ),
    );
  }
}
