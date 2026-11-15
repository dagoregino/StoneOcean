import { checkManualValue } from '../domain/manualEntry';
import { formatMissionTime } from '../data/MissionClock';
import { SCENARIOS } from '../data/sources/scenarios';
import { INDICATORS } from '../domain/catalog/indicators';
import { EVIDENCE, evidenceFor, RULES, SOURCES, verificationOf } from '../domain/evidence/catalog';
import { provenanceOf } from '../domain/evidence/indicatorRules';
import { PROVENANCE_CLASSES, type AuthorityLevel } from '../domain/evidence/types';
import { isPharmacological, offerSteps } from '../domain/medicalPlan';
import { severity } from '../domain/status';
import { SYSTEM_IDS, type IndicatorEvaluation, type IndicatorId } from '../domain/types';
import { CREW_ID, type MissionRuntime } from './runtime';

export interface ApiRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

const ok = (body: unknown, status = 200): ApiResponse => ({ status, body });
const fail = (status: number, error: string): ApiResponse => ({ status, body: { error } });
const isIndicator = (id: unknown): id is IndicatorId => typeof id === 'string' && id in INDICATORS;
const sourceOf = (id: string) => SOURCES.find((s) => s.id === id);

const ENDPOINTS = [
  'GET /rules',
  'GET /rules/{id}',
  'GET /evidence?rule=&provenance_class=',
  `GET /state/${CREW_ID}`,
  'GET /radiation/now',
  'GET /alerts',
  'GET /verify',
  'POST /verify { indicatorId, stepText, authorityLevel, simulateEffect? }',
  'POST /measurements { indicatorId, value }',
  'POST /simulate { hours?, scenario? }',
  'PUT /medical-plan { drugsPreauthorized }',
];

function evidenceRows(filter: (id: string) => boolean = () => true) {
  return EVIDENCE.filter((e) => filter(e.id)).map((e) => {
    const source = sourceOf(e.sourceId);
    return {
      id: e.id,
      ruleIds: e.ruleIds,
      claim: e.claim,
      provenance_class: e.provenanceClass,
      n: e.n,
      nNote: e.nNote ?? null,
      effect: e.effect,
      ci95: e.ci95,
      p: e.p,
      limitations: e.limitations,
      verification: verificationOf(e.id),
      source: { id: e.sourceId, title: source?.matchedTitle ?? source?.title ?? null, url: source?.url ?? null, doi: source?.doi ?? null },
    };
  });
}

/** JSON has no infinity: an open end of a range is null. */
const finite = (value: number): number | null => (Number.isFinite(value) ? value : null);

/** How the indicator stands against the person's own baseline; null while it is judged by a fixed range. */
function baselineView(i: IndicatorEvaluation) {
  const d = i.drift;
  if (!d) return null;
  return {
    mean: d.baselineMean,
    sd: d.baselineSd,
    days: d.baselineDays,
    untilMin: d.baselineUntil,
    adverseDirection: d.direction,
    usualRange: { min: finite(d.usualRange.min), max: finite(d.usualRange.max) },
    current: d.current ? { value: d.current.value, z: d.current.z, measuredAtMin: d.current.t } : null,
    rules: {
      singleValue: { z: d.current?.z ?? null, cautionLimit: d.singleValueCautionLimit, criticalLimit: d.singleValueCriticalLimit },
      ewma: { value: d.ewma, cautionLimit: d.ewmaCautionLimit, criticalLimit: d.ewmaCriticalLimit },
      cusum: { value: d.cusum, cautionLimit: d.cusumCautionLimit, criticalLimit: d.cusumCriticalLimit },
    },
    trigger: d.trigger,
    awaitingFirstValue: d.awaitingFirstValue,
    daysMonitored: d.series.length,
  };
}

function indicatorView(i: IndicatorEvaluation) {
  const provenance = provenanceOf(i.def.id, Boolean(i.drift));
  return {
    id: i.def.id,
    name: i.def.name,
    value: i.latest?.value ?? null,
    unit: i.def.unit,
    measuredAtMin: i.latest?.t ?? null,
    status: i.status,
    due: i.due,
    trendPerDay: i.trendPerDay,
    worsening: i.worsening,
    ruleId: provenance.rule.id,
    thresholdBasis: provenance.basis,
    nasaLimit: provenance.nasaLimit,
    baseline: baselineView(i),
  };
}

