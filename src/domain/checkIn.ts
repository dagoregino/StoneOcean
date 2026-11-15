import { INDICATOR_LIST } from './catalog/indicators';
import { offerSteps, type MedicalPlan } from './medicalPlan';
import { severity } from './status';
import type { Intervention } from './engine/verify';
import type { Evaluation, IndicatorDef, IndicatorId, MissionMinutes, Reading, Thresholds } from './types';

/**
 * The daily check-in: what changed since yesterday, three quick answers, and the plan for
 * the day. It reads what the app already holds. The answers are kept as the crew member
 * gave them: they are not turned into readings, and they change no status.
 */

export const SLEEP_ANSWERS = ['poor', 'okay', 'good'] as const;
export const MOOD_ANSWERS = ['low', 'okay', 'good'] as const;
export type SleepAnswer = (typeof SLEEP_ANSWERS)[number];
export type MoodAnswer = (typeof MOOD_ANSWERS)[number];
export const ANSWER_LABEL: Record<SleepAnswer | MoodAnswer, string> = { poor: 'Poor', low: 'Low', okay: 'Okay', good: 'Good' };

export interface DailyCheckInInput {
  sleep: SleepAnswer;
  mood: MoodAnswer;
  discomfort: boolean;
}
export interface DailyCheckIn extends DailyCheckInInput {
  id: number;
  t: MissionMinutes;
}

const DAY = 1440;
/**
 * A difference between two days counts as a change only beyond the person's own day-to-day
 * variation: 2.5 standard deviations of their baseline. Where there is no baseline yet,
 * 5% of the indicator's scale stands in.
 */
const BASELINE_SDS = 2.5;
const SCALE_FRACTION = 0.05;

export interface DailyChange {
  def: IndicatorDef;
  /** Mean of the last 24 hours and of the 24 hours before them. */
  today: number;
  yesterday: number;
  delta: number;
  /** "↓ 1.2 h", "+4 bpm". */
  label: string;
}

const mean = (readings: readonly Reading[], from: MissionMinutes, to: MissionMinutes): number | null => {
  let sum = 0;
  let count = 0;
  for (const r of readings) {
    if (r.t > from && r.t <= to) {
      sum += r.value;
      count++;
    }
  }
  return count > 0 ? sum / count : null;
};

/**
 * What moved since yesterday, largest first, at most `limit`. A change is listed only when
 * both days have readings and the difference is beyond noise; an empty list is a real answer.
 */
export function changesSinceYesterday(history: (id: IndicatorId) => readonly Reading[], now: MissionMinutes, baselineSd: (id: IndicatorId) => number | undefined = () => undefined, limit = 3): DailyChange[] {
  const changes: (DailyChange & { weight: number })[] = [];
  for (const def of INDICATOR_LIST) {
    // A running total (cumulative dose) always grows: comparing two days of it says nothing.
    if (def.id === 'radiationDose') continue;
    const readings = history(def.id);
    const today = mean(readings, now - DAY, now);
    const yesterday = mean(readings, now - 2 * DAY, now - DAY);
    if (today === null || yesterday === null) continue;
    const delta = today - yesterday;
    const span = def.display.max - def.display.min;
    const sd = baselineSd(def.id);
    // The difference of two days varies more than one day does (by √2), so the bar is set on the difference.
    if (Math.abs(delta) < (sd !== undefined ? sd * BASELINE_SDS * Math.SQRT2 : span * SCALE_FRACTION)) continue;
    const amount = Math.abs(delta).toFixed(Math.max(1, def.decimals));
    changes.push({ def, today, yesterday, delta, label: `${delta > 0 ? '↑' : '↓'} ${amount}${def.unit ? ` ${def.unit}` : ''}`, weight: Math.abs(delta) / span });
  }
  return changes.sort((a, b) => b.weight - a.weight).slice(0, limit).map(({ weight: _weight, ...change }) => change);
}

export type PlanKind = 'protocol' | 'verify' | 'self-check' | 'target' | 'monitor';
export const PLAN_KIND_LABEL: Record<PlanKind, string> = {
  protocol: 'Onboard protocol',
  verify: 'Verification',
  'self-check': 'Self-check due',
  target: 'Daily target',
  monitor: 'Keep an eye on',
};

export interface PlanItem {
  kind: PlanKind;
  text: string;
  indicatorId?: IndicatorId;
}

/**
 * The plan for the day, assembled from tasks that already exist: the first step of any
 * active protocol, treatments waiting to be verified, self-checks that are due, the daily
 * exercise targets, and indicators heading out of range. It adds no task of its own.
 */
export function planForToday(evaluation: Evaluation, interventions: readonly Intervention[], plan: MedicalPlan, thresholdsOf: (def: IndicatorDef) => Thresholds): PlanItem[] {
  const items: PlanItem[] = [];
  const indicators = Object.values(evaluation.systems).flatMap((system) => system.indicators);

  const flagged = Object.values(evaluation.systems)
    .filter((system) => severity(system.status) >= severity('caution') && system.driver)
    .sort((a, b) => severity(b.status) - severity(a.status));
  for (const system of flagged) {
    const driver = system.driver!;
    const status = driver.status === 'critical' ? 'critical' : 'caution';
    const first = offerSteps(driver.def.guidance[status], plan).find((step) => !step.withheld);
    if (first) items.push({ kind: 'protocol', indicatorId: driver.def.id, text: `${system.def.name}: ${first.text}` });
  }
  for (const intervention of interventions) {
    if (intervention.outcome !== 'pending') continue;
    const def = indicators.find((i) => i.def.id === intervention.indicatorId)?.def;
    if (def) items.push({ kind: 'verify', indicatorId: def.id, text: `Measure ${def.name.toLowerCase()} again to verify “${intervention.stepText}”` });
  }
  for (const due of evaluation.due) items.push({ kind: 'self-check', indicatorId: due.def.id, text: `${due.def.name} (every ${due.def.cadenceHours} h)` });
  for (const id of ['resistiveExercise', 'aerobicExercise'] as const) {
    const indicator = indicators.find((i) => i.def.id === id);
    if (!indicator) continue;
    const { min } = thresholdsOf(indicator.def).nominal;
    if (!Number.isFinite(min)) continue;
    const latest = indicator.latest ? `; last recorded ${indicator.latest.value.toFixed(indicator.def.decimals)}` : '';
    items.push({ kind: 'target', indicatorId: id, text: `${indicator.def.name}: at least ${min} ${indicator.def.unit}${latest}` });
  }
  for (const indicator of indicators) {
    if (indicator.worsening) items.push({ kind: 'monitor', indicatorId: indicator.def.id, text: `${indicator.def.name} is heading out of range` });
  }
  return items;
}
