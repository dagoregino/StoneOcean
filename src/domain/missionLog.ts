import type { HealthStatus, IndicatorId, MissionMinutes, SystemId } from './types';

/**
 * The mission history as one ordered list of things that happened: a status changed, a
 * discomfort was reported, a step was carried out, the ground was consulted, the link
 * dropped. Each entry says where it comes from, so a measured fact is never read as a
 * report or as advice. Nothing here is a judgement of its own: entries restate what the
 * rules engine, the crew member or the link already produced.
 */

/** Where an entry comes from. */
export const EVENT_SOURCES = ['measured', 'reported', 'triage', 'protocol', 'ground'] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_SOURCE_LABEL: Record<EventSource, string> = {
  measured: 'Measured',
  reported: 'Reported',
  triage: 'Triage',
  protocol: 'Protocol',
  ground: 'Ground',
};

export type MissionEventKind =
  /** A body system's status changed (from the rules engine). */
  | 'status'
  /** The crew member reported discomfort on the body. */
  | 'symptom'
  /** "What should I do now?" was shown. */
  | 'guidance'
  /** A treatment step was carried out. */
  | 'treatment'
  /** A treatment was verified, or was not. */
  | 'verification'
  /** A flight surgeon consultation moved on (requested, sent, answered). */
  | 'consult'
  /** The link to Earth was lost or came back; a report was queued or transmitted. */
  | 'link'
  /** The daily check-in was completed. */
  | 'check-in';

export interface MissionEvent {
  id: number;
  t: MissionMinutes;
  kind: MissionEventKind;
  source: EventSource;
  /** One plain sentence. */
  text: string;
  systemId: SystemId | null;
  indicatorId?: IndicatorId;
  /** For `status` entries: what it changed from and to. */
  status?: { from: HealthStatus; to: HealthStatus };
  /** For `status` entries: the value behind the change, already formatted with its unit. */
  value?: string;
  /** For `status` entries: where the threshold comes from (for example "Individual baseline · not a NASA limit"). */
  basis?: string;
}

export type MissionEventInput = Omit<MissionEvent, 'id' | 't'> & { t?: MissionMinutes };
