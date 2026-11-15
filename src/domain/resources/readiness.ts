import type { Rule, TreatmentStep } from '../evidence/types';
import type { MedicalPlan } from '../medicalPlan';
import { daysUntil } from './dates';
import { findingsFor, freeUnits, isUsable } from './findings';
import { needsOf, procedureName, type ItemNeed, type ProcedureNeed } from './protocols';
import { TRAINING_RANK, type CrewMember, type Resource } from './types';

/**
 * Resource Intelligence: can an approved protocol actually be carried out with what is on
 * board and who is trained?
 *
 * It answers a logistics question, not a clinical one. It never proposes a drug, a dose or
 * a substitute of its own: it reads the protocol's own steps, the requirements signed off
 * for them (`protocols.ts`), the inventory and the crew roster, and reports what it finds.
 * An item being on board never means using it is appropriate; that stays with the protocol
 * and with the people responsible for care.
 */

export type StepReadiness =
  /** Everything the step needs is on board, usable, and someone trained is available. */
  | 'ready'
  /** Can be carried out, with something to keep in mind (an approved alternative, a certificate about to lapse…). */
  | 'ready_with_limits'
  /** Something the step needs is missing, unusable, or nobody trained is available. */
  | 'blocked'
  /** A medication step while the medical plan does not pre-authorize drugs. */
  | 'needs_authorization'
  /** The protocol does not say what the step uses, so it cannot be checked. */
  | 'unspecified'
  /** The step needs nothing from the medical inventory. */
  | 'no_resources';

export const READINESS_LABEL: Record<StepReadiness, string> = {
  ready: 'Ready',
  ready_with_limits: 'Ready, with limits',
  blocked: 'Cannot be carried out now',
  needs_authorization: 'Needs authorization',
  unspecified: 'Not specified by the protocol',
  no_resources: 'No medical resources needed',
};

export interface ItemCheck {
  need: ItemNeed;
  outcome: 'available' | 'alternative' | 'missing' | 'unusable' | 'insufficient';
  /** Records that would be used, usable ones only. */
  records: Resource[];
  freeUnits: number;
  /** Set when an approved alternative covers the need. */
  alternative?: { typeCode: string; label: string };
  /** Plain-language explanation. */
  detail: string;
}

export interface PersonnelCheck {
  need: ProcedureNeed;
  procedure: string;
  /** Trained to the level asked, certificate in date, and available now. */
  qualified: CrewMember[];
  /** Trained and in date, but off duty or unavailable. */
  notAvailable: CrewMember[];
  detail: string;
}

export interface StepCheck {
  index: number;
  step: TreatmentStep;
  readiness: StepReadiness;
  items: ItemCheck[];
  personnel: PersonnelCheck[];
  limitations: string[];
  /** True when the step itself is an escalation or cannot proceed without the responsible medical staff. */
  escalate: boolean;
}

export interface ProtocolReadiness {
  ruleId: string;
  condition: string;
  steps: StepCheck[];
  available: ItemCheck[];
  missing: ItemCheck[];
  nonOperational: ItemCheck[];
  personnel: PersonnelCheck[];
  limitations: string[];
  /** Steps that can be carried out now. */
  executable: StepCheck[];
  /** What has to go to the responsible medical staff, and why. */
  escalations: string[];
}

const ofType = (resources: readonly Resource[], typeCode: string): Resource[] => resources.filter((r) => r.active && r.typeCode === typeCode);

function checkItem(need: ItemNeed, resources: readonly Resource[], now: Date): ItemCheck {
  const evaluate = (typeCode: string): { usable: Resource[]; all: Resource[]; free: number } => {
    const all = ofType(resources, typeCode);
    const usable = all.filter((r) => isUsable(r, now));
    return { all, usable, free: usable.reduce((sum, r) => sum + freeUnits(r), 0) };
  };
  const primary = evaluate(need.typeCode);
  if (primary.free >= need.quantity) {
    return { need, outcome: 'available', records: primary.usable, freeUnits: primary.free, detail: `${primary.free} usable on board; ${need.quantity} needed.` };
  }
  // Only what the approved protocol lists as acceptable is ever considered in its place.
  for (const alternative of need.approvedAlternatives ?? []) {
    const other = evaluate(alternative.typeCode);
    if (other.free >= need.quantity) {
      return { need, outcome: 'alternative', records: other.usable, freeUnits: other.free, alternative, detail: `${need.label} is not usable; the protocol accepts ${alternative.label}, which is on board.` };
    }
  }
  if (primary.all.length === 0) return { need, outcome: 'missing', records: [], freeUnits: 0, detail: 'None registered on board.' };
  if (primary.usable.length === 0) {
    const reasons = [...new Set(primary.all.flatMap((r) => findingsFor(r, now).filter((f) => f.blocksUse).map((f) => f.label.toLowerCase())))];
    return { need, outcome: 'unusable', records: [], freeUnits: 0, detail: `On board but not usable: ${reasons.join(', ') || 'see the record'}.` };
  }
  return { need, outcome: 'insufficient', records: primary.usable, freeUnits: primary.free, detail: `Only ${primary.free} usable; ${need.quantity} needed.` };
}

