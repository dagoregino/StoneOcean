import qrcode from 'qrcode-generator';
import { ResourceError, type FieldErrors } from '../../domain/resources/inventory';
import { LEVEL_GLYPH, type Level, type ResourceCategory } from '../../domain/resources/types';
import { h } from '../dom';

/** Small building blocks shared by the Medical Resources screens. */

/** A state badge: color, shape and words together, so it never relies on color alone. */
export function levelBadge(level: Level, label: string): HTMLElement {
  return h('span', { class: 'res-badge', dataset: { level } }, h('span', { class: 'res-badge-glyph', 'aria-hidden': 'true' }, LEVEL_GLYPH[level]), label);
}

const ICONS: Record<ResourceCategory | 'crew' | 'alert' | 'scan' | 'all', string> = {
  pharmaceutical: '<rect x="3.5" y="8" width="17" height="8" rx="4"/><path d="M12 8v8"/>',
  device: '<rect x="4" y="5" width="16" height="11" rx="2"/><path d="M7 11h2l1.5-3 2.5 5 1.5-2H17M9 19h6"/>',
  consumable: '<path d="M4 8l8-4 8 4v8l-8 4-8-4z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
  emergency: '<path d="M12 3l9 16H3z"/><path d="M12 10v4M12 16.5v.5"/>',
  crew: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.700 6 6"/><path d="M16 5.200a3.200 3.200 0 0 1 0 5.600M17.500 14.300c2.100.8 3.500 2.900 3.500 5.700"/>',
  alert: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.500 2h-15z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M8 9v6M11 9v6M14 9v6M16.500 9v6"/>',
  all: '<rect x="4" y="4" width="7" height="7" rx="1.500"/><rect x="13" y="4" width="7" height="7" rx="1.500"/><rect x="4" y="13" width="7" height="7" rx="1.500"/><rect x="13" y="13" width="7" height="7" rx="1.500"/>',
};

/** A line icon. Decorative: the text beside it carries the meaning. */
export function icon(name: keyof typeof ICONS): HTMLElement {
  const span = h('span', { class: 'res-icon', 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.700" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

export const formatDate = (date: string | undefined): string => (date ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
export const formatDateTime = (iso: string): string => new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The QR code of a record, as an inline image. The payload is the record's identifier. */
export function qrCode(resourceId: string): HTMLElement {
  const qr = qrcode(0, 'M');
  qr.addData(`HELIOS:RES:${resourceId}`);
  qr.make();
  const holder = h('div', { class: 'res-qr', role: 'img', 'aria-label': `QR code for ${resourceId}` });
  holder.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  return holder;
}

// ---------- Dialogs ----------

export { confirmDialog, openDialog, type Dialog } from '../dialog';

// ---------- Forms ----------

export interface Field {
  element: HTMLElement;
  control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  setError(message: string | undefined): void;
}

let fieldSequence = 0;

/** A labelled control with room for a hint and for its own error message. */
export function field(label: string, control: Field['control'], options: { hint?: string; optional?: boolean; span?: boolean } = {}): Field {
  const id = control.id || `res-field-${++fieldSequence}`;
  control.id = id;
  const error = h('p', { class: 'res-field-error', id: `${id}-error`, role: 'alert' });
  const hint = options.hint ? h('p', { class: 'res-field-hint', id: `${id}-hint` }, options.hint) : null;
  control.setAttribute('aria-describedby', [hint ? `${id}-hint` : '', `${id}-error`].filter(Boolean).join(' '));
  const element = h(
    'div',
    { class: `res-field${options.span ? ' res-field-span' : ''}` },
    h('label', { for: id }, label, options.optional ? h('span', { class: 'res-optional' }, ' optional') : null),
    control,
    hint,
    error,
  );
  const clear = (): void => {
    error.textContent = '';
    control.removeAttribute('aria-invalid');
  };
  control.addEventListener('input', clear);
  control.addEventListener('change', clear);
  return {
    element,
    control,
    setError(message) {
      error.textContent = message ?? '';
      if (message) control.setAttribute('aria-invalid', 'true');
      else control.removeAttribute('aria-invalid');
    },
  };
}

export function textInput(props: Record<string, unknown> = {}): HTMLInputElement {
  const { list, ...rest } = props;
  const input = h('input', { type: 'text', class: 'res-input', ...rest });
  // `list` is read-only as a property: a suggestion list can only be attached as an attribute.
  if (typeof list === 'string') input.setAttribute('list', list);
  return input;
}
export const selectInput = (options: readonly (readonly [string, string])[], value?: string): HTMLSelectElement => {
  const select = h('select', { class: 'res-input' }, ...options.map(([v, label]) => h('option', { value: v }, label)));
  if (value !== undefined) select.value = value;
  return select;
};

/**
 * Shows the errors of a failed save next to their fields; anything that has no field goes
 * to the summary line. Returns the message for that line.
 */
export function showErrors(error: unknown, fields: Record<string, Field | undefined>, summary: HTMLElement): void {
  for (const f of Object.values(fields)) f?.setError(undefined);
  if (!(error instanceof ResourceError)) {
    summary.textContent = error instanceof Error ? `It could not be saved: ${error.message}` : 'It could not be saved.';
    return;
  }
  const errors: FieldErrors = error.fields;
  const loose: string[] = [];
  let first: Field | undefined;
  for (const [name, message] of Object.entries(errors)) {
    const target = fields[name];
    if (target && message) {
      target.setError(message);
      first ??= target;
    } else if (message) loose.push(message);
  }
  summary.textContent = loose.join(' ') || (first ? 'Check the highlighted fields.' : error.message);
  first?.control.focus();
}

// ---------- Toasts ----------

let toastRegion: HTMLElement | null = null;

/** A short confirmation at the bottom of the screen, also announced to screen readers. */
export function toast(message: string, kind: 'ok' | 'error' = 'ok'): void {
  if (!toastRegion) {
    toastRegion = h('div', { class: 'res-toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const item = h('div', { class: 'res-toast', dataset: { kind } }, message);
  // Inside an open modal the page behind is inert, so the message goes to the top layer with it.
  const host = document.querySelector('dialog[open]') ?? document.body;
  if (toastRegion.parentElement !== host) host.append(toastRegion);
  toastRegion.append(item);
  window.setTimeout(() => item.remove(), kind === 'error' ? 6000 : 3500);
}

/** Saves text as a file on the device: no server involved. */
export function download(filename: string, content: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = h('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
