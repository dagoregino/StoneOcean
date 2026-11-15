import { STATUS_GLYPH } from '../domain/status';
import { GUIDANCE_SOURCE_LABEL, GUIDANCE_TIER_TITLE, type GuidanceLine, type SymptomGuidance } from '../domain/symptomGuidance';
import type { IndicatorId } from '../domain/types';
import { openDialog } from './dialog';
import { h } from './dom';

export interface GuidanceActions {
  /** Opens the logging form of the first suggested self-check. */
  startGuidedCheck(indicatorIds: IndicatorId[]): void;
  /** Opens the onboard protocol (and its evidence) for the indicator that is flagged. */
  startProtocol(indicatorId: IndicatorId): void;
  /** Hands over to the existing "Send to Flight Surgeon" flow. Null when a consultation is already on its way. */
  sendToFlightSurgeon: (() => void) | null;
}

const line = ({ text, source }: GuidanceLine): HTMLElement => h('li', null, h('span', { class: 'guide-text' }, text), h('span', { class: 'guide-source', dataset: { source } }, GUIDANCE_SOURCE_LABEL[source]));

const step = (number: number, title: string, ...body: (HTMLElement | null)[]): HTMLElement =>
  h('section', { class: 'guide-step' }, h('h3', null, h('span', { class: 'guide-number', 'aria-hidden': 'true' }, String(number)), title), ...body);

/**
 * Shown the moment a discomfort report is saved. It answers "what should I do now?" before
 * anything else, in four steps, and says where each line comes from. Its color follows the
 * triage; its content comes from `buildSymptomGuidance`, never from this file.
 */
export function openSymptomGuidance(guidance: SymptomGuidance, actions: GuidanceActions): void {
  const { tier, status } = guidance;
  const close = (then?: () => void): void => {
    dialog.close();
    then?.();
  };
  const checks = guidance.selfChecks;
  const surgeon = guidance.flightSurgeon;

  const buttons: HTMLElement[] = [];
  // On board first: the crew acts before Earth can answer.
  if (guidance.protocolIndicator) {
    const id = guidance.protocolIndicator;
    buttons.push(h('button', { class: 'button button-primary', type: 'button', onclick: () => close(() => actions.startProtocol(id)) }, 'Start onboard protocol'));
  }
  if (checks.length > 0) {
    buttons.push(
      h(
        'button',
        { class: guidance.protocolIndicator ? 'button button-quiet' : 'button button-primary', type: 'button', onclick: () => close(() => actions.startGuidedCheck(checks.map((c) => c.indicatorId))) },
        'Start guided check',
      ),
    );
  }
  if (surgeon && actions.sendToFlightSurgeon) {
    const send = actions.sendToFlightSurgeon;
    buttons.push(h('button', { class: 'button button-quiet', type: 'button', onclick: () => close(send) }, 'Send report to Flight Surgeon'));
  }
  buttons.push(h('button', { class: 'button button-quiet', type: 'button', onclick: () => close() }, 'Close'));

  const dialog = openDialog(
    GUIDANCE_TIER_TITLE[tier],
    [
      h(
        'div',
        { class: 'guide-banner', dataset: { status } },
        h('span', { class: 'status-glyph', 'aria-hidden': 'true' }, STATUS_GLYPH[status]),
        h('div', null, h('p', { class: 'guide-banner-title' }, 'Report saved to the mission log'), h('ul', { class: 'guide-reported' }, ...guidance.reported.map((text) => h('li', null, text)))),
      ),
      h('h2', { class: 'guide-question' }, 'What should I do now?'),
      step(1, 'Immediate action', h('ul', { class: 'guide-lines' }, ...guidance.immediate.map(line))),
      step(
        2,
        'Recommended self-check',
        checks.length > 0
          ? h('ul', { class: 'guide-lines' }, ...checks.map((c) => h('li', null, h('span', { class: 'guide-text' }, h('strong', null, c.name), c.due ? ' · due now' : '', h('span', { class: 'guide-how' }, c.howToMeasure)), h('span', { class: 'guide-source', dataset: { source: 'self-check' } }, GUIDANCE_SOURCE_LABEL['self-check']))))
          : h('p', { class: 'guide-none' }, guidance.selfCheckNote),
      ),
      step(3, 'What to monitor', h('ul', { class: 'guide-lines' }, ...guidance.monitor.map(line))),
      step(
        4,
        'When to escalate',
        h('ul', { class: 'guide-lines' }, ...guidance.escalate.map(line)),
        surgeon ? h('p', { class: 'guide-surgeon' }, h('strong', null, `Flight surgeon: round trip ${surgeon.roundTrip}. `), surgeon.note) : null,
      ),
      h(
        'details',
        { class: 'guide-context' },
        h('summary', null, 'Mission context and what is not known'),
        h(
          'ul',
          { class: 'guide-lines' },
          ...guidance.missionRisks.map((risk) =>
            h(
              'li',
              null,
              h('span', { class: 'guide-text' }, h('a', { href: risk.url, target: '_blank', rel: 'noopener' }, risk.name), ` is a mission risk NASA’s Human Research Program tracks for the ${guidance.systemName.toLowerCase()} system. ${risk.note}`),
              h('span', { class: 'guide-source', dataset: { source: 'known-risk' } }, GUIDANCE_SOURCE_LABEL['known-risk']),
            ),
          ),
          line({ text: guidance.uncertainty, source: 'uncertainty' }),
        ),
      ),
      h('div', { class: 'guide-actions' }, ...buttons),
    ],
    { className: 'guide-dialog', wide: true },
  );
  dialog.element.dataset.tier = tier;
  (dialog.element.querySelector('.guide-actions .button') as HTMLElement | null)?.focus({ preventScroll: true });
}
