import { ENVIRONMENTS } from '../domain/catalog/environments';
import { INDICATOR_LIST, INDICATORS } from '../domain/catalog/indicators';
import { evaluateAll, thresholdsFor, type MonitoringContext } from '../domain/engine/evaluate';
import { fitIndividualBaseline, usesIndividualBaseline, type IndividualBaseline } from '../domain/engine/monitor';
import { advanceConsult, buildConsultRequest, consultReason, createConsult, isConsultActive, type ConsultPhase, type ConsultReason, type FlightSurgeonConsult } from '../domain/consult';
import { verifyIntervention, type Intervention } from '../domain/engine/verify';
import { INDICATOR_RULES } from '../domain/evidence/indicatorRules';
import type { AuthorityLevel } from '../domain/evidence/types';
import { DEFAULT_MEDICAL_PLAN, type MedicalPlan } from '../domain/medicalPlan';
import { showsAnatomy, type TwinView } from '../domain/twinView';
import { createSymptomReport, type SymptomDraft, type SymptomInput, type SymptomReport } from '../domain/symptoms';
import type {
  EnvironmentDef,
  EnvironmentId,
  Evaluation,
  IndicatorId,
  MissionMinutes,
  Reading,
  SystemId,
} from '../domain/types';
import { Emitter } from './Emitter';
import type { SpaceWeather } from './spaceWeather';

const MAX_READINGS_PER_INDICATOR = 1200;

export interface StoreEvents extends Record<string, unknown> {
  /** New readings arrived or mission time advanced; carries the fresh evaluation. */
  data: Evaluation;
  selection: SystemId | null;
  hover: SystemId | null;
  environment: EnvironmentDef;
  visibility: ReadonlySet<SystemId>;
  /** An intervention was started or its verification changed. */
  interventions: readonly Intervention[];
  medicalPlan: MedicalPlan;
  /** Real space weather was loaded or refreshed. */
  spaceWeather: SpaceWeather;
  /** A discomfort report was added or removed. */
  symptoms: readonly SymptomReport[];
  /** "Report discomfort" was switched on or off: clicks on the body mark a spot instead of selecting. */
  reportMode: boolean;
  /** A spot was picked on the body and awaits its form (or was dropped: null). */
  symptomDraft: SymptomDraft | null;
  /** The twin is shown differently: astronaut, scan or anatomy. */
  twinView: TwinView;
  /** A flight surgeon consultation was requested or moved to its next phase. */
  consults: readonly FlightSurgeonConsult[];
}

/** Anything that produces readings writes them here. */
export interface ReadingSink {
  ingest(readings: Reading[], now: MissionMinutes): void;
}

/**
 * Single source of truth. Data flows one way:
 *   sources -> store.ingest() -> rules engine -> `data` event -> 3D scene and UI panels.
 * Views never talk to each other; they only read the store and call its actions.
 */
export class HealthStore implements ReadingSink {
  readonly events = new Emitter<StoreEvents>();

  private readonly readings = new Map<IndicatorId, Reading[]>();
  private env: EnvironmentDef;
  private now: MissionMinutes = 0;
  private selectedSystem: SystemId | null = null;
  private hoveredSystem: SystemId | null = null;
  private readonly hiddenSystems = new Set<SystemId>();
  private current: Evaluation;
  private readonly interventionLog: Intervention[] = [];
  private plan: MedicalPlan = { ...DEFAULT_MEDICAL_PLAN };
  private weather: SpaceWeather | null = null;
  private readonly symptomLog: SymptomReport[] = [];
  private symptomSeq = 0;
  private reporting = false;
  private draft: SymptomDraft | null = null;
  private view: TwinView = 'astronaut';
  private readonly consultLog: FlightSurgeonConsult[] = [];
  /** Individual baselines, fitted once per indicator and then frozen. */
  private readonly baselines = new Map<IndicatorId, IndividualBaseline>();

  constructor(environment: EnvironmentId = 'iss') {
    this.env = ENVIRONMENTS[environment];
    this.current = evaluateAll(this.readings, this.env, this.now);
  }

