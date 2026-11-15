/**
 * Domain model. Pure TypeScript: nothing in `domain/` may import three.js or touch the DOM,
 * so the rules can be unit-tested and reused with any renderer or data source.
 */

export const STATUSES = ['unknown', 'nominal', 'caution', 'critical'] as const;
export type HealthStatus = (typeof STATUSES)[number];

export const SYSTEM_IDS = [
  'cardiovascular',
  'skeletal',
  'muscular',
  'respiratory',
  'neuro',
  'sensory',
  'immune',
  'metabolic',
  'radiation',
] as const;
export type SystemId = (typeof SYSTEM_IDS)[number];

export type IndicatorId =
  | 'heartRate'
  | 'systolicBP'
  | 'resistiveExercise'
  | 'aerobicExercise'
  | 'spo2'
  | 'sleepHours'
  | 'mood'
  | 'visionChange'
  | 'dizziness'
  | 'bodyTemp'
  | 'glucose'
  | 'calorieIntake'
  | 'radiationDose'
  | 'ppCO2'
  | 'retinalThickness'
  | 'protonFlux';

/** NASA Human Research Program: the five hazards of human spaceflight. */
export type HazardId = 'radiation' | 'isolation' | 'distance' | 'gravity' | 'environment';

export type EnvironmentId = 'iss' | 'lunar' | 'transit' | 'mars';

/** Inclusive numeric range. Use +/-Infinity for an open end. */
export interface Range {
  min: number;
  max: number;
}

/**
 * A value inside `nominal` is nominal; otherwise inside `caution` is caution;
 * anything else is critical. `caution` therefore always encloses `nominal`.
 */
export interface Thresholds {
  nominal: Range;
  caution: Range;
}

export interface IndicatorDef {
  id: IndicatorId;
  systemId: SystemId;
  name: string;
  unit: string;
  decimals: number;
  /** `sensor` = streamed by a wearable or instrument; `self-check` = the astronaut measures and logs it. */
  acquisition: 'sensor' | 'self-check';
  /** How often a fresh value is expected. Older than this = measurement due. */
  cadenceHours: number;
  /** Axis range used by charts and input validation. */
  display: Range;
  thresholds: Thresholds;
  whyItMatters: string;
  howToMeasure: string;
  guidance: { caution: string[]; critical: string[] };
  /** Where the reference range comes from. */
  reference: string;
}

export interface ResourceLink {
  name: string;
  url: string;
}

export interface SystemDef {
  id: SystemId;
  name: string;
  /** One line: what this system does. */
  role: string;
  /** How spaceflight affects it. */
  spaceflightEffect: string;
  hazards: HazardId[];
  risks: ResourceLink[];
}

/** Mission time is expressed in minutes since mission start. */
export type MissionMinutes = number;

export interface Reading {
  indicatorId: IndicatorId;
  value: number;
  t: MissionMinutes;
  source: 'simulated' | 'manual' | 'sensor';
}

export interface EnvironmentDef {
  id: EnvironmentId;
  name: string;
  shortName: string;
  description: string;
  gravityG: number;
  /** One-way signal delay to Earth, in seconds. */
  commsDelaySec: number;
  /**
   * Seconds a consultation spends outside light travel, once per round trip: relays, ground
   * stations and the time to read a short summary and answer. A demo assumption, not mission data.
   */
  linkHandlingSec: number;
  /** Typical dose rate in mSv/day (approximate published values). */
  radiationMSvPerDay: number;
  radiationReference: string;
  /** Optional per-environment threshold overrides (mission-configurable). */
  thresholdOverrides?: Partial<Record<IndicatorId, Thresholds>>;
}

/** The rule that put an indicator out of its nominal status, when it is judged against the baseline. */
export type DriftTrigger = 'single_value' | 'ewma' | 'cusum';

/** How an indicator stands against the person's own baseline. */
export interface DriftSummary {
  status: HealthStatus;
  /** Rule behind a caution or critical status; null when nominal. */
  trigger: DriftTrigger | null;
  /** Which direction of change counts as a problem. */
  direction: 'low' | 'high' | 'both';
  baselineMean: number;
  /** Predictive standard deviation of one daily value. */
  baselineSd: number;
  baselineDays: number;
  baselineUntil: MissionMinutes;
  /** Where 95% of the person's days fall, on the side that counts as a problem. */
  usualRange: Range;
  /** Single-value limits as bands: beyond `nominal` is caution, beyond `caution` is critical. */
  bands: Thresholds;
  /** The value now: latest daily measurement, or the mean of the last 24 hours for a sensor. */
  current: { t: MissionMinutes; value: number; z: number } | null;
  singleValueCautionLimit: number;
  singleValueCriticalLimit: number;
  /** Daily values since the baseline (or since the last treatment), with their z-scores. */
  series: { t: MissionMinutes; value: number; z: number }[];
  ewma: number;
  ewmaCautionLimit: number;
  ewmaCriticalLimit: number;
  /** CUSUM sum in the adverse direction. */
  cusum: number;
  cusumCautionLimit: number;
  cusumCriticalLimit: number;
  /** True after a treatment, until a first value has been measured since. */
  awaitingFirstValue: boolean;
}

export interface IndicatorEvaluation {
  def: IndicatorDef;
  latest: Reading | null;
  status: HealthStatus;
  /** True when no reading exists or the latest one is older than the cadence. */
  due: boolean;
  /** Change per mission day, from a least-squares fit of recent readings. */
  trendPerDay: number | null;
  /** True when the trend projects a worse status within the look-ahead window. */
  worsening: boolean;
  /** Present when the status comes from the individual baseline instead of a fixed range. */
  drift?: DriftSummary;
}

export interface SystemEvaluation {
  def: SystemDef;
  status: HealthStatus;
  indicators: IndicatorEvaluation[];
  /** The indicator that sets the system status (the worst one). */
  driver: IndicatorEvaluation | null;
}

export type TriageLevel = 'nominal' | 'self-care' | 'crew-medical' | 'ground-consult';

export interface Triage {
  level: TriageLevel;
  status: HealthStatus;
  headline: string;
  detail: string;
  /** Systems that need attention, worst first. */
  systems: SystemId[];
}

export interface Evaluation {
  missionTime: MissionMinutes;
  systems: Record<SystemId, SystemEvaluation>;
  triage: Triage;
  /** Self-check indicators whose measurement is due. */
  due: IndicatorEvaluation[];
}
