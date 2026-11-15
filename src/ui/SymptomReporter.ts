import type { AppActions } from '../app/actions';
import type { HealthStore } from '../data/HealthStore';
import type { DictationController } from '../speech/DictationController';
import { SYSTEMS } from '../domain/catalog/systems';
import { SYMPTOM_INTENSITY, SYMPTOM_NOTES_MAX, SYMPTOM_TYPE_LABEL, SYMPTOM_TYPES, type SymptomDraft, type SymptomType } from '../domain/symptoms';
import type { SystemId } from '../domain/types';
import { h, setText } from './dom';
import { NotesDictation } from './NotesDictation';
import { SelfCheckSuggestions } from './SelfCheckSuggestions';

const HINT_REPORTING = 'Click the body where you feel it · drag still rotates · Esc to cancel';

/** Words for the 1–10 rating, so the number reads at a glance. Display only: the report keeps the number. */
function intensityWord(value: number): string {
  if (value <= 3) return 'Mild';
  if (value <= 6) return 'Moderate';
  if (value <= 8) return 'Severe';
  return 'Very severe';
}

/** A numbered field label: the form reads top to bottom as steps. */
const stepLabel = (step: number, text: string, forId: string | null, extra?: HTMLElement | string): HTMLElement =>
  h(
    forId ? 'label' : 'span',
    { class: 'field-label', for: forId ?? undefined },
    h('span', { class: 'field-step', 'aria-hidden': 'true' }, String(step)),
    h('span', { class: 'field-title' }, text),
    extra ?? null,
  );

/**
 * "Report discomfort": a toggle beside the 3D view and the small form that follows a click
 * on the body. It only talks to the store: the 3D view marks the spot, this fills in the rest.
 */
export class SymptomReporter {
  private readonly toggle: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly system = h('select', { id: 'symptom-system', name: 'system' });
  private readonly systemField: HTMLElement;
  private readonly intensity: HTMLInputElement;
  private readonly intensityValue = h('output', { class: 'symptom-intensity-value', for: 'symptom-intensity' });
  private readonly intensityWord = h('span', { class: 'symptom-intensity-word' });
  private readonly notesCount = h('span', { class: 'symptom-notes-count', 'aria-hidden': 'true' });
  private readonly notes: HTMLTextAreaElement;
  private readonly error = h('p', { class: 'symptom-error', role: 'alert' });
  private readonly suggestions = new SelfCheckSuggestions();
  private readonly dictation: NotesDictation | null = null;

  constructor(
    tools: HTMLElement,
    formHost: HTMLElement,
    private readonly hint: HTMLElement,
    private readonly store: HealthStore,
    private readonly actions: AppActions,
    /** Offline voice dictation for the notes; leave out to offer typing only. */
    dictationController?: DictationController,
  ) {
    this.toggle = h(
      'button',
      { class: 'tool-toggle', type: 'button', 'aria-pressed': 'false', onclick: () => store.setReportMode(!store.reportMode) },
      h('span', { class: 'tool-toggle-icon', 'aria-hidden': 'true' }, '✚'),
      'Report discomfort',
    );
    tools.append(this.toggle);

    this.intensity = h('input', {
      id: 'symptom-intensity',
      name: 'intensity',
      type: 'range',
      min: String(SYMPTOM_INTENSITY.min),
      max: String(SYMPTOM_INTENSITY.max),
      step: '1',
      oninput: () => this.showIntensity(),
    });
    this.notes = h('textarea', {
      id: 'symptom-notes',
      name: 'notes',
      rows: 3,
      maxLength: SYMPTOM_NOTES_MAX,
      placeholder: 'e.g. Started after exercise, worse when I turn my head…',
      oninput: () => this.onNotesChanged(),
    });
    if (dictationController) {
      this.dictation = new NotesDictation({
        controller: dictationController,
        notes: this.notes,
        maxLength: SYMPTOM_NOTES_MAX,
        onInserted: () => this.onNotesChanged(),
      });
    }
    this.systemField = h('div', { class: 'symptom-field' }, stepLabel(1, 'Body system', 'symptom-system'), this.system);

    this.form = h(
      'form',
      { class: 'symptom-form', hidden: true, 'aria-labelledby': 'symptom-form-title', onsubmit: (event: Event) => this.submit(event) },
      h(
        'header',
        { class: 'symptom-form-head' },
        h('div', null, h('h3', { id: 'symptom-form-title' }, 'Report discomfort'), h('p', { class: 'symptom-form-sub' }, 'Where it is, how strong, what it feels like. Under a minute.')),
        h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Cancel report', onclick: () => store.setReportMode(false) }, '×'),
      ),
      this.systemField,
      h(
        'div',
        { class: 'symptom-field' },
        h('div', { class: 'symptom-label-row' }, stepLabel(2, 'Intensity', 'symptom-intensity'), h('span', { class: 'symptom-intensity-readout' }, this.intensityValue, this.intensityWord)),
        this.intensity,
        h('div', { class: 'symptom-scale', 'aria-hidden': 'true' }, h('span', null, h('strong', null, '1'), ' Barely noticeable'), h('span', null, h('strong', null, '10'), ' Worst imaginable')),
      ),
      h(
        'fieldset',
        { class: 'symptom-field symptom-types' },
        h('legend', null, stepLabel(3, 'Type', null, h('span', { class: 'field-hint' }, 'Pick the closest'))),
        h(
          'div',
          { class: 'symptom-type-grid' },
          ...SYMPTOM_TYPES.map((type) =>
            h(
              'label',
              { class: 'choice' },
              h('input', { type: 'radio', name: 'type', value: type, onchange: () => (this.error.textContent = '') }),
              h('span', null, h('span', { class: 'choice-check', 'aria-hidden': 'true' }), SYMPTOM_TYPE_LABEL[type]),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'symptom-field' },
        h('div', { class: 'symptom-label-row' }, stepLabel(4, 'Notes', 'symptom-notes', h('span', { class: 'field-hint' }, 'Optional')), this.notesCount),
        this.notes,
      ),
      this.dictation
        ? h(
            'div',
            { class: 'symptom-field symptom-voice' },
            h('div', { class: 'symptom-label-row' }, stepLabel(5, 'Voice dictation', null, h('span', { class: 'field-hint' }, 'Instead of typing'))),
            this.dictation.button,
            this.dictation.element,
          )
        : null,
      this.suggestions.element,
      this.error,
      h(
        'footer',
        { class: 'symptom-actions' },
        h('p', { class: 'symptom-save-note' }, 'Saved to the mission log with a pin on the body. It never changes a status or an alert.'),
        h(
          'div',
          { class: 'symptom-buttons' },
          h('button', { class: 'button button-quiet', type: 'button', onclick: () => store.setReportMode(false) }, 'Cancel'),
          h('button', { class: 'button button-primary button-save', type: 'submit' }, h('span', { class: 'button-icon-check', 'aria-hidden': 'true' }), 'Save report'),
        ),
      ),
    );
    formHost.append(this.form);
    // Inside the form, Esc first stops dictation; only a second Esc closes the report.
    this.form.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.dictation?.handleEscape()) {
        event.preventDefault();
        event.stopPropagation();
      }
    });

