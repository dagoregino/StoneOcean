import { INDICATORS } from '../../domain/catalog/indicators';
import { INDICATOR_RULES } from '../../domain/evidence/indicatorRules';
import { severity } from '../../domain/status';
import type { Evaluation, IndicatorEvaluation, IndicatorId } from '../../domain/types';
import { h } from '../dom';
import type { PanelContext, PanelTab } from './context';
import { ProtocolCard } from './ProtocolCard';

/**
 * Tab 3: the clinical detail. Detect → Treat → Verify, authority levels, citations and the
 * class of evidence, only for what is selected: one indicator, or one body system. With
 * nothing selected it shows whatever currently needs attention.
 */
export class ProtocolTab implements PanelTab {
  readonly element = h('div', { class: 'tab-view' });
  private readonly list = h('div', { class: 'protocol-list' });
  private readonly scope = h('p', { class: 'protocol-scope' });
  private readonly cards = new Map<IndicatorId, ProtocolCard>();

  constructor(private readonly context: PanelContext) {
    this.element.append(this.scope, this.list);
  }

  update(evaluation: Evaluation): void {
    const { store } = this.context;
    const { indicators, scope } = this.inScope(evaluation);
    this.scope.replaceChildren(...scope);

    // Cards are kept while their indicator stays in scope, so open sections stay open.
    const wanted = new Set(indicators.map((i) => i.def.id));
    for (const [id, card] of this.cards) {
      if (wanted.has(id)) continue;
      card.element.remove();
      card.dispose();
      this.cards.delete(id);
    }
    for (const indicator of indicators) {
      const id = indicator.def.id;
      let card = this.cards.get(id);
      if (!card) {
        card = new ProtocolCard(indicator.def, this.context.actions, () => this.context.openTrend(id), this.context.openResources);
        this.cards.set(id, card);
        this.list.append(card.element);
      }
      const { resources } = this.context;
      const readiness = resources.ready && !resources.error ? resources.readiness(INDICATOR_RULES[id].ruleId, store.medicalPlan) : null;
      card.update(indicator, { plan: store.medicalPlan, intervention: store.latestIntervention(id), readiness });
    }
  }

  dispose(): void {
    this.cards.forEach((card) => card.dispose());
  }

  private inScope(evaluation: Evaluation): { indicators: IndicatorEvaluation[]; scope: (HTMLElement | string)[] } {
    const { system, indicator } = this.context;
    if (indicator) {
      const def = INDICATORS[indicator];
      const found = evaluation.systems[def.systemId].indicators.filter((i) => i.def.id === indicator);
      const name = evaluation.systems[def.systemId].def.name.toLowerCase();
      return {
        indicators: found,
        scope: [`Showing ${def.name}. `, h('button', { class: 'link-button', type: 'button', onclick: () => this.context.openSystem(def.systemId) }, `Show the whole ${name} system`)],
      };
    }
    if (system) return { indicators: evaluation.systems[system].indicators, scope: [`Every indicator of the ${evaluation.systems[system].def.name.toLowerCase()} system.`] };
    const flagged = Object.values(evaluation.systems)
      .flatMap((s) => s.indicators)
      .filter((i) => severity(i.status) >= severity('caution'))
      .sort((a, b) => severity(b.status) - severity(a.status));
    return {
      indicators: flagged,
      scope: [flagged.length > 0 ? 'Indicators that need attention now. Select a body system to see the rest.' : 'Nothing needs attention. Select a body system, or open an indicator from the overview, to see its protocol and evidence.'],
    };
  }
}
