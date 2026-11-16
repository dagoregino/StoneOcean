import type { DictationController, DictationSnapshot } from '../speech/DictationController';
import { DICTATION_ERROR_TEXT } from '../speech/errors';
import { appendTranscript } from '../speech/transcript';
import type { DictationState } from '../speech/types';
import { h, setText } from './dom';

interface ButtonView {
  /** Large line on the button. */
  text: string;
  /** Short hint under it: what a tap does now. */
  hint: string;
  label: string;
  pressed: boolean;
  disabled: boolean;
}

const BUTTON: Record<DictationState, ButtonView> = {
  idle: { text: 'Dictate', hint: 'Tap to speak', label: 'Dictate notes: start offline voice dictation', pressed: false, disabled: false },
  loading: { text: 'Preparing…', hint: 'Tap to cancel', label: 'Loading the offline voice model. Press to cancel.', pressed: false, disabled: false },
  listening: { text: 'Listening… tap to stop', hint: 'Speak naturally · Esc stops', label: 'Stop dictation', pressed: true, disabled: false },
  processing: { text: 'Processing…', hint: 'Turning words into text', label: 'Finishing the transcript', pressed: true, disabled: true },
  ready: { text: 'Transcript ready', hint: 'Review in notes above', label: 'Dictate more notes', pressed: false, disabled: false },
  error: { text: 'Try again', hint: 'Could not start', label: 'Try voice dictation again', pressed: false, disabled: false },
};

const STATUS: Record<DictationState, string> = {
  idle: '',
  loading: 'Loading voice model…',
  listening: 'Listening. Speak, then press Stop or Esc.',
  processing: 'Finishing…',
  ready: '',
  error: '',
};

export interface NotesDictationOptions {
  controller: DictationController;
  notes: HTMLTextAreaElement;
  maxLength: number;
  /** Called after the transcript has been put into the notes. */
  onInserted(): void;
}

/**
 * The microphone button of the notes field, its status line and the live transcript.
 *
 * The finished transcript goes into the notes textarea as ordinary, editable text and focus
 * moves there, so it is reviewed and corrected before "Save report". Nothing is saved here.
 */
export class NotesDictation {
  readonly button: HTMLButtonElement;
  readonly element: HTMLElement;
  private readonly buttonText = h('span', { class: 'mic-button-text' });
  private readonly buttonHint = h('span', { class: 'mic-button-hint' });
  private readonly status = h('p', { class: 'dictation-status', id: 'dictation-status', role: 'status' });
  private readonly partial = h('p', { class: 'dictation-partial', hidden: true });
  private readonly committed = h('span', { class: 'dictation-committed' });
  private readonly pending = h('span', { class: 'dictation-pending' });
  private readonly alert = h('div', { class: 'dictation-error', role: 'alert' });
  /** The transcript of a session goes into the notes once only. */
  private inserted = true;

  constructor(private readonly options: NotesDictationOptions) {
    const { controller } = options;
    this.button = h(
      'button',
      {
        class: 'mic-button',
        type: 'button',
        'aria-pressed': 'false',
        'aria-describedby': 'dictation-status dictation-privacy',
        onclick: () => void controller.toggle(),
      },
      h('span', { class: 'mic-orb', 'aria-hidden': 'true' }, h('span', { class: 'mic-icon' })),
      h('span', { class: 'mic-button-copy' }, this.buttonText, this.buttonHint),
    );
    // The live words are for sighted users; screen readers get the state changes and the final text.
    this.partial.setAttribute('aria-hidden', 'true');
    this.partial.append(this.committed, this.pending);
    this.element = h(
      'div',
      { class: 'dictation' },
      this.partial,
      this.status,
      this.alert,
    );
    controller.subscribe((snapshot) => this.render(snapshot));
    this.render(controller.snapshot);
  }

  /** Esc stops listening (keeping what was said) or cancels loading. True when it was used. */
  handleEscape(): boolean {
    const { controller } = this.options;
    const { state } = controller.snapshot;
    if (state === 'listening') void controller.stop();
    else if (state === 'loading') controller.cancel();
    else return false;
    return true;
  }

  /** Busy dictating: the report should not be saved until the transcript is in the notes. */
  get busy(): boolean {
    return this.options.controller.active;
  }

  /** A new report, or the form closed: release the microphone and clear the messages. */
  reset(): void {
    this.options.controller.cancel();
    this.inserted = true;
    this.render(this.options.controller.snapshot);
  }

  private render(snapshot: DictationSnapshot): void {
    const { state } = snapshot;
    const view = BUTTON[state];
    const nothingHeard = state === 'ready' && !snapshot.transcript;
    setText(this.buttonText, nothingHeard ? 'Nothing recognized' : view.text);
    setText(this.buttonHint, nothingHeard ? 'Tap to try again, closer to the microphone' : view.hint);
    // The accessible name starts with the visible words (WCAG "label in name"), then says what a press does.
    this.button.setAttribute('aria-label', `${nothingHeard ? 'Nothing recognized' : view.text}. ${view.label}`);
    this.button.setAttribute('aria-pressed', String(view.pressed));
    this.button.disabled = view.disabled;
    this.button.dataset.state = state;
    this.element.dataset.state = state;
    if (state === 'loading') this.inserted = false;

    this.partial.hidden = state !== 'listening' && state !== 'processing';
    setText(this.committed, snapshot.transcript ? `${snapshot.transcript} ` : '');
    setText(this.pending, snapshot.partial || (state === 'listening' && !snapshot.transcript ? '…' : ''));

    let status = STATUS[state];
    if ((state === 'ready' || state === 'error') && !this.inserted) {
      this.inserted = true;
      status = this.insert(snapshot);
    } else if (state === 'ready' || state === 'error') {
      status = this.status.textContent ?? '';
    }
    setText(this.status, status);

    if (state === 'error' && snapshot.error) {
      const text = DICTATION_ERROR_TEXT[snapshot.error.code];
      this.alert.replaceChildren(h('strong', null, text.title), ' ', text.help);
    } else if (this.alert.firstChild) {
      this.alert.replaceChildren();
    }
  }

  /** Puts the transcript at the end of the notes and returns what to tell the user. */
  private insert(snapshot: DictationSnapshot): string {
    const { notes, maxLength, onInserted } = this.options;
    if (!snapshot.transcript) return snapshot.state === 'ready' ? 'No speech was recognized. Try again, closer to the microphone.' : '';
    const { value, truncated } = appendTranscript(notes.value, snapshot.transcript, maxLength);
    notes.value = value;
    onInserted();
    // Straight into editing: the cursor waits at the end of the dictated text.
    notes.focus({ preventScroll: true });
    notes.setSelectionRange(value.length, value.length);
    const fit = truncated ? ` Notes hold ${maxLength} characters, so the end of the transcript did not fit.` : '';
    const kept = snapshot.state === 'error' ? 'What was recognized before the problem is in the notes.' : 'Transcript added to the notes. Review and edit it before saving.';
    return `${kept}${fit}`;
  }
}
