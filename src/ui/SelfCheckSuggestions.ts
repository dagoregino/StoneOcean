import { INDICATORS, INDICATOR_LIST } from '../domain/catalog/indicators';
import type { IndicatorId } from '../domain/types';
import { h, syncList } from './dom';

/**
 * Self-checks offered for the reported body system. Every box starts unticked: nothing is
 * added to the report unless the crew member confirms it, and a ticked box only lists the
 * self-check to log; it is not a finding.
 */
export class SelfCheckSuggestions {
  readonly element: HTMLFieldSetElement;
  private readonly list = h('div', { class: 'note-suggestion-list' });
  private readonly confirmedIds = new Set<IndicatorId>();
  private current: IndicatorId[] = [];

  constructor() {
    this.element = h(
      'fieldset',
      { class: 'symptom-field note-suggestions', hidden: true },
      h('legend', null, 'Suggested self-checks'),
      h('p', { class: 'reference' }, 'Self-checks for this body system. Tick one to add it to this report’s follow-up list, then log it yourself.'),
      this.list,
    );
  }

  /** Re-reads the system. Ticks are kept for suggestions that are still there. */
  update(systemId: string | null): void {
    const ids = systemId
      ? INDICATOR_LIST.filter((def) => def.acquisition === 'self-check' && def.systemId === systemId).map((def) => def.id)
      : [];
    this.current = ids;
    const idSet = new Set(ids);
    for (const id of this.confirmedIds) if (!idSet.has(id)) this.confirmedIds.delete(id);
    this.element.hidden = this.current.length === 0;
    syncList<IndicatorId>(
      this.list,
      this.current,
      (id) => id,
      (id) => {
        const boxId = `note-suggestion-${id}`;
        const box = h('input', { type: 'checkbox', id: boxId, onchange: () => (box.checked ? this.confirmedIds.add(id) : this.confirmedIds.delete(id)) });
        const def = INDICATORS[id];
        return h('label', { class: 'check note-suggestion', for: boxId }, box, h('span', { class: 'note-suggestion-text' }, h('strong', null, `Add self-check: ${def.name}`)));
      },
      (el, id) => {
        el.querySelector<HTMLInputElement>('input')!.checked = this.confirmedIds.has(id);
      },
    );
  }

  /** Only the self-checks the crew member ticked. */
  confirmed(): IndicatorId[] {
    return this.current.filter((id) => this.confirmedIds.has(id));
  }

  reset(): void {
    this.confirmedIds.clear();
    this.update(null);
  }
}