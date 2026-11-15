import { describe, expect, it } from 'vitest';
import { HISTORY_DAYS } from '../src/config';
import { HealthStore } from '../src/data/HealthStore';
import { MissionClock } from '../src/data/MissionClock';
import { scenarioById } from '../src/data/sources/scenarios';
import { SimulatedSource } from '../src/data/sources/SimulatedSource';
import { INDICATORS } from '../src/domain/catalog/indicators';
import { HAZARDS, SYSTEMS } from '../src/domain/catalog/systems';
import { RULES } from '../src/domain/evidence/catalog';
import { buildSymptomGuidance } from '../src/domain/symptomGuidance';
import type { SymptomInput } from '../src/domain/symptoms';
import type { EnvironmentId } from '../src/domain/types';

const DAY = 1440;

function mission(environment: EnvironmentId, scenario = 'nominal', days = 0): HealthStore {
  const store = new HealthStore(environment);
  const clock = new MissionClock(44 * DAY + 480);
  const simulator = new SimulatedSource(clock, () => store.environment);
  simulator.connect(store);
  simulator.seedHistory(HISTORY_DAYS);
  if (scenario !== 'nominal') {
    simulator.setScenario(scenarioById(scenario));
    for (let i = 0; i < days * 24; i++) {
      const previous = clock.now;
      clock.now += 60;
      store.ingest(simulator.advance(previous, clock.now), clock.now);
    }
  }
  return store;
}

const guide = (store: HealthStore, input: Partial<SymptomInput> = {}) => {
  const report = store.reportSymptom({ systemId: 'neuro', position: { x: 0, y: 1.6, z: 0.05 }, intensity: 6, type: 'pressure', notes: 'Since this morning', ...input });
  return buildSymptomGuidance({ report, evaluation: store.evaluation, environment: store.environment, plan: store.medicalPlan, consultReason: store.consultReason });
};

describe('guidance after a discomfort report', () => {
  it('recommends a self-check and invents no action when everything measured is nominal', () => {
    const store = mission('iss');
    const g = guide(store);
    expect(g.tier).toBe('self-check');
    expect(g.protocolIndicator).toBeNull();
    expect(g.flightSurgeon).toBeNull();
    // The only "action" is what the triage already says, plus the measured fact behind it.
    expect(g.immediate.map((l) => l.source)).toEqual(['measured', 'triage']);
    expect(g.immediate[1].text).toBe(store.evaluation.triage.detail);
  });

  it('suggests exactly the self-checks recorded on the report', () => {
    const store = mission('iss');
    const g = guide(store, { systemId: 'sensory', type: 'dizziness' });
    expect(g.selfChecks.map((c) => c.indicatorId)).toEqual(g.report.relatedSelfChecks);
    expect(g.selfChecks[0].howToMeasure).toBe(INDICATORS[g.selfChecks[0].indicatorId].howToMeasure);
    const none = guide(store, { systemId: 'skeletal', type: 'sharp_pain' });
    expect(none.selfChecks).toEqual([]);
    expect(none.selfCheckNote).toMatch(/No self-check is defined/);
  });

  it('takes every protocol and escalation line from the rules matrix, word for word', () => {
    const store = mission('iss');
    const g = guide(store, { systemId: 'sensory' });
    const known = new Set(RULES.flatMap((r) => r.treat.map((s) => s.text)));
    const fromProtocol = g.escalate.filter((l) => l.source === 'protocol');
    expect(fromProtocol.length).toBeGreaterThan(0);
    for (const line of fromProtocol) expect(known.has(line.text)).toBe(true);
  });

  it('lists only the hazards the catalog files under the reported system, as context', () => {
    const store = mission('mars');
    const g = guide(store, { systemId: 'cardiovascular' });
    expect(g.missionRisks.map((r) => r.hazard)).toEqual(SYSTEMS.cardiovascular.hazards);
    expect(g.missionRisks.every((r) => r.name === HAZARDS[r.hazard].name)).toBe(true);
    expect(g.uncertainty).toMatch(/not an explanation of what you feel/);
    // No line of the guidance claims a cause.
    const everything = [...g.immediate, ...g.monitor, ...g.escalate].map((l) => l.text).join(' ');
    expect(everything).not.toMatch(/caused by|because of radiation|due to radiation/i);
  });

  it('never changes a status or the triage', () => {
    const store = mission('iss');
    const before = JSON.stringify(store.evaluation);
    guide(store, { intensity: 10, type: 'sharp_pain', systemId: 'cardiovascular' });
    expect(JSON.stringify(store.evaluation)).toBe(before);
  });

  it('tells a crew far from Earth to start on board and not wait for the answer', () => {
    const mars = guide(mission('mars'));
    const station = guide(mission('iss'));
    expect(mars.escalate[mars.escalate.length - 1].text).toMatch(/do not wait/);
    expect(station.escalate[station.escalate.length - 1].text).toMatch(/near real time/);
  });

  it('follows the triage when measured data has flagged the reported system', () => {
    const store = mission('mars', 'sleep-loss', 4);
    const flagged = Object.values(store.evaluation.systems).find((s) => s.status === 'critical' || s.status === 'caution');
    expect(flagged).toBeDefined();
    const g = guide(store, { systemId: flagged!.def.id });
    expect(g.tier).toBe(flagged!.status === 'critical' || store.evaluation.triage.status === 'critical' ? 'immediate' : 'attention');
    expect(g.protocolIndicator).toBe(flagged!.driver!.def.id);
    expect(g.immediate.every((l) => l.source === 'protocol')).toBe(true);
    if (store.consultReason) {
      expect(g.flightSurgeon).not.toBeNull();
      expect(g.flightSurgeon!.realtime).toBe(false);
      expect(g.flightSurgeon!.note).toMatch(/Start the onboard protocol now/);
    }
  });
});
