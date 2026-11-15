import { ENVIRONMENT_LIST, formatDelay } from './catalog/environments';
import { INDICATORS } from './catalog/indicators';
import { REALTIME_LIMIT_SEC } from './engine/triage';
import type { Intervention } from './engine/verify';
import { INDICATOR_RULES } from './evidence/indicatorRules';
import { ruleById } from './evidence/catalog';
import { offerSteps, type MedicalPlan } from './medicalPlan';
import { severity } from './status';
import { SYMPTOM_TYPE_LABEL, type SymptomReport } from './symptoms';
import type { EnvironmentDef, EnvironmentId, Evaluation, HealthStatus, IndicatorId, MissionMinutes, SystemId } from './types';

/**
 * "Send to Flight Surgeon": a consultation with the ground, and how long it really takes.
 *
 * The delay is not invented here: light travel is 2 × the environment's `commsDelaySec` (the
 * same value the triage uses), plus `linkHandlingSec` for relays and ground handling. From the
 * station an answer comes almost at once; from Mars it takes about 44 minutes. That gap is the
 * case for Earth-Independent Medical Operations (EIMO): the farther from Earth, the more the
 * crew must be able to act alone first.
 *
 * The reply is assembled from the onboard protocol for the data that was sent. It adds no
 * diagnosis, changes no status and never authorizes a drug the medical plan withholds.
 * Pure TypeScript: no DOM, no timers, no three.js.
 */

// ---------- Latency ----------

export interface ConsultLatency {
  /** Light travel one way, seconds (the environment's `commsDelaySec`). */
  oneWaySec: number;
  lightRoundTripSec: number;
  /** Relays and ground handling, seconds. */
  handlingSec: number;
  /** What the crew waits from sending to reading the answer. */
  roundTripSec: number;
  /** True when a live conversation is practical (same limit as the triage). */
  realtime: boolean;
}

export function consultLatency(env: EnvironmentDef): ConsultLatency {
  const oneWaySec = env.commsDelaySec;
  const lightRoundTripSec = 2 * oneWaySec;
  const handlingSec = env.linkHandlingSec;
  return { oneWaySec, lightRoundTripSec, handlingSec, roundTripSec: lightRoundTripSec + handlingSec, realtime: oneWaySec <= REALTIME_LIMIT_SEC };
}

/** Every environment, nearest first: the ladder that shows why autonomy grows with distance. */
export function latencyLadder(): { id: EnvironmentId; shortName: string; roundTripSec: number }[] {
  return ENVIRONMENT_LIST.map((env) => ({ id: env.id, shortName: env.shortName, roundTripSec: consultLatency(env).roundTripSec })).sort(
    (a, b) => a.roundTripSec - b.roundTripSec,
  );
}

/** "2.5 s", "11 s", "22 min", "44 min". */
export const formatRoundTrip = (seconds: number): string => formatDelay(seconds);

// ---------- Playback ----------

/** Waits up to this long are played in real time. */
export const REALTIME_PLAYBACK_LIMIT_SEC = 20;
/** Longer waits are compressed to this many seconds for the demo, and labeled as such. */
export const ACCELERATED_PLAYBACK_SEC = 30;
/** Local steps before the signal leaves: packing the summary, then transmitting it. */
export const PREPARING_SEC = 1.2;
export const SENDING_SEC = 1.6;

export interface ConsultPlayback {
  /** Link seconds that pass per demo second (1 = real time). */
  speedup: number;
  accelerated: boolean;
  /** Demo seconds from pressing the button to the answer. */
  totalSec: number;
}

export function consultPlayback(latency: ConsultLatency): ConsultPlayback {
  const accelerated = latency.roundTripSec > REALTIME_PLAYBACK_LIMIT_SEC;
  const linkSec = accelerated ? ACCELERATED_PLAYBACK_SEC : latency.roundTripSec;
  return { speedup: latency.roundTripSec / linkSec, accelerated, totalSec: PREPARING_SEC + SENDING_SEC + linkSec };
}

// ---------- Phases ----------

export const CONSULT_PHASES = ['preparing', 'sending', 'en-route', 'awaiting', 'received'] as const;
export type ConsultPhase = (typeof CONSULT_PHASES)[number];