  // ---- queries ----
  get evaluation(): Evaluation {
    return this.current;
  }
  get environment(): EnvironmentDef {
    return this.env;
  }
  get missionTime(): MissionMinutes {
    return this.now;
  }
  get selected(): SystemId | null {
    return this.selectedSystem;
  }
  get hovered(): SystemId | null {
    return this.hoveredSystem;
  }
  get hidden(): ReadonlySet<SystemId> {
    return this.hiddenSystems;
  }
  history(id: IndicatorId): readonly Reading[] {
    return this.readings.get(id) ?? [];
  }
  get interventions(): readonly Intervention[] {
    return this.interventionLog;
  }
  get medicalPlan(): MedicalPlan {
    return this.plan;
  }
  /** Real space weather (NOAA SWPC, NASA DONKI); null until it has been loaded. */
  get spaceWeather(): SpaceWeather | null {
    return this.weather;
  }
  /** Flight surgeon consultations, oldest first, each with its own history of events. */
  get consults(): readonly FlightSurgeonConsult[] {
    return this.consultLog;
  }
  /** The consultation still waiting for its answer, if any (one at a time). */
  get activeConsult(): FlightSurgeonConsult | null {
    const last = this.consultLog[this.consultLog.length - 1];
    return last && isConsultActive(last) ? last : null;
  }
  /** Why the ground should be consulted now; null when the crew can handle it on board. */
  get consultReason(): ConsultReason | null {
    return consultReason(this.current, this.interventionLog);
  }
  /** Discomfort reported on the body, oldest first. */
  get symptoms(): readonly SymptomReport[] {
    return this.symptomLog;
  }
  get twinView(): TwinView {
    return this.view;
  }
  get reportMode(): boolean {
    return this.reporting;
  }
  get symptomDraft(): SymptomDraft | null {
    return this.draft;
  }
  /** The crew member's own baseline for an indicator, once enough days have been recorded. */
  baselineOf(id: IndicatorId): IndividualBaseline | undefined {
    return this.baselines.get(id);
  }
  /** The most recent intervention for an indicator, if any. */
  latestIntervention(id: IndicatorId): Intervention | undefined {
    for (let i = this.interventionLog.length - 1; i >= 0; i--) {
      if (this.interventionLog[i].indicatorId === id) return this.interventionLog[i];
    }
    return undefined;
  }

  // ---- actions ----
  ingest(readings: Reading[], now: MissionMinutes): void {
    for (const r of readings) {
      let list = this.readings.get(r.indicatorId);
      if (!list) {
        list = [];
        this.readings.set(r.indicatorId, list);
      }
      list.push(r);
      if (list.length > MAX_READINGS_PER_INDICATOR) list.splice(0, list.length - MAX_READINGS_PER_INDICATOR);
    }
    this.now = Math.max(this.now, now);
    this.recompute();
  }

  setEnvironment(id: EnvironmentId): void {
    if (this.env.id === id) return;
    this.env = ENVIRONMENTS[id];
    this.events.emit('environment', this.env);
    this.recompute();
  }

  select(id: SystemId | null): void {
    if (this.selectedSystem === id) return;
    this.selectedSystem = id;
    // Looking at one body system means looking at the anatomy, wherever the selection came from.
    if (id !== null) this.setTwinView('anatomy');
    this.events.emit('selection', id);
  }

  /** Changes how the twin is shown. Going back to the astronaut puts away everything that needs the anatomy. */
  setTwinView(view: TwinView): void {
    if (this.view === view) return;
    this.view = view;
    if (!showsAnatomy(view)) {
      this.setReportMode(false);
      this.hover(null);
      this.select(null);
    }
    this.events.emit('twinView', view);
  }

  hover(id: SystemId | null): void {
    if (this.hoveredSystem === id) return;
    this.hoveredSystem = id;
    this.events.emit('hover', id);
  }

  toggleVisibility(id: SystemId): void {
    if (this.hiddenSystems.has(id)) this.hiddenSystems.delete(id);
    else this.hiddenSystems.add(id);
    this.events.emit('visibility', this.hiddenSystems);
  }

  /**
   * Records that the crew member carried out a treatment step. It stays pending until the
   * Verify step sees the indicator measured back in range (see domain/engine/verify.ts).
   */
  startIntervention(indicatorId: IndicatorId, stepText: string, authorityLevel: AuthorityLevel): Intervention {
    const evaluation = this.current.systems[INDICATORS[indicatorId].systemId].indicators.find((i) => i.def.id === indicatorId);
    const intervention: Intervention = {
      id: this.interventionLog.length + 1,
      indicatorId,
      ruleId: INDICATOR_RULES[indicatorId].ruleId,
      stepText,
      authorityLevel,
      startedAt: this.now,
      // Against the baseline the comparison is between days, so the day's value is what is recorded.
      valueBefore: evaluation?.drift?.current?.value ?? evaluation?.latest?.value ?? null,
      statusBefore: evaluation?.status ?? 'unknown',
      outcome: 'pending',
      valueAfter: null,
      checkedAt: null,
    };
    this.interventionLog.push(intervention);
    this.events.emit('interventions', this.interventionLog);
    // The drift detectors restart at the treatment, so the status has to be worked out again.
    this.recompute();
    return intervention;
  }