    store.events.on('reportMode', (enabled) => this.applyMode(enabled));
    store.events.on('symptomDraft', (draft) => this.applyDraft(draft));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && store.reportMode) store.setReportMode(false);
    });
    this.applyMode(store.reportMode);
  }

  private applyMode(enabled: boolean): void {
    this.toggle.setAttribute('aria-pressed', String(enabled));
    // The view control writes the everyday hint; this one only speaks while reporting.
    if (enabled) setText(this.hint, HINT_REPORTING);
    this.hint.classList.toggle('is-active', enabled);
  }

  private applyDraft(draft: SymptomDraft | null): void {
    if (!draft) {
      // Closing the form always releases the microphone.
      this.dictation?.reset();
      this.form.hidden = true;
      return;
    }
    const firstSpot = this.form.hidden;
    if (firstSpot) {
      // A new report starts clean; moving the pin keeps what was already filled in.
      this.form.reset();
      this.intensity.value = String(SYMPTOM_INTENSITY.initial);
      this.error.textContent = '';
      this.suggestions.reset();
      this.dictation?.reset();
      this.showNotesCount();
    }
    this.system.replaceChildren(...draft.systems.map((id) => h('option', { value: id }, SYSTEMS[id].name)));
    this.system.disabled = draft.systems.length < 2;
    this.showIntensity();
    this.form.hidden = false;
    if (firstSpot) this.intensity.focus({ preventScroll: true });
  }

  private showIntensity(): void {
    const value = Number(this.intensity.value);
    const word = intensityWord(value);
    setText(this.intensityValue, `${value}/${SYMPTOM_INTENSITY.max}`);
    setText(this.intensityWord, word);
    this.intensity.setAttribute('aria-valuetext', `${value} of ${SYMPTOM_INTENSITY.max}, ${word.toLowerCase()}`);
    // The track fills up to the thumb, and warms as the rating rises.
    const fraction = (value - SYMPTOM_INTENSITY.min) / (SYMPTOM_INTENSITY.max - SYMPTOM_INTENSITY.min);
    this.intensity.style.setProperty('--fill', `${(fraction * 100).toFixed(1)}%`);
    this.intensity.closest('.symptom-field')?.setAttribute('data-level', word.toLowerCase().replace(' ', '-'));
  }

  private onNotesChanged(): void {
    this.suggestions.update(this.notes.value);
    this.showNotesCount();
  }

  private showNotesCount(): void {
    setText(this.notesCount, `${this.notes.value.length}/${SYMPTOM_NOTES_MAX}`);
  }

  private submit(event: Event): void {
    event.preventDefault();
    const draft = this.store.symptomDraft;
    if (!draft) return;
    if (this.dictation?.busy) {
      this.error.textContent = 'Stop dictation and review the transcript before saving.';
      this.dictation.button.focus();
      return;
    }
    const type = new FormData(this.form).get('type');
    if (typeof type !== 'string') {
      this.error.textContent = 'Choose the type that fits best.';
      this.form.querySelector<HTMLInputElement>('input[name="type"]')?.focus();
      return;
    }
    this.actions.reportSymptom({
      systemId: this.system.value as SystemId,
      position: draft.position,
      intensity: Number(this.intensity.value),
      type: type as SymptomType,
      notes: this.notes.value,
      // Only what the crew member ticked; a keyword in the notes alone adds nothing.
      confirmedSelfChecks: this.suggestions.confirmed(),
    });
    this.toggle.focus({ preventScroll: true });
  }
}