export const CONSULT_PHASE_LABEL: Record<ConsultPhase, string> = {
  preparing: 'Preparing transmission',
  sending: 'Sending medical summary',
  'en-route': 'Signal en route',
  awaiting: 'Awaiting response from Earth',
  received: 'Response received',
};

/** What the mission history records, at the phases that mark the link. */
export const CONSULT_EVENT_LABEL: Partial<Record<ConsultPhase, string>> = {
  preparing: 'Consultation requested',
  'en-route': 'Signal sent',
  awaiting: 'Awaiting Earth response',
  received: 'Earth response received',
};

/** Demo second at which each phase starts. */
export function phaseSchedule(latency: ConsultLatency, playback: ConsultPlayback): { phase: ConsultPhase; atSec: number }[] {
  const linkStart = PREPARING_SEC + SENDING_SEC;
  return [
    { phase: 'preparing', atSec: 0 },
    { phase: 'sending', atSec: PREPARING_SEC },
    { phase: 'en-route', atSec: linkStart },
    { phase: 'awaiting', atSec: linkStart + latency.oneWaySec / playback.speedup },
    { phase: 'received', atSec: linkStart + latency.roundTripSec / playback.speedup },
  ];
}

export interface ConsultProgress {
  phase: ConsultPhase;
  /** Link seconds elapsed since the signal left (real, not demo, seconds). */
  linkElapsedSec: number;
  /** Real seconds until the answer is read. */
  remainingSec: number;
  /** 0 → 1 while the request travels to Earth. */
  outbound: number;
  /** 0 → 1 while the answer travels back; null before it leaves Earth. */
  inbound: number | null;
}

/** Where a consultation stands `elapsedSec` demo seconds after the button was pressed. */
export function consultProgress(latency: ConsultLatency, playback: ConsultPlayback, elapsedSec: number): ConsultProgress {
  const linkStart = PREPARING_SEC + SENDING_SEC;
  const e = Math.max(0, elapsedSec);
  const linkElapsedSec = Math.min(latency.roundTripSec, Math.max(0, e - linkStart) * playback.speedup);
  const { oneWaySec, roundTripSec, handlingSec } = latency;
  const remainingSec = roundTripSec - linkElapsedSec;
  const phase: ConsultPhase =
    e < PREPARING_SEC ? 'preparing' : e < linkStart ? 'sending' : linkElapsedSec >= roundTripSec ? 'received' : linkElapsedSec < oneWaySec ? 'en-route' : 'awaiting';
  const outbound = oneWaySec > 0 ? Math.min(1, linkElapsedSec / oneWaySec) : 1;
  const replyLeaves = oneWaySec + handlingSec;
  const inbound = linkElapsedSec < replyLeaves ? null : oneWaySec > 0 ? Math.min(1, (linkElapsedSec - replyLeaves) / oneWaySec) : 1;
  return { phase, linkElapsedSec, remainingSec: Math.max(0, remainingSec), outbound, inbound };
}

/** Mission time of a phase, as it happens on the link (not as fast as the demo plays it). */
export function phaseMissionTime(createdAt: MissionMinutes, latency: ConsultLatency, phase: ConsultPhase): MissionMinutes {
  const sentAt = createdAt + (PREPARING_SEC + SENDING_SEC) / 60;
  switch (phase) {
    case 'preparing':
      return createdAt;
    case 'sending':
      return createdAt + PREPARING_SEC / 60;
    case 'en-route':
      return sentAt;
    case 'awaiting':
      return sentAt + latency.oneWaySec / 60;
    case 'received':
      return sentAt + latency.roundTripSec / 60;
  }
}

// ---------- When to offer it ----------

export interface ConsultReason {
  kind: 'critical' | 'not-verified';
  text: string;
}

/**
 * Whether the situation calls for the ground: a critical finding (the triage already says
 * "ground-consult"), or a treatment that did not work, which the protocol answers with
 * "move to the next authority level". Anything milder stays on board.
 */
