import type { ResourceStore } from '../../data/resources/ResourceStore';
import { daysUntil } from '../../domain/resources/dates';
import type { ProtocolReadiness, StepReadiness } from '../../domain/resources/readiness';
import type { FindingKind, Level, MovementType, Resource, ResourceAlert } from '../../domain/resources/types';
import { h } from '../dom';

/**
 * Visual building blocks for the Medical Resources screens: rings, segmented bars, meters,
 * icons and tooltips. Each one draws numbers it is given and nothing else: no value here is
 * computed, estimated or made up, so a chart is only ever as true as the store behind it.
 */

// ---------- Tooltips ----------

let tipSequence = 0;

/** A small "i" button; its explanation shows on hover and on keyboard focus, and Esc hides it. */
export function infoTip(text: string, label = 'More information'): HTMLElement {
  const id = `res-tip-${++tipSequence}`;
  const button = h('button', {
    class: 'res-tip-button',
    type: 'button',
    'aria-label': label,
    'aria-describedby': id,
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Escape') (event.currentTarget as HTMLElement).blur();
    },
  }, 'i');
  return h('span', { class: 'res-tip' }, button, h('span', { class: 'res-tip-text', role: 'tooltip', id }, text));
}

// ---------- Charts ----------

export interface Part {
  /** Picks the color: a level (ok, attention…) or a readiness status (ready, blocked…). */
  key: string;
  value: number;
  label: string;
}

const describe = (parts: readonly Part[]): string =>
  parts
    .filter((p) => p.value > 0)
    .map((p) => `${p.value} ${p.label}`)
    .join(', ') || 'none';

/** A ring split into parts, with a number in the middle. Screen readers get the numbers in words. */
export function ring(parts: readonly Part[], center: { value: string; caption: string }, title: string): HTMLElement {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const arcs = parts
    .filter((p) => p.value > 0)
    .map((p) => {
      const length = (p.value / total) * circumference;
      // A hairline gap between parts, unless one part fills the ring.
      const gap = p.value === total ? 0 : Math.min(2, length / 3);
      const arc = `<circle class="res-ring-arc" data-key="${p.key}" cx="50" cy="50" r="${radius}" stroke-dasharray="${(length - gap).toFixed(2)} ${(circumference - length + gap).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"><title>${p.value} ${p.label}</title></circle>`;
      offset += length;
      return arc;
    })
    .join('');
  const figure = h(
    'figure',
    { class: 'res-ring', role: 'img', 'aria-label': `${title}: ${describe(parts)}.` },
    h('span', { class: 'res-ring-svg' }),
    h('figcaption', { class: 'res-ring-center', 'aria-hidden': 'true' }, h('strong', null, center.value), h('span', null, center.caption)),
  );
  figure.querySelector('.res-ring-svg')!.innerHTML = `<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="res-ring-track" cx="50" cy="50" r="${radius}"/>${arcs}</svg>`;
  return figure;
}

/** A horizontal bar split into parts, sized by their values. */
export function segmentBar(parts: readonly Part[], title: string): HTMLElement {
  return h(
    'span',
    { class: 'res-seg', role: 'img', 'aria-label': `${title}: ${describe(parts)}.` },
    ...parts.filter((p) => p.value > 0).map((p) => h('span', { class: 'res-seg-part', dataset: { key: p.key }, style: `flex:${p.value}`, title: `${p.value} ${p.label}` })),
  );
}

/**
 * How full something is: `value` of `max`, with an optional marker (a minimum stock, say)
 * on the same scale. `words` is what a screen reader hears instead of the bar.
 */
export function meter(value: number, max: number, words: string, options: { key?: string; marker?: number | null } = {}): HTMLElement {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const marker = options.marker !== undefined && options.marker !== null && max > 0 && options.marker <= max ? (options.marker / max) * 100 : null;
  return h(
    'span',
    { class: 'res-meter', role: 'img', 'aria-label': words, dataset: { key: options.key ?? 'ok' } },
    h('span', { class: 'res-meter-fill', style: `width:${pct.toFixed(1)}%` }),
    marker === null ? null : h('span', { class: 'res-meter-marker', style: `left:${marker.toFixed(1)}%`, title: 'Minimum stock' }),
  );
}

