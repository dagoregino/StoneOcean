import { INDICATOR_LIST, INDICATORS } from './catalog/indicators';
import type { IndicatorId, MissionMinutes, SystemId } from './types';

/**
 * Discomfort reported by the crew member on the body itself: where it is, how strong, what kind.
 *
 * A report is an observation in the mission log. It never changes a status, a threshold or
 * the triage: the rules engine has no validated rule that turns "pain here" into a finding,
 * and this module does not invent one.
 */

/** A point on the body, in the body's own frame: metres, feet at y = 0, facing +z, left side at +x. */
export interface BodyPoint {
  x: number;
  y: number;
  z: number;
}

export const SYMPTOM_TYPES = ['sharp_pain', 'pressure', 'muscle_fatigue', 'dizziness', 'paresthesia', 'other'] as const;
export type SymptomType = (typeof SYMPTOM_TYPES)[number];

export const SYMPTOM_TYPE_LABEL: Record<SymptomType, string> = {
  sharp_pain: 'Sharp pain',
  pressure: 'Pressure / heaviness',
  muscle_fatigue: 'Muscle fatigue',
  dizziness: 'Dizziness / disorientation',
  paresthesia: 'Tingling / numbness',
  other: 'Other',
};

/** Numeric rating scale: 1 is barely noticeable, 10 is the worst imaginable. */
export const SYMPTOM_INTENSITY = { min: 1, max: 10, initial: 5 } as const;
export const SYMPTOM_NOTES_MAX = 280;

/** A spot picked on the body, before the form is filled in. */
export interface SymptomDraft {
  position: BodyPoint;
  /** Body systems under the picked spot, most relevant first. Never empty. */
  systems: SystemId[];
}

export interface SymptomInput {
  systemId: SystemId;
  position: BodyPoint;
  intensity: number;
  type: SymptomType;
  notes?: string;
  /**
   * Self-checks the crew member chose to add to this report, for example after a suggestion
   * from the notes (see `noteSuggestions.ts`). Only ever what they ticked themselves.
   */
  confirmedSelfChecks?: readonly IndicatorId[];
}

export interface SymptomReport {
  id: number;
  /** Mission time at which it was reported. */
  t: MissionMinutes;
  systemId: SystemId;
  position: BodyPoint;
  /** Whole number, 1 to 10. */
  intensity: number;
  type: SymptomType;
  notes: string;
  /** Self-checks worth logging alongside this report (see `relatedSelfChecks`), plus any the crew member confirmed. */
  relatedSelfChecks: IndicatorId[];
}

/**
 * Self-checks to suggest with a report. Only two links are used, and neither is a clinical
 * inference: the self-checks the catalog already files under the reported body system, and
 * the dizziness score when dizziness is what was reported.
 */
export function relatedSelfChecks(systemId: SystemId, type: SymptomType): IndicatorId[] {
  const ids = INDICATOR_LIST.filter((def) => def.acquisition === 'self-check' && def.systemId === systemId).map((def) => def.id);
  if (type === 'dizziness' && !ids.includes('dizziness')) ids.push('dizziness');
  return ids;
}

/** Adds the self-checks the crew member confirmed, once each. Anything that is not a self-check is ignored. */
function withConfirmed(ids: IndicatorId[], confirmed: readonly IndicatorId[] = []): IndicatorId[] {
  for (const id of confirmed) {
    if (INDICATORS[id]?.acquisition === 'self-check' && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Builds a report from form input. Throws when the input cannot be a real report. */
export function createSymptomReport(id: number, t: MissionMinutes, input: SymptomInput): SymptomReport {
  const { x, y, z } = input.position;
  if (![x, y, z, input.intensity].every(Number.isFinite)) throw new RangeError('Symptom report: position and intensity must be finite numbers.');
  if (!SYMPTOM_TYPES.includes(input.type)) throw new RangeError(`Symptom report: unknown type "${String(input.type)}".`);
  return {
    id,
    t,
    systemId: input.systemId,
    position: { x, y, z },
    intensity: Math.min(SYMPTOM_INTENSITY.max, Math.max(SYMPTOM_INTENSITY.min, Math.round(input.intensity))),
    type: input.type,
    notes: (input.notes ?? '').replace(/\s+/g, ' ').trim().slice(0, SYMPTOM_NOTES_MAX),
    relatedSelfChecks: withConfirmed(relatedSelfChecks(input.systemId, input.type), input.confirmedSelfChecks),
  };
}