/** Every alert carries its provenance class and a source: there is no code path that omits them. */
function alerts(runtime: MissionRuntime) {
  const { store } = runtime;
  return SYSTEM_IDS.flatMap((systemId) => store.evaluation.systems[systemId].indicators)
    .filter((i) => severity(i.status) >= severity('caution'))
    .sort((a, b) => severity(b.status) - severity(a.status))
    .map((i) => {
      const provenance = provenanceOf(i.def.id, Boolean(i.drift));
      const status = i.status as 'caution' | 'critical';
      return {
        crewId: CREW_ID,
        indicatorId: i.def.id,
        systemId: i.def.systemId,
        status,
        value: i.latest?.value ?? null,
        unit: i.def.unit,
        measuredAtMin: i.latest?.t ?? null,
        ruleId: provenance.rule.id,
        condition: provenance.rule.condition,
        thresholdBasis: provenance.basis,
        basisLabel: provenance.basisLabel,
        nasaLimit: provenance.nasaLimit,
        baseline: baselineView(i),
        provenance_class: provenance.evidence.provenanceClass,
        evidenceId: provenance.evidence.id,
        source: { id: provenance.source.id, title: provenance.source.matchedTitle ?? provenance.source.title, url: provenance.source.url },
        treat: {
          firstSteps: offerSteps(i.def.guidance[status], store.medicalPlan),
          protocol: provenance.rule.treat.map((step) => ({ ...step, withheld: step.requiresPreauthorization && !store.medicalPlan.drugsPreauthorized })),
        },
        verify: provenance.rule.verify.criterion,
      };
    });
}