// ---------- Movements ----------

const MOVEMENT_PATHS: Record<MovementType, string> = {
  entry: '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/>',
  restock: '<path d="M12 6v12M6 12h12"/><circle cx="12" cy="12" r="9"/>',
  consumption: '<path d="M6 12h12"/><circle cx="12" cy="12" r="9"/>',
  reservation: '<path d="M7 4h10v16l-5-4-5 4z"/>',
  return: '<path d="M9 7L4 12l5 5"/><path d="M4 12h11a5 5 0 0 1 0 10h-2"/>',
  expired: '<path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9"/>',
  damaged: '<path d="M14 4l-4 6h5l-5 10"/><circle cx="12" cy="12" r="9"/>',
};

/** The icon of a movement type. Decorative: its label is always written beside it. */
export function movementIcon(type: MovementType): HTMLElement {
  const span = h('span', { class: 'res-move-icon', dataset: { type }, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${MOVEMENT_PATHS[type]}</svg>`;
  return span;
}

/** "+" when units come in, "−" when they leave the count, nothing for a reservation. */
export const movementSign = (type: MovementType): string => (type === 'entry' || type === 'restock' || type === 'return' ? '+' : type === 'reservation' ? '' : '−');

// ---------- Dates ----------

/** "today", "in 12 d", "3 d ago". */
export function daysText(days: number): string {
  if (days === 0) return 'today';
  return days > 0 ? `in ${days} d` : `${-days} d ago`;
}

const KIND_DATE: Partial<Record<FindingKind, keyof Resource>> = {
  expired: 'expiresOn',
  expiring_soon: 'expiresOn',
  calibration_overdue: 'nextCalibration',
  calibration_due: 'nextCalibration',
  maintenance_overdue: 'nextMaintenance',
  maintenance_due: 'nextMaintenance',
  inspection_overdue: 'nextInspection',
  inspection_due: 'nextInspection',
};

/** The recorded date a finding is about, if it is about one: an expiry, a calibration… */
export function findingDate(resource: Resource, kind: FindingKind): string | undefined {
  const field = KIND_DATE[kind];
  const value = field ? resource[field] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/** The date an alert is about, read from the record it concerns. Undefined when it has none. */
export function alertDate(alert: ResourceAlert, store: ResourceStore): string | undefined {
  if (alert.subject === 'resource') {
    const resource = store.resource(alert.subjectId);
    return resource ? findingDate(resource, alert.kind) : undefined;
  }
  // Crew alert ids are `${member}:${procedure}:${kind}`.
  const [, procedure] = alert.id.split(':');
  return store.crew.find((m) => m.id === alert.subjectId)?.certifications.find((c) => c.procedureCode === procedure)?.expiresOn;
}

export const relativeTo = (date: string, now: Date): string => daysText(daysUntil(date, now));

// ---------- Alert topics ----------

export const ALERT_TOPICS = ['stock', 'expiry', 'equipment', 'crew'] as const;
export type AlertTopic = (typeof ALERT_TOPICS)[number];
export const ALERT_TOPIC_LABEL: Record<AlertTopic, string> = { stock: 'Stock', expiry: 'Expiry', equipment: 'Equipment', crew: 'Crew training' };

/** Groups the kinds of finding the domain already defines, so alerts can be filtered by subject. */
export function alertTopic(kind: FindingKind): AlertTopic {
  switch (kind) {
    case 'expired':
    case 'expiring_soon':
      return 'expiry';
    case 'out_of_stock':
    case 'low_stock':
    case 'all_reserved':
    case 'quarantined':
      return 'stock';
    case 'certification_expired':
    case 'certification_expiring':
      return 'crew';
    default:
      return 'equipment';
  }
}

// ---------- Protocol readiness ----------

export const PROTOCOL_STATUSES = ['ready', 'limited', 'blocked', 'unknown'] as const;
export type ProtocolStatus = (typeof PROTOCOL_STATUSES)[number];
export const PROTOCOL_STATUS_LABEL: Record<ProtocolStatus, string> = { ready: 'Ready', limited: 'Ready with limits', blocked: 'Blocked', unknown: 'Unknown' };
export const PROTOCOL_STATUS_LEVEL: Record<ProtocolStatus, Level> = { ready: 'ok', limited: 'attention', blocked: 'critical', unknown: 'inactive' };

/** Steps the readiness engine could actually check against the inventory and the roster. */
const CHECKED: readonly StepReadiness[] = ['ready', 'ready_with_limits', 'blocked', 'no_resources'];

/**
 * One word for a whole protocol, read from the readiness engine's step results (it is not a
 * second assessment): blocked if any step is; unknown if no step could be checked; ready with
 * limits if any step has a limit, needs authorization or is not specified; otherwise ready.
 */
export function protocolStatus(readiness: ProtocolReadiness): ProtocolStatus {
  const { steps } = readiness;
  if (steps.some((s) => s.readiness === 'blocked')) return 'blocked';
  if (!steps.some((s) => CHECKED.includes(s.readiness))) return 'unknown';
  if (steps.some((s) => s.readiness === 'ready_with_limits' || s.readiness === 'needs_authorization' || s.readiness === 'unspecified')) return 'limited';
  return 'ready';
}

/** Color key of one step in a step bar. */
export const STEP_KEY: Record<StepReadiness, string> = {
  ready: 'ready',
  no_resources: 'ready',
  ready_with_limits: 'limited',
  needs_authorization: 'limited',
  blocked: 'blocked',
  unspecified: 'unknown',
};

export interface Pending {
  level: Level;
  /** A few words, for a chip. */
  text: string;
  /** The engine's own sentence, for the tooltip and the details. */
  detail: string;
}

const OUTCOME_SHORT = { missing: 'missing', insufficient: 'not enough', unusable: 'unusable' } as const;

/** What stands between a protocol and being ready, in chips. Taken from the engine's checks. */
export function pendingOf(readiness: ProtocolReadiness): Pending[] {
  const seen = new Set<string>();
  const out: Pending[] = [];
  const add = (pending: Pending): void => {
    if (seen.has(pending.text)) return;
    seen.add(pending.text);
    out.push(pending);
  };
  for (const step of readiness.steps) {
    const before = out.length;
    for (const item of step.items) {
      if (item.outcome === 'missing' || item.outcome === 'insufficient' || item.outcome === 'unusable') {
        add({ level: 'critical', text: `${item.need.label} · ${OUTCOME_SHORT[item.outcome]}`, detail: item.detail });
      } else if (item.outcome === 'alternative' && item.alternative) {
        add({ level: 'attention', text: `${item.need.label} → ${item.alternative.label}`, detail: item.detail });
      }
    }
    for (const person of step.personnel) {
      if (person.qualified.length === 0) add({ level: 'critical', text: `${person.procedure} · no trained crew available`, detail: person.detail });
      else if (person.qualified.length === 1) add({ level: 'attention', text: `${person.procedure} · only ${person.qualified[0].name}`, detail: person.detail });
    }
    // A limit the engine noted without a missing item or person behind it (a finding on a record…).
    if (step.readiness === 'ready_with_limits' && out.length === before && step.limitations.length > 0) {
      add({ level: 'attention', text: `Step ${step.index + 1} · ${step.limitations.length} limit${step.limitations.length === 1 ? '' : 's'}`, detail: step.limitations.join(' ') });
    }
    if (step.readiness === 'needs_authorization') add({ level: 'attention', text: `Step ${step.index + 1} · needs authorization`, detail: step.limitations[0] ?? step.step.text });
    if (step.readiness === 'unspecified') add({ level: 'inactive', text: `Step ${step.index + 1} · not specified`, detail: step.limitations[0] ?? step.step.text });
  }
  return out;
}

// ---------- People ----------

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
