import { INDICATORS } from '../domain/catalog/indicators';
import { suggestSelfChecksFromNotes, type NoteSelfCheckSuggestion } from '../domain/noteSuggestions';
import type { IndicatorId } from '../domain/types';
import { h, setText, syncList } from './dom';

const quoted = (terms: readonly string[]): string => terms.map((t) => `“${t}”`).join(', ');

/**
 * Self-checks offered because the notes mention them (dizziness, vision problems…).
 * Every box starts unticked: nothing is added to the report unless the crew member confirms it,
 * and a ticked box only lists the self-check to log; it is not a finding.
 */
export class SelfCheckSuggestions {
  readonly element: HTMLFieldSetElement;
  private readonly list = h('div', { class: 'note-suggestion-list' });
  private readonly confirmedIds = new Set<IndicatorId>();
  private current: NoteSelfCheckSuggestion[] = [];

  constructor() {
    this.element = h(
      'fieldset',
      { class: 'symptom-field note-suggestions', hidden: true },
      h('legend', null, 'Suggested self-checks'),
      h('p', { class: 'reference' }, 'Your notes mention something a self-check measures. This is not a diagnosis. Tick one to add it to this report’s follow-up list, then log it yourself.'),
      this.list,
    );
  }

  /** Re-reads the notes. Ticks are kept for suggestions that are still there. */
  update(notes: string): void {
    this.current = suggestSelfChecksFromNotes(notes);
    const ids = new Set(this.current.map((s) => s.indicatorId));
    for (const id of this.confirmedIds) if (!ids.has(id)) this.confirmedIds.delete(id);
    this.element.hidden = this.current.length === 0;
    syncList<NoteSelfCheckSuggestion>(
      this.list,
      this.current,
      (s) => s.indicatorId,
      (s) => {
        const id = `note-suggestion-${s.indicatorId}`;
        const box = h('input', {
          type: 'checkbox',
          id,
          onchange: () => (box.checked ? this.confirmedIds.add(s.indicatorId) : this.confirmedIds.delete(s.indicatorId)),
        });
        const def = INDICATORS[s.indicatorId];
        return h(
          'label',
          { class: 'check note-suggestion', for: id },
          box,
          h('span', { class: 'note-suggestion-text' }, h('strong', null, `Add self-check: ${def.name}`), h('span', { class: 'note-suggestion-why' })),
        );
      },
      (el, s) => {
        el.querySelector<HTMLInputElement>('input')!.checked = this.confirmedIds.has(s.indicatorId);
        setText(el.querySelector('.note-suggestion-why')!, `Mentioned: ${quoted(s.matches)}`);
      },
    );
  }

  /** Only the self-checks the crew member ticked. */
  confirmed(): IndicatorId[] {
    return this.current.map((s) => s.indicatorId).filter((id) => this.confirmedIds.has(id));
  }

  reset(): void {
    this.confirmedIds.clear();
    this.update('');
  }
}
