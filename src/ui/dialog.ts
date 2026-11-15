import { h } from './dom';

/** Modal windows shared by the whole app. */

export interface Dialog {
  element: HTMLDialogElement;
  close(): void;
}

/** A modal window. Escape and the close button dismiss it; focus returns to where it was. */
export function openDialog(title: string, body: (HTMLElement | null)[], options: { wide?: boolean; className?: string; onClose?: () => void; modal?: boolean } = {}): Dialog {
  const opener = document.activeElement as HTMLElement | null;
  const element = h(
    'dialog',
    { class: `res-dialog${options.wide ? ' res-dialog-wide' : ''}${options.className ? ` ${options.className}` : ''}`, 'aria-label': title },
    h('header', { class: 'res-dialog-head' }, h('h2', null, title), h('button', { class: 'icon-button', type: 'button', 'aria-label': 'Close', onclick: () => element.close() }, '×')),
    h('div', { class: 'res-dialog-body' }, ...body),
  );
  element.addEventListener('close', () => {
    element.remove();
    options.onClose?.();
    opener?.focus?.({ preventScroll: true });
  });
  // A click on the dimmed backdrop closes it, like Escape.
  element.addEventListener('mousedown', (event) => {
    if (event.target === element) element.close();
  });
  document.body.append(element);
  // Non-modal: shown over the page without blocking it (the guided demo keeps playing behind).
  if (options.modal === false) element.show();
  else element.showModal();
  return { element, close: () => element.close() };
}

/** Asks before something that cannot be undone from the same screen. */
export function confirmDialog(title: string, message: string, action: string, onConfirm: () => void | Promise<void>): void {
  const dialog = openDialog(title, [
    h('p', { class: 'res-dialog-text' }, message),
    h(
      'div',
      { class: 'res-form-actions' },
      h('button', { class: 'button button-quiet', type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      h(
        'button',
        {
          class: 'button',
          type: 'button',
          onclick: async () => {
            await onConfirm();
            dialog.close();
          },
        },
        action,
      ),
    ),
  ]);
}
