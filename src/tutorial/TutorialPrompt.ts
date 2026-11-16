import './tutorial.css';

const KEY = 'helios-tutorial-seen';

export function shouldOfferTutorial(): boolean {
  const v = localStorage.getItem(KEY);
  return v !== 'done' && v !== 'dismissed';
}

export function markTutorialDone(): void {
  localStorage.setItem(KEY, 'done');
}

export function markTutorialDismissed(): void {
  localStorage.setItem(KEY, 'dismissed');
}

export class TutorialPrompt {
  private el: HTMLElement | null = null;

  show(onAccept: () => void): void {
    if (this.el) return;
    if (!shouldOfferTutorial()) return;
    const dontShow = document.createElement('input');
    dontShow.type = 'checkbox';
    const card = document.createElement('div');
    card.className = 'tut-prompt';
    card.innerHTML = `<p>Hi, I'm your assistant. Want a 30-second tour of the interface?</p>`;
    const actions = document.createElement('div');
    actions.className = 'tut-prompt-actions';
    const take = document.createElement('button');
    take.className = 'tut-btn primary';
    take.textContent = 'Take the tour';
    take.addEventListener('click', () => {
      if (dontShow.checked) markTutorialDismissed();
      this.hide();
      onAccept();
    });
    const skip = document.createElement('button');
    skip.className = 'tut-btn';
    skip.textContent = 'Not now';
    skip.addEventListener('click', () => {
      if (dontShow.checked) markTutorialDismissed();
      this.hide();
    });
    actions.append(take, skip);
    const check = document.createElement('label');
    check.className = 'tut-prompt-check';
    check.append(dontShow, document.createTextNode("Don't show again"));
    card.append(actions, check);
    document.body.append(card);
    this.el = card;
  }

  hide(): void {
    this.el?.remove();
    this.el = null;
  }
}