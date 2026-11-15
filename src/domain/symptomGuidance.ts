import { INDICATORS } from './catalog/indicators';
import { HAZARDS, SYSTEMS } from './catalog/systems';
import { consultLatency, formatRoundTrip, type ConsultReason } from './consult';
import { REALTIME_LIMIT_SEC } from './engine/triage';
import { ruleById, RULES } from './evidence/catalog';
import { INDICATOR_RULES } from './evidence/indicatorRules';
import type { TreatmentStep } from './evidence/types';
import { offerSteps, type MedicalPlan } from './medicalPlan';
import { severity, worst } from './status';
import { SYMPTOM_TYPE_LABEL, type SymptomReport } from './symptoms';
import type { EnvironmentDef, Evaluation, HazardId, HealthStatus, IndicatorEvaluation, IndicatorId } from './types';

/**
 * "What should I do now?" after a discomfort report.
 *
 * Nothing here is new medical advice. Every line is taken from something the app already
 * holds: the triage verdict, the first steps and protocols of the rules matrix, the
 * self-checks the catalog files under the reported body system, the current readings, and
 * the mission environment. Where the rules have nothing to say, the guidance says exactly
 * that instead of filling the gap.
 *
 * A report never changes a status. So the guidance does not claim to know what causes the
 * discomfort: it keeps what was measured, what was reported and what is only context apart,
 * and each line carries the kind of source it comes from.
 */

/** Where a line of guidance comes from. Shown next to it, so it is never mistaken for something else. */
export type GuidanceSource =
  /** A reading from a sensor or a logged self-check. */
  | 'measured'
  /** What the crew member said in the report. */
  | 'reported'
  /** A step of an onboard rule or protocol that is active because of measured data. */
  | 'protocol'
  /** The triage verdict computed from measured data. */
  | 'triage'
  /** A self-check the catalog files under this body system, or one the crew member confirmed. */
  | 'self-check'
  /** The mission environment: where the crew is, how far Earth is. */
  | 'context'
  /** A hazard NASA's Human Research Program tracks for this body system. Context, not a cause. */
  | 'known-risk'
  /** What the app does not and cannot know. */
  | 'uncertainty';

export const GUIDANCE_SOURCE_LABEL: Record<GuidanceSource, string> = {
  measured: 'Measured',
  reported: 'Reported by you',
  protocol: 'Onboard protocol',
  triage: 'Triage',
  'self-check': 'Self-check',
  context: 'Mission context',
  'known-risk': 'Known mission risk',
  uncertainty: 'Not known',
};

export interface GuidanceLine {
  text: string;
  source: GuidanceSource;
}

export type GuidanceTier = 'self-check' | 'attention' | 'immediate';

export const GUIDANCE_TIER_TITLE: Record<GuidanceTier, string> = {
  'self-check': 'Self-check recommended',
  attention: 'Attention recommended',
  immediate: 'Immediate action required',
};

export interface SymptomGuidance {
  report: SymptomReport;
  tier: GuidanceTier;
  /** The status behind the tier: the worse of the reported system and the whole-crew triage. */
  status: HealthStatus;
  systemName: string;
  /** What was reported, in plain words. */
  reported: string[];
  immediate: GuidanceLine[];
  selfChecks: { indicatorId: IndicatorId; name: string; howToMeasure: string; due: boolean }[];
  /** Shown when no self-check exists for this body system. */
  selfCheckNote: string | null;
  monitor: GuidanceLine[];
  escalate: GuidanceLine[];
  /** Hazards NASA's Human Research Program associates with this body system and environment. */
  missionRisks: { hazard: HazardId; name: string; url: string; note: string }[];
  /** What the app cannot tell from a report. Always present. */
  uncertainty: string;
  /** The indicator whose onboard protocol applies now, if measured data has flagged one. */
  protocolIndicator: IndicatorId | null;
  /** Set when the situation calls for the ground (same test as "Send to Flight Surgeon"). */
  flightSurgeon: { reason: string; roundTrip: string; realtime: boolean; note: string } | null;
}

export interface GuidanceInput {
  report: SymptomReport;
  evaluation: Evaluation;
  environment: EnvironmentDef;
  plan: MedicalPlan;
  /** From `HealthStore.consultReason`: the existing test for escalating to the ground. */
  consultReason: ConsultReason | null;
}

const describe = (indicator: IndicatorEvaluation): string => {
  const { def, latest, status } = indicator;
  const value = latest ? `${latest.value.toFixed(def.decimals)}${def.unit ? ` ${def.unit}` : ''}` : 'no reading yet';
  const state = status === 'nominal' ? 'nominal' : status === 'unknown' ? 'no data' : status;
  return `${def.name}: ${value} (${state})`;
};

/** How each hazard bears on a mission, said as context and never as a cause. */
function riskNote(hazard: HazardId, env: EnvironmentDef): string {
  switch (hazard) {
    case 'radiation':
      return `Typical exposure in this environment is about ${env.radiationMSvPerDay} mSv per day.`;
    case 'distance':
      return `A message to Earth takes ${formatRoundTrip(env.commsDelaySec)} each way from here.`;
    case 'gravity':
      return env.gravityG === 0 ? 'This environment is microgravity.' : `This environment has ${env.gravityG} g.`;
    case 'isolation':
      return 'Long confinement with a small crew is part of this mission.';
    case 'environment':
      return 'Air, pressure and hygiene depend on closed life support.';
  }
}

