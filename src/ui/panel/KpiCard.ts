import type { AppActions } from '../../app/actions';
import { SYSTEMS } from '../../domain/catalog/systems';
import type { IndicatorDef, IndicatorEvaluation, MissionMinutes, Reading } from '../../domain/types';
import { h, setText } from '../dom';
import { formatTrend, formatValue, statusBadge, updateBadge } from '../format';
import { Sparkline } from '../Sparkline';
import { helpToggle } from './help';

/**
 * One indicator at a glance: the value, its unit, its status and the shape of the last
 * week. Opening it leads to the trend; explanations and the logging form stay folded away.
 */
export class KpiCard {
  readonly element: HTMLElement;
  private readonly value = h('span', { class: 'kpi-value' }, '–');
  private readonly badge = statusBadge('unknown');
  private readonly note = h('span', { class: 'kpi-note' });
  private readonly dueChip = h('span', { class: 'chip chip-due', hidden: true }, 'Check due');
  private readonly spark = new Sparkline();
  private readonly range = h('span', { class: 'kpi-range' });

  constructor(private readonly def: IndicatorDef, actions: AppActions, showSystem: boolean, onOpen: () => void, onProtocol: () => void, compact = false) {
    const help = helpToggle(
      `About ${def.name}`,
      h('p', null, h('strong', null, 'Why it matters. '), def.whyItMatters),
      h('p', null, h('strong', null, 'How to measure. '), def.howToMeasure),
      // The clinical detail is one step away, for whoever wants it.
      h('button', { class: 'link-button', type: 'button', onclick: onProtocol }, 'Protocol and evidence →'),
    );
    const selfCheck = def.acquisition === 'self-check';

    const input = h('input', {
      type: 'number',
      id: `log-${def.id}`,
      min: String(def.display.min),
      max: String(def.display.max),
      step: String(def.decimals > 0 ? 1 / 10 ** def.decimals : 1),
      placeholder: def.unit || 'value',
      required: true,
      'aria-label': `Log ${def.name}${def.unit ? ` in ${def.unit}` : ''}`,
    });
    const form = h(
      'form',
      {
        class: 'kpi-log',
        hidden: true,
        onsubmit: (event: Event) => {
          event.preventDefault();
          const value = Number(input.value);
          if (input.value === '' || !Number.isFinite(value)) return;
          actions.logReading(def.id, Math.min(def.display.max, Math.max(def.display.min, value)));
          input.value = '';
          form.hidden = true;
          logButton.setAttribute('aria-expanded', 'false');
        },
      },
      input,
      h('button', { type: 'submit', class: 'button button-small' }, 'Save'),
    );
    const logButton = h(
      'button',
      {
        class: 'button button-quiet button-small',
        type: 'button',
        'aria-expanded': 'false',
        onclick: () => {
          form.hidden = !form.hidden;
          logButton.setAttribute('aria-expanded', String(!form.hidden));
          if (!form.hidden) input.focus();
        },
      },
      'Log',
    );

    this.element = h(
      'article',
      { class: compact ? 'kpi is-compact' : 'kpi' },
      h(
        'button',
        {
          class: 'kpi-main',
          type: 'button',
          title: 'Open the trend',
          'aria-label': compact ? `${def.name}: open its 7-day trend` : 'Open the trend',
          onclick: onOpen,
        },
        // Read top to bottom: where, what, how much, how it has moved, where it is heading.
        showSystem ? h('span', { class: 'kpi-system' }, SYSTEMS[def.systemId].name) : null,
        h('span', { class: 'kpi-label' }, def.name),
        h('span', { class: 'kpi-figure' }, this.value, h('span', { class: 'kpi-unit' }, def.unit)),
        compact ? null : h('span', { class: 'kpi-chart' }, this.spark.element, h('span', { class: 'kpi-chart-caption' }, h('span', null, 'Last 7 days'), this.range)),
        compact ? null : this.note,
      ),
      compact
        ? h('div', { class: 'kpi-foot' }, this.badge, this.dueChip)
        : h('div', { class: 'kpi-foot' }, this.badge, this.dueChip, h('span', { class: 'kpi-spacer' }), selfCheck ? logButton : null, help.button),
      compact ? null : selfCheck ? form : null,
      compact ? null : help.content,
    );
  }

  update(evaluation: IndicatorEvaluation, readings: readonly Reading[], now: MissionMinutes): void {
    const { def } = this;
    setText(this.value, evaluation.latest ? formatValue(evaluation.latest.value, def) : '–');
    updateBadge(this.badge, evaluation.status);
    this.element.dataset.status = evaluation.status;
    setText(this.note, evaluation.worsening ? `${formatTrend(evaluation)} · heading out of range` : formatTrend(evaluation));
    this.note.classList.toggle('is-worsening', evaluation.worsening);
    this.dueChip.hidden = !(evaluation.due && def.acquisition === 'self-check');
    if (this.spark.update(readings, now)) {
      const range = this.spark.range;
      setText(this.range, range ? `${formatValue(range.min, def)} – ${formatValue(range.max, def)}${def.unit ? ` ${def.unit}` : ''}` : 'Not enough readings yet');
    }
  }
}