/** Routes one request. Pure with respect to HTTP, so it is tested without a server. */
export function handle(runtime: MissionRuntime, request: ApiRequest): ApiResponse {
  const { store } = runtime;
  const method = request.method.toUpperCase();
  const path = request.path.replace(/\/+$/, '') || '/';
  const query = request.query ?? {};
  const body = (request.body ?? {}) as Record<string, unknown>;
  const [, resource, id] = path.split('/');

  if (method === 'GET') {
    if (path === '/') return ok({ name: 'Crew health API (prototype)', note: 'Decision support, not diagnosis. All crew readings are simulated.', endpoints: ENDPOINTS });

    if (resource === 'rules' && !id) {
      const rules = query.hazard ? RULES.filter((r) => r.hazard === query.hazard) : RULES;
      return ok({ count: rules.length, rules });
    }
    if (resource === 'rules' && id) {
      const rule = RULES.find((r) => r.id === id);
      if (!rule) return fail(404, `Unknown rule ${id}`);
      return ok({ rule, evidence: evidenceRows((e) => evidenceFor(rule).some((row) => row.id === e)) });
    }

    if (resource === 'evidence') {
      if (query.provenance_class && !(PROVENANCE_CLASSES as readonly string[]).includes(query.provenance_class)) {
        return fail(400, `Unknown provenance_class. Use one of: ${PROVENANCE_CLASSES.join(', ')}`);
      }
      const rows = evidenceRows().filter((e) => (!query.rule || e.ruleIds.includes(query.rule)) && (!query.provenance_class || e.provenance_class === query.provenance_class));
      return ok({ count: rows.length, evidence: rows });
    }

    if (resource === 'state') {
      if (id !== CREW_ID) return fail(404, `Unknown crew member. The prototype follows ${CREW_ID}.`);
      const evaluation = store.evaluation;
      return ok({
        crewId: CREW_ID,
        missionTimeMin: evaluation.missionTime,
        missionDay: formatMissionTime(evaluation.missionTime).day,
        environment: { id: store.environment.id, name: store.environment.name, commsDelaySec: store.environment.commsDelaySec },
        scenario: runtime.simulator.activeScenario.id,
        medicalPlan: store.medicalPlan,
        triage: evaluation.triage,
        systems: SYSTEM_IDS.map((systemId) => {
          const system = evaluation.systems[systemId];
          return { id: systemId, name: system.def.name, status: system.status, indicators: system.indicators.map(indicatorView) };
        }),
        selfChecksDue: evaluation.due.map((d) => d.def.id),
      });
    }

    if (path === '/radiation/now') {
      const { weather } = runtime;
      const { now } = weather;
      return ok({
        origin: weather.origin,
        satellite: weather.satellite,
        latest: now.latest ? { timeUtc: new Date(now.latest.t).toISOString(), protonFluxPfu: now.latest.value, energy: '>=10 MeV' } : null,
        noaaScale: { level: now.level, name: now.levelName, s1ThresholdPfu: now.s1Threshold, nasaLimit: false },
        eventInProgress: now.event.inProgress,
        eventPeakPfu: now.event.inProgress ? now.event.peakPfu : null,
        solarParticleEventsOnRecord: { from: weather.eventsFrom, to: weather.eventsTo, count: weather.events.length, latest: weather.events.slice(0, 3) },
        sources: ['NOAA SWPC GOES integral proton flux', 'NASA DONKI SEP events (snapshot)'],
        note: 'Real space weather. The NOAA S-scale is an operational scale, not a NASA limit.',
      });
    }

    if (resource === 'alerts') {
      const list = alerts(runtime);
      return ok({ crewId: CREW_ID, count: list.length, alerts: list });
    }

    if (resource === 'verify') return ok({ count: store.interventions.length, interventions: store.interventions });
    return fail(404, `No such endpoint: GET ${path}`);
  }

  if (method === 'POST' && resource === 'verify') {
    const { indicatorId, stepText, authorityLevel } = body;
    if (!isIndicator(indicatorId)) return fail(400, 'indicatorId is missing or unknown');
    if (typeof stepText !== 'string' || stepText.trim() === '') return fail(400, 'stepText is required');
    if (![1, 2, 3, 4].includes(authorityLevel as number)) return fail(400, 'authorityLevel must be 1, 2, 3 or 4');
    // The same gate as the dashboard: no drug step without a pre-authorized medical plan.
    if ((authorityLevel === 3 || isPharmacological(stepText)) && !store.medicalPlan.drugsPreauthorized) {
      return fail(403, 'Medication steps need a pre-authorized mission medical plan (PUT /medical-plan).');
    }
    return ok({ intervention: runtime.intervene(indicatorId, stepText, authorityLevel as AuthorityLevel, body.simulateEffect === true) }, 201);
  }

  if (method === 'POST' && resource === 'measurements') {
    const { indicatorId, value } = body;
    if (!isIndicator(indicatorId)) return fail(400, 'indicatorId is missing or unknown');
    if (typeof value !== 'number' || !Number.isFinite(value)) return fail(400, 'value must be a number');
    // The same check as the dashboard. The API has no confirmation step, so an unusual value is
    // saved as sent and flagged in the answer; only an implausible one is refused.
    const check = checkManualValue(INDICATORS[indicatorId], String(value));
    if (check.kind === 'invalid' || check.kind === 'implausible') return fail(400, check.message);
    return ok({ reading: runtime.log(indicatorId, check.value), ...(check.kind === 'unusual' ? { unusual: true } : {}) }, 201);
  }

  if (method === 'POST' && resource === 'simulate') {
    const hours = body.hours ?? 0;
    if (typeof hours !== 'number' || hours < 0 || hours > 24 * 60) return fail(400, 'hours must be a number between 0 and 1440');
    if (body.scenario !== undefined) {
      if (typeof body.scenario !== 'string' || !SCENARIOS.some((s) => s.id === body.scenario)) {
        return fail(400, `Unknown scenario. Use one of: ${SCENARIOS.map((s) => s.id).join(', ')}`);
      }
      runtime.setScenario(body.scenario);
    }
    runtime.advance(Math.round(hours));
    return ok({ missionTimeMin: store.missionTime, missionDay: formatMissionTime(store.missionTime).day, scenario: runtime.simulator.activeScenario.id });
  }

  if (method === 'PUT' && path === '/medical-plan') {
    if (typeof body.drugsPreauthorized !== 'boolean') return fail(400, 'drugsPreauthorized must be true or false');
    store.setDrugsPreauthorized(body.drugsPreauthorized);
    return ok({ medicalPlan: store.medicalPlan });
  }

  return fail(404, `No such endpoint: ${method} ${path}`);
}