export function consultReason(evaluation: Evaluation, interventions: readonly Intervention[]): ConsultReason | null {
  if (evaluation.triage.level === 'ground-consult') return { kind: 'critical', text: evaluation.triage.headline };
  for (let i = interventions.length - 1; i >= 0; i--) {
    const intervention = interventions[i];
    if (intervention.outcome !== 'not_verified') continue;
    const indicator = findIndicator(evaluation, intervention.indicatorId);
    if (indicator && severity(indicator.status) >= severity('caution')) {
      return { kind: 'not-verified', text: `“${intervention.stepText}” did not bring ${indicator.def.name.toLowerCase()} back in range` };
    }
  }
  return null;
}

// ---------- The request ----------

export interface ConsultFinding {
  systemId: SystemId;
  systemName: string;
  indicatorId: IndicatorId;
  indicatorName: string;
  status: HealthStatus;
  /** "112 bpm", or null when nothing has been measured. */
  value: string | null;
  /** The protocol condition this indicator belongs to. */
  condition: string;
  /** Steps the onboard guidance already gives for this status, drugs withheld unless pre-authorized. */
  steps: string[];
}

export interface ConsultRequest {
  reason: ConsultReason;
  triageHeadline: string;
  findings: ConsultFinding[];
  treatments: { step: string; indicatorName: string; outcome: Intervention['outcome'] }[];
  symptoms: { type: string; intensity: number; systemName: string; notes: string }[];
  /** The medical summary as sent, one line per item. */
  summary: string[];
}

const MAX_FINDINGS = 3;
const MAX_HISTORY = 3;

/** Packs what the crew member's twin knows right now into a short summary for the ground. */
export function buildConsultRequest(
  evaluation: Evaluation,
  reason: ConsultReason,
  context: { interventions: readonly Intervention[]; symptoms: readonly SymptomReport[]; plan: MedicalPlan },
): ConsultRequest {
  const flagged = Object.values(evaluation.systems)
    .filter((s) => s.driver && severity(s.status) >= severity('caution'))
    .sort((a, b) => severity(b.status) - severity(a.status))
    .slice(0, MAX_FINDINGS);
  const findings: ConsultFinding[] = flagged.map((system) => {
    const driver = system.driver!;
    const { def } = driver;
    const guidance = system.status === 'critical' ? def.guidance.critical : def.guidance.caution;
    return {
      systemId: system.def.id,
      systemName: system.def.name,
      indicatorId: def.id,
      indicatorName: def.name,
      status: driver.status,
      value: driver.latest ? `${driver.latest.value.toFixed(def.decimals)} ${def.unit}` : null,
      condition: ruleById(INDICATOR_RULES[def.id].ruleId)?.condition ?? def.name,
      steps: offerSteps(guidance, context.plan)
        .filter((step) => !step.withheld)
        .map((step) => step.text),
    };
  });
  const treatments = context.interventions.slice(-MAX_HISTORY).map((i) => ({
    step: i.stepText,
    indicatorName: INDICATORS[i.indicatorId].name,
    outcome: i.outcome,
  }));
  const symptoms = context.symptoms.slice(-MAX_HISTORY).map((s) => ({
    type: SYMPTOM_TYPE_LABEL[s.type],
    intensity: s.intensity,
    systemName: evaluation.systems[s.systemId].def.name,
    notes: s.notes,
  }));
  const summary = [
    `Reason: ${reason.text}.`,
    ...findings.map((f) => `${f.systemName}: ${f.indicatorName} ${f.value ?? 'not measured'} (${f.status}).`),
    ...treatments.map((t) => `Done: “${t.step}” for ${t.indicatorName.toLowerCase()} (${OUTCOME_TEXT[t.outcome]}).`),
    ...symptoms.map((s) => `Reported: ${s.type.toLowerCase()}, ${s.intensity}/10 (${s.systemName.toLowerCase()}).`),
  ];
  return { reason, triageHeadline: evaluation.triage.headline, findings, treatments, symptoms, summary };
}

const OUTCOME_TEXT: Record<Intervention['outcome'], string> = {
  pending: 'response pending',
  verified: 'verified',
  not_verified: 'not verified',
};

// ---------- The answer ----------

export interface FlightSurgeonResponse {
  lines: string[];
  /** Where the answer comes from and what it is not. */
  note: string;
}

