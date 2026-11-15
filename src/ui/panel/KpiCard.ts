import type { AppActions } from '../../app/actions';
import { SYSTEMS } from '../../domain/catalog/systems';
import type { IndicatorDef, IndicatorEvaluation, MissionMinutes, Reading } from '../../domain/types';
import { checkManualValue } from '../../domain/manualEntry';
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
  private readonly spark: Sparkline;
  private readonly range = h('span', { class: 'kpi-range' });

  constructor(private readonly def: IndicatorDef, actions: AppActions, showSystem: boolean, onOpen: () => void, onProtocol: () => void) {
    const help = helpToggle(
      `About ${def.name}`,
      h('p', null, h('strong', null, 'Why it matters. '), def.whyItMatters),
      h('p', null, h('strong', null, 'How to measure. '), def.howToMeasure),
      // The clinical detail is one step away, for whoever wants it.
      h('button', { class: 'link-button', type: 'button', onclick: onProtocol }, 'Protocol and evidence →'),
    );
    this.spark = new Sparkline(def.display);
    const selfCheck = def.acquisition === 'self-check';

    const input = h('input', {
      type: 'number',
      id: `log-${def.id}`,
      // Data-entry limits: what an instrument can really read. Not the chart range, and not a clinical threshold.
      min: String(def.plausible.min),
      max: String(def.plausible.max),
      step: String(def.decimals > 0 ? 1 / 10 ** def.decimals : 1),
      placeholder: def.unit || 'value',
      'aria-label': `Log ${def.name}${def.unit ? ` in ${def.unit}` : ''}`,
      'aria-describedby': `log-${def.id}-message`,
      oninput: () => clearMessage(),
    });
    const message = h('p', { class: 'kpi-log-message', id: `log-${def.id}-message`, role: 'alert' });
    const confirm = h('div', { class: 'kpi-log-confirm', hidden: true });
    const clearMessage = (): void => {
      message.textContent = '';
      confirm.hidden = true;
      input.removeAttribute('aria-invalid');
    };
    const save = (value: number): void => {
      // Saved exactly as entered: the rules engine decides what the value means.
      actions.logReading(def.id, value);
      input.value = '';
      clearMessage();
      form.hidden = true;
      logButton.setAttribute('aria-expanded', 'false');
      logButton.focus({ preventScroll: true });
    };
    const submit = (): void => {
      const check = checkManualValue(def, input.value);
      clearMessage();
      if (check.kind === 'ok') return save(check.value);
      message.textContent = check.message;
      if (check.kind === 'unusual') {
        // Possible, but far from where this indicator usually sits: ask once before saving.
        confirm.replaceChildren(
          h('button', { type: 'button', class: 'button button-small', onclick: () => save(check.value) }, 'Save anyway'),
          h('button', { type: 'button', class: 'button button-quiet button-small', onclick: () => {
            clearMessage();
            input.select();
            input.focus({ preventScroll: true });
          } }, 'Measure again'),
        );
        confirm.hidden = false;
        confirm.querySelector<HTMLElement>('button:last-child')?.focus({ preventScroll: true });
        return;
      }
      input.setAttribute('aria-invalid', 'true');
      input.focus({ preventScroll: true });
    };
    const form = h(
      'form',
      {
        class: 'kpi-log',
        hidden: true,
        // The messages are ours, shown next to the field: not the browser's generic bubble.
        noValidate: true,
        onsubmit: (event: Event) => {
          event.preventDefault();
          submit();
        },
      },
      h('div', { class: 'kpi-log-row' }, input, h('button', { type: 'submit', class: 'button button-small' }, 'Save')),
      message,
      confirm,
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
      { class: 'kpi' },
      h(
        'button',
        { class: 'kpi-main', type: 'button', title: 'Open the trend', onclick: onOpen },
        // Read top to bottom: where, what, how much, how it has moved, where it is heading.
        showSystem ? h('span', { class: 'kpi-system' }, SYSTEMS[def.systemId].name) : null,
        h('span', { class: 'kpi-label' }, def.name),
        h('span', { class: 'kpi-figure' }, this.value, h('span', { class: 'kpi-unit' }, def.unit)),
        h('span', { class: 'kpi-chart' }, this.spark.element, h('span', { class: 'kpi-chart-caption' }, h('span', null, 'Last 7 days'), this.range)),
        this.note,
      ),
      h('div', { class: 'kpi-foot' }, this.badge, this.dueChip, h('span', { class: 'kpi-spacer' }), selfCheck ? logButton : null, help.button),
      selfCheck ? form : null,
      help.content,
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