  setReportMode(enabled: boolean): void {
    if (this.reporting === enabled) return;
    this.reporting = enabled;
    if (!enabled) this.setSymptomDraft(null);
    // A spot can only be marked on a body that is on show.
    else if (!showsAnatomy(this.view)) this.setTwinView('scan');
    this.events.emit('reportMode', enabled);
  }

  setSymptomDraft(draft: SymptomDraft | null): void {
    if (this.draft === draft) return;
    this.draft = draft;
    this.events.emit('symptomDraft', draft);
  }

  /**
   * Adds a discomfort report to the mission log. It is an observation: no status, threshold
   * or triage level changes because of it.
   */
  reportSymptom(input: SymptomInput): SymptomReport {
    const report = createSymptomReport(++this.symptomSeq, this.now, input);
    this.symptomLog.push(report);
    this.events.emit('symptoms', this.symptomLog);
    this.setReportMode(false);
    return report;
  }

  removeSymptom(id: number): void {
    const index = this.symptomLog.findIndex((report) => report.id === id);
    if (index < 0) return;
    this.symptomLog.splice(index, 1);
    this.events.emit('symptoms', this.symptomLog);
  }

  /**
   * "Send to Flight Surgeon": packs the current state into a summary and opens a consultation.
   * Only when the situation calls for it and none is already on its way. Statuses, thresholds
   * and the triage are not touched.
   * @param startedAtMs wall-clock time of the press, for the countdown
   */
  requestConsult(startedAtMs: number): FlightSurgeonConsult | null {
    const reason = this.consultReason;
    if (!reason || this.activeConsult) return null;
    const request = buildConsultRequest(this.current, reason, { interventions: this.interventionLog, symptoms: this.symptomLog, plan: this.plan });
    const consult = createConsult(this.consultLog.length + 1, this.now, startedAtMs, this.env, request);
    this.consultLog.push(consult);
    this.events.emit('consults', this.consultLog);
    return consult;
  }

  /** The link reached `phase` (see `data/GroundLink.ts`). The answer arrives with `received`. */
  advanceConsult(id: number, phase: ConsultPhase): void {
    const index = this.consultLog.findIndex((c) => c.id === id);
    if (index < 0) return;
    const next = advanceConsult(this.consultLog[index], phase);
    if (next === this.consultLog[index]) return;
    this.consultLog[index] = next;
    this.events.emit('consults', this.consultLog);
  }

  setSpaceWeather(weather: SpaceWeather): void {
    this.weather = weather;
    this.events.emit('spaceWeather', weather);
  }

  setDrugsPreauthorized(drugsPreauthorized: boolean): void {
    if (this.plan.drugsPreauthorized === drugsPreauthorized) return;
    this.plan = { ...this.plan, drugsPreauthorized };
    this.events.emit('medicalPlan', this.plan);
  }

  reset(now: MissionMinutes): void {
    this.readings.clear();
    this.baselines.clear();
    this.interventionLog.length = 0;
    this.symptomLog.length = 0;
    this.consultLog.length = 0;
    this.now = now;
    this.events.emit('interventions', this.interventionLog);
    this.events.emit('symptoms', this.symptomLog);
    this.events.emit('consults', this.consultLog);
    this.setReportMode(false);
    this.recompute();
  }

  private recompute(): void {
    this.current = evaluateAll(this.readings, this.env, this.now, this.monitoring());
    this.verifyPending();
    this.events.emit('data', this.current);
  }

  /** Fits any baseline that has just become possible and pairs each with its last treatment. */
  private monitoring(): Map<IndicatorId, MonitoringContext> {
    const context = new Map<IndicatorId, MonitoringContext>();
    for (const def of INDICATOR_LIST) {
      if (!usesIndividualBaseline(def.id)) continue;
      let baseline = this.baselines.get(def.id);
      if (!baseline) {
        const fitted = fitIndividualBaseline(def, this.history(def.id), this.now);
        if (!fitted) continue;
        baseline = fitted;
        this.baselines.set(def.id, fitted);
      }
      context.set(def.id, { baseline, resetAt: this.latestIntervention(def.id)?.startedAt ?? null });
    }
    return context;
  }

  private verifyPending(): void {
    let changed = false;
    for (const intervention of this.interventionLog) {
      if (intervention.outcome !== 'pending') continue;
      const def = INDICATORS[intervention.indicatorId];
      const result = verifyIntervention(intervention, def, this.history(def.id), thresholdsFor(def, this.env), this.now, this.baselines.get(def.id));
      if (result.outcome !== 'pending') {
        Object.assign(intervention, result);
        changed = true;
      }
    }
    if (changed) this.events.emit('interventions', this.interventionLog);
  }
}