export const RESPONSE_NOTE =
  'Simulated reply for this prototype, assembled from the onboard protocol for the data that was sent. It adds no diagnosis, and medication stays limited to the mission medical plan.';

/**
 * The flight surgeon's answer to a request: the protocol's own next steps, in order.
 * Nothing here goes beyond what the onboard guidance already says.
 */
export function composeResponse(request: ConsultRequest, latency: ConsultLatency): FlightSurgeonResponse {
  const lines: string[] = [];
  const top = request.findings[0];
  if (top) {
    lines.push(
      INDICATORS[top.indicatorId].acquisition === 'self-check'
        ? `Summary received. Repeat the measurement now and log it: ${top.indicatorName}.`
        : `Summary received. Recheck ${top.indicatorName} now and confirm the sensor reading.`,
    );
    if (top.steps[0]) lines.push(`Continue: ${lowerFirst(top.steps[0])}`);
  } else {
    lines.push('Summary received. Repeat the measurements that raised the alert and log them.');
  }
  for (const finding of request.findings.slice(1)) lines.push(`Also recheck ${finding.indicatorName} (${finding.systemName}).`);
  if (request.treatments.some((t) => t.outcome === 'not_verified') || request.reason.kind === 'not-verified') {
    lines.push(`Move to the next authority level of the protocol${top ? ` for ${lowerFirst(top.condition)}` : ''}, with the Crew Medical Officer.`);
  }
  if (request.symptoms.length > 0) lines.push('Review the discomfort you reported during the guided check.');
  if (!latency.realtime) {
    lines.push(`Keep following the onboard protocol: this answer is based on data ${formatRoundTrip(latency.roundTripSec)} old.`);
  }
  lines.push('Escalate again if symptoms worsen or a value turns critical.');
  return { lines, note: RESPONSE_NOTE };
}

// ---------- The consultation ----------

export interface ConsultEvent {
  phase: ConsultPhase;
  label: string;
  t: MissionMinutes;
}

export interface FlightSurgeonConsult {
  id: number;
  createdAt: MissionMinutes;
  environment: EnvironmentId;
  environmentName: string;
  request: ConsultRequest;
  latency: ConsultLatency;
  playback: ConsultPlayback;
  /** Wall-clock milliseconds when the button was pressed; drives the countdown. */
  startedAtMs: number;
  status: ConsultPhase;
  /** Mission history: requested, sent, awaiting, received. */
  events: ConsultEvent[];
  response: FlightSurgeonResponse | null;
}

export function createConsult(id: number, createdAt: MissionMinutes, startedAtMs: number, env: EnvironmentDef, request: ConsultRequest): FlightSurgeonConsult {
  const latency = consultLatency(env);
  return {
    id,
    createdAt,
    environment: env.id,
    environmentName: env.name,
    request,
    latency,
    playback: consultPlayback(latency),
    startedAtMs,
    status: 'preparing',
    events: [{ phase: 'preparing', label: CONSULT_EVENT_LABEL.preparing!, t: createdAt }],
    response: null,
  };
}

/** The consultation moved on to `phase`. Phases never go back; the answer comes with `received`. */
export function advanceConsult(consult: FlightSurgeonConsult, phase: ConsultPhase): FlightSurgeonConsult {
  if (CONSULT_PHASES.indexOf(phase) <= CONSULT_PHASES.indexOf(consult.status)) return consult;
  const label = CONSULT_EVENT_LABEL[phase];
  return {
    ...consult,
    status: phase,
    events: label ? [...consult.events, { phase, label, t: phaseMissionTime(consult.createdAt, consult.latency, phase) }] : consult.events,
    response: phase === 'received' ? composeResponse(consult.request, consult.latency) : consult.response,
  };
}

export const isConsultActive = (consult: FlightSurgeonConsult): boolean => consult.status !== 'received';

// ---------- helpers ----------

function findIndicator(evaluation: Evaluation, id: IndicatorId) {
  for (const system of Object.values(evaluation.systems)) {
    const found = system.indicators.find((i) => i.def.id === id);
    if (found) return found;
  }
  return undefined;
}

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);