const escalationSteps = (steps: readonly TreatmentStep[]): string[] => steps.filter((step) => step.authorityLevel === 4).map((step) => step.text);

export function buildSymptomGuidance({ report, evaluation, environment, plan, consultReason }: GuidanceInput): SymptomGuidance {
  const system = evaluation.systems[report.systemId];
  const def = SYSTEMS[report.systemId];
  const { triage } = evaluation;
  const status = worst(system.status, triage.status);
  const flagged = severity(system.status) >= severity('caution');
  const tier: GuidanceTier = status === 'critical' ? 'immediate' : status === 'caution' ? 'attention' : 'self-check';
  const driver = flagged ? system.driver : null;
  const rule = driver ? ruleById(INDICATOR_RULES[driver.def.id].ruleId) : undefined;
  const latency = consultLatency(environment);
  const systemName = def.name.toLowerCase();

  // 1. Immediate action: only what measured data has already triggered.
  const immediate: GuidanceLine[] = [];
  if (driver && (driver.status === 'caution' || driver.status === 'critical')) {
    for (const step of offerSteps(driver.def.guidance[driver.status], plan)) immediate.push({ text: step.text, source: 'protocol' });
  } else if (triage.level !== 'nominal') {
    immediate.push({ text: `${triage.headline}. ${triage.detail}`, source: 'triage' });
    immediate.push({ text: `Your measured ${systemName} indicators are within range; the alert above concerns another body system.`, source: 'measured' });
  } else {
    immediate.push({ text: `Your measured ${systemName} indicators are within range, so no onboard protocol is active for this report.`, source: 'measured' });
    immediate.push({ text: triage.detail, source: 'triage' });
  }

  // 2. Self-checks: the ones the catalog files under this system, plus those the crew member confirmed.
  const indicatorOf = (id: IndicatorId): IndicatorEvaluation | undefined => evaluation.systems[INDICATORS[id].systemId].indicators.find((i) => i.def.id === id);
  const selfChecks = report.relatedSelfChecks.map((id) => ({ indicatorId: id, name: INDICATORS[id].name, howToMeasure: INDICATORS[id].howToMeasure, due: indicatorOf(id)?.due ?? false }));

  // 3. What to monitor: this system's own indicators, and the protocol's verification criterion when one is active.
  const monitor: GuidanceLine[] = system.indicators.map((indicator) => ({ text: describe(indicator), source: 'measured' as const }));
  if (rule) monitor.push({ text: `The protocol counts it as resolved when: ${rule.verify.criterion}`, source: 'protocol' });
  if (system.indicators.length === 0) monitor.push({ text: `No indicator is tracked for the ${systemName} system.`, source: 'uncertainty' });

  // 4. When to escalate: the escalation steps the rules already contain, and the existing ground-consult test.
  const escalate: GuidanceLine[] = [];
  if (consultReason) escalate.push({ text: `Now: ${consultReason.text}.`, source: 'triage' });
  const own = RULES.filter((r) => r.systemId === report.systemId).flatMap((r) => escalationSteps(r.treat));
  const general = RULES.filter((r) => r.systemId === null).flatMap((r) => escalationSteps(r.treat));
  for (const text of [...own, ...general]) escalate.push({ text, source: 'protocol' });
  if (!consultReason) escalate.push({ text: 'If any indicator turns caution or critical, HELIOS will show what to do and whether the ground should be consulted.', source: 'triage' });
  escalate.push({
    text:
      environment.commsDelaySec <= REALTIME_LIMIT_SEC
        ? `From ${environment.name}, a flight surgeon can answer in near real time (round trip ${formatRoundTrip(latency.roundTripSec)}).`
        : `From ${environment.name}, an answer from Earth takes about ${formatRoundTrip(latency.roundTripSec)}. Start the onboard actions first; do not wait for it.`,
    source: 'context',
  });

  const missionRisks = def.hazards.map((hazard) => ({ hazard, name: HAZARDS[hazard].name, url: HAZARDS[hazard].url, note: riskNote(hazard, environment) }));

  return {
    report,
    tier,
    status,
    systemName: def.name,
    reported: [
      `${SYMPTOM_TYPE_LABEL[report.type]}, intensity ${report.intensity} of 10`,
      `Marked on the body: ${def.name}`,
      ...(report.notes ? [`Your notes: “${report.notes}”`] : []),
    ],
    immediate,
    selfChecks,
    selfCheckNote: selfChecks.length === 0 ? `No self-check is defined for the ${systemName} system. The readings below are what HELIOS tracks for it.` : null,
    monitor,
    escalate,
    missionRisks,
    uncertainty:
      'A reported symptom is not a measurement, and no onboard rule links this report to a cause. The mission risks listed are context for this body system, not an explanation of what you feel. Your report is kept in the mission log and read together with your current telemetry.',
    protocolIndicator: driver?.def.id ?? null,
    flightSurgeon: consultReason
      ? {
          reason: consultReason.text,
          roundTrip: formatRoundTrip(latency.roundTripSec),
          realtime: latency.realtime,
          note: latency.realtime
            ? 'The link is close to real time. Start the listed actions while the report is on its way.'
            : `The answer takes about ${formatRoundTrip(latency.roundTripSec)}. Start the onboard protocol now; the consultation travels in parallel.`,
        }
      : null,
  };
}
