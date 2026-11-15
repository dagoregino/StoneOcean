import { RULES } from '../evidence/catalog';
import type { TrainingLevel } from './types';

/**
 * SIMULATED MISSION CONFIGURATION.
 *
 * What each step of an approved protocol needs on board: which kinds of item, how many,
 * and which trained procedure. In a real mission this table is written and signed off by
 * the flight surgeon together with the medical plan; it is not derived by software.
 *
 * The entries below are a demonstration. They only name what the text of the step itself
 * calls for (the OCT in "Run the OCT and vision tests", compression garments in "Wear the
 * compression garments"). Where a step does not say what it uses, nothing is listed and
 * the app says so, instead of guessing. An alternative is listed only where the project's
 * own guidance already offers it.
 */

/** A procedure someone must be trained for. Codes are stable; names are for people. */
export const PROCEDURES = [
  { code: 'cmo-checklist', name: 'Medical checklist as Crew Medical Officer' },
  { code: 'vital-signs', name: 'Take and interpret vital signs' },
  { code: 'oct-exam', name: 'Retinal OCT examination' },
  { code: 'lbnp-operation', name: 'Operate lower body negative pressure' },
  { code: 'wound-care', name: 'Wound care and dressing' },
  { code: 'basic-life-support', name: 'Basic life support and defibrillator' },
  { code: 'airway-management', name: 'Airway management' },
  { code: 'medication-administration', name: 'Give medication from the medical plan' },
  { code: 'exercise-device-setup', name: 'Set up and inspect exercise devices' },
] as const;
export type ProcedureCode = (typeof PROCEDURES)[number]['code'];

const procedureNames = new Map<string, string>(PROCEDURES.map((p) => [p.code, p.name]));
export const procedureName = (code: string): string => procedureNames.get(code) ?? code;

export interface ItemNeed {
  /** Kind of item (`Resource.typeCode`). */
  typeCode: string;
  /** What to call it when none is registered. */
  label: string;
  quantity: number;
  /** Other kinds the approved protocol itself accepts in its place. Never filled in by the software. */
  approvedAlternatives?: { typeCode: string; label: string }[];
}

export interface ProcedureNeed {
  code: ProcedureCode;
  minLevel: TrainingLevel;
}

export interface StepNeeds {
  items: ItemNeed[];
  procedures: ProcedureNeed[];
  /** False when the protocol does not say what the step uses, so nothing can be checked. */
  specified: boolean;
}

const need = (items: ItemNeed[] = [], procedures: ProcedureNeed[] = []): StepNeeds => ({ items, procedures, specified: true });
const item = (typeCode: string, label: string, quantity = 1, approvedAlternatives?: ItemNeed['approvedAlternatives']): ItemNeed => ({ typeCode, label, quantity, approvedAlternatives });
const NONE = need();
const UNSPECIFIED: StepNeeds = { items: [], procedures: [], specified: false };
const operator = (code: ProcedureCode): ProcedureNeed => ({ code, minLevel: 'operator' });

/** Rule id -> one entry per treatment step, in the order of the rule's `treat` list. */
const REQUIREMENTS: Record<string, StepNeeds[]> = {
  'R-SANS': [
    NONE,
    need([item('oct-scanner', 'OCT retinal scanner')], [operator('oct-exam')]),
    UNSPECIFIED,
    need([], [operator('cmo-checklist')]),
  ],
  'R-BONE': [
    need([item('resistive-exercise-device', 'Resistive exercise device')], [{ code: 'exercise-device-setup', minLevel: 'awareness' }]),
    need([item('vitamin-d', 'Vitamin D supplement')]),
    need([item('bisphosphonate', 'Bisphosphonate')], [operator('medication-administration')]),
  ],
  'R-MUSCLE': [
    need(
      [item('resistive-exercise-device', 'Resistive exercise device'), item('treadmill', 'Treadmill', 1, [{ typeCode: 'cycle-ergometer', label: 'Cycle ergometer' }])],
      [{ code: 'exercise-device-setup', minLevel: 'awareness' }],
    ),
    NONE,
  ],
  'R-ORTHO': [
    need([item('salt-tablets', 'Salt tablets', 2)]),
    need([item('compression-garment', 'Compression garment')]),
    need([item('lbnp-device', 'Lower body negative pressure device')], [operator('lbnp-operation')]),
  ],
  'R-CO2': [NONE, NONE, NONE, need([item('analgesic', 'Analgesic')], [operator('medication-administration')])],
  'R-IMMUNE': [
    need([item('thermometer', 'Thermometer')], [{ code: 'vital-signs', minLevel: 'awareness' }]),
    need([item('disinfectant-wipes', 'Disinfectant wipes', 4), item('face-mask', 'Face mask', 2)]),
    need([item('antiviral', 'Antiviral')], [operator('medication-administration')]),
  ],
  'R-SLEEP': [NONE, NONE, NONE, need([item('sleep-aid', 'Sleep medication')], [operator('medication-administration')])],
  'R-RADIATION': [NONE, NONE, need([item('personal-dosimeter', 'Personal dosimeter')])],
  'R-MEDICAL': [
    need([item('blood-pressure-monitor', 'Blood pressure monitor'), item('pulse-oximeter', 'Pulse oximeter')], [operator('cmo-checklist')]),
    UNSPECIFIED,
    need(
      [item('defibrillator', 'Automated external defibrillator'), item('emergency-oxygen', 'Emergency oxygen'), item('airway-kit', 'Airway kit')],
      [operator('basic-life-support'), operator('airway-management')],
    ),
  ],
  'R-MINOR': [
    need([item('wound-dressing', 'Sterile wound dressing', 2), item('antiseptic-wipes', 'Antiseptic wipes', 2), item('exam-gloves', 'Examination gloves', 2)], [operator('wound-care')]),
    UNSPECIFIED,
  ],
  'R-NUTRITION': [NONE, NONE],
};

/** What each step of a rule needs. Rules or steps with no entry are reported as unspecified. */
export function needsOf(ruleId: string): StepNeeds[] {
  const rule = RULES.find((r) => r.id === ruleId);
  const listed = REQUIREMENTS[ruleId] ?? [];
  return (rule?.treat ?? []).map((_, index) => listed[index] ?? UNSPECIFIED);
}

/** Every kind of item a protocol can ask for: suggestions when registering a record. */
export function knownItemTypes(): { typeCode: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const steps of Object.values(REQUIREMENTS)) {
    for (const step of steps) {
      for (const it of step.items) {
        seen.set(it.typeCode, it.label);
        it.approvedAlternatives?.forEach((alt) => seen.set(alt.typeCode, alt.label));
      }
    }
  }
  return [...seen].map(([typeCode, label]) => ({ typeCode, label })).sort((a, b) => a.label.localeCompare(b.label));
}