function checkPersonnel(need: ProcedureNeed, crew: readonly CrewMember[], now: Date): PersonnelCheck {
  const procedure = procedureName(need.code);
  const trained = crew.filter((member) =>
    member.certifications.some((c) => c.procedureCode === need.code && TRAINING_RANK[c.level] >= TRAINING_RANK[need.minLevel] && (!c.expiresOn || daysUntil(c.expiresOn, now) >= 0)),
  );
  const qualified = trained.filter((m) => m.availability === 'available');
  const notAvailable = trained.filter((m) => m.availability !== 'available');
  const detail =
    qualified.length > 0
      ? `Trained and available: ${qualified.map((m) => m.name).join(', ')}.`
      : notAvailable.length > 0
        ? `Trained but not available now: ${notAvailable.map((m) => m.name).join(', ')}.`
        : 'Nobody on board holds a current certification for this.';
  return { need, procedure, qualified, notAvailable, detail };
}

/** Checks every step of one protocol against the inventory and the roster. */
export function assessProtocol(rule: Rule, resources: readonly Resource[], crew: readonly CrewMember[], plan: MedicalPlan, now: Date): ProtocolReadiness {
  const needs = needsOf(rule.id);
  const steps: StepCheck[] = rule.treat.map((step, index) => {
    const { items: itemNeeds, procedures, specified } = needs[index];
    const items = itemNeeds.map((n) => checkItem(n, resources, now));
    const personnel = procedures.map((n) => checkPersonnel(n, crew, now));
    // What stops the step comes first; what is merely worth knowing follows.
    const stops: string[] = [];
    const notes: string[] = [];
    for (const check of items) {
      if (check.outcome === 'alternative') notes.push(`${check.need.label} is not usable: ${check.alternative!.label} is used instead, as the protocol allows.`);
      else if (check.outcome !== 'available') stops.push(`${check.need.label}: ${check.detail}`);
      for (const record of check.records) {
        for (const finding of findingsFor(record, now)) notes.push(`${record.name} (${record.id}): ${finding.message}`);
      }
    }
    for (const check of personnel) {
      if (check.qualified.length === 0) stops.push(`${check.procedure}: ${check.detail}`);
      else if (check.qualified.length === 1) notes.push(`${check.procedure}: only ${check.qualified[0].name} is trained and available.`);
    }
    const limitations = [...stops, ...notes];

    const itemsOk = items.every((c) => c.outcome === 'available' || c.outcome === 'alternative');
    const peopleOk = personnel.every((c) => c.qualified.length > 0);
    const withheld = step.requiresPreauthorization && !plan.drugsPreauthorized;
    let readiness: StepCheck['readiness'];
    if (withheld) readiness = 'needs_authorization';
    else if (!specified) readiness = 'unspecified';
    else if (!itemsOk || !peopleOk) readiness = 'blocked';
    else if (items.length === 0 && personnel.length === 0) readiness = 'no_resources';
    else readiness = limitations.length > 0 ? 'ready_with_limits' : 'ready';

    if (withheld) limitations.unshift('Medication step: the mission medical plan does not pre-authorize drugs, so it stays withheld whatever is on board.');
    if (!specified) limitations.unshift('The protocol does not say which resources this step uses, so they cannot be checked here.');
    return { index, step, readiness, items, personnel, limitations, escalate: step.authorityLevel === 4 || readiness === 'blocked' };
  });

  const allItems = steps.flatMap((s) => s.items);
  const unique = <T,>(list: T[], key: (entry: T) => string): T[] => [...new Map(list.map((entry) => [key(entry), entry])).values()];
  const escalations: string[] = [];
  for (const s of steps) {
    const label = `Step ${s.index + 1}`;
    if (s.step.authorityLevel === 4) escalations.push(`${label} is itself an escalation: ${s.step.text}`);
    else if (s.readiness === 'blocked') escalations.push(`${label} cannot be carried out with what is on board. Tell the responsible medical staff: ${s.limitations[0] ?? s.step.text}`);
    else if (s.readiness === 'needs_authorization') escalations.push(`${label} needs authorization under the medical plan before anything is given.`);
  }
  return {
    ruleId: rule.id,
    condition: rule.condition,
    steps,
    available: unique(allItems.filter((c) => c.outcome === 'available' || c.outcome === 'alternative'), (c) => c.need.typeCode),
    missing: unique(allItems.filter((c) => c.outcome === 'missing' || c.outcome === 'insufficient'), (c) => c.need.typeCode),
    nonOperational: unique(allItems.filter((c) => c.outcome === 'unusable'), (c) => c.need.typeCode),
    personnel: unique(steps.flatMap((s) => s.personnel), (c) => c.need.code),
    limitations: [...new Set(steps.flatMap((s) => s.limitations))],
    executable: steps.filter((s) => s.readiness === 'ready' || s.readiness === 'ready_with_limits' || s.readiness === 'no_resources'),
    escalations,
  };
}
