import { h } from '../ui/dom';
import './tutorial.css';

/**
 * The HELIOS assistant's first hello: a small card in the corner that offers the interface
 * tour and never starts it on its own. It answers "how do I use HELIOS?", not "why does it
 * matter?" (that is Play the Mission).
 */

/** Where the choice is remembered on this device. Present = do not offer the tour on arrival. */
export const TUTORIAL_KEY = 'helios-tutorial-seen';

export type TutorialMemory = 'done' | 'dismissed';

/** True while this device has neither taken the tour nor asked not to be offered it again. */
export function shouldOfferTutorial(storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): boolean {
  try {
    return !storage?.getItem(TUTORIAL_KEY);
  } catch {
    return true;
  }
}

export function rememberTutorial(state: TutorialMemory, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(TUTORIAL_KEY, state);
  } catch {
    // Private mode: the offer may simply come back next time.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The assistant's face: a small glowing sphere. Decorative. */
export const assistantAvatar = (size: 'sm' | 'md' = 'md'): HTMLElement => h('span', { class: `tut-avatar tut-avatar-${size}`, 'aria-hidden': 'true' }, h('span', { class: 'tut-avatar-core' }));

export class TutorialPrompt {
  readonly element: HTMLElement;
  private readonly dontShow: HTMLInputElement;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') this.notNow();
  };

  constructor(private readonly onStart: () => void) {
    this.dontShow = h('input', { type: 'checkbox', id: 'tut-dont-show' });
    this.element = h(
      'section',
      { class: 'tut-prompt', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'tut-prompt-title', 'aria-describedby': 'tut-prompt-text', hidden: true },
      h(
        'div',
        { class: 'tut-prompt-body' },
        assistantAvatar(),
        h('div', null, h('p', { class: 'tut-prompt-title', id: 'tut-prompt-title' }, 'Hi, I’m your HELIOS assistant.'), h('p', { class: 'tut-prompt-text', id: 'tut-prompt-text' }, 'Want a 30-second tour of the interface?')),
        h('button', { class: 'tut-close', type: 'button', 'aria-label': 'Close', onclick: () => this.notNow() }, '×'),
      ),
      h(
        'div',
        { class: 'tut-prompt-actions' },
        h('button', { class: 'button tut-primary', type: 'button', onclick: () => this.take() }, 'Take the tour'),
        h('button', { class: 'button button-quiet', type: 'button', onclick: () => this.notNow() }, 'Not now'),
      ),
      h('label', { class: 'tut-dont-show', for: 'tut-dont-show' }, this.dontShow, 'Don’t show again'),
    );
    this.element.addEventListener('keydown', this.onKey);
    document.body.append(this.element);
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  /** Slides in at the corner. It does not take the focus: the dashboard stays usable. */
  show(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.element.hidden = false;
    this.element.classList.remove('is-leaving');
  }

  hide(): void {
    if (this.element.hidden) return;
    this.element.classList.add('is-leaving');
    this.hideTimer = setTimeout(() => {
      this.element.hidden = true;
      this.element.classList.remove('is-leaving');
    }, 200);
  }

  private take(): void {
    rememberTutorial('done');
    this.hide();
    this.onStart();
  }

  private notNow(): void {
    // "Not now" alone asks again next visit; with the box ticked, never on its own again.
    if (this.dontShow.checked) rememberTutorial('dismissed');
    this.hide();
  }
}
