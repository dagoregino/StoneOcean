import { describe, expect, it } from 'vitest';
import { HealthStore } from '../src/data/HealthStore';
import { createSymptomReport, relatedSelfChecks, SYMPTOM_NOTES_MAX, type SymptomInput } from '../src/domain/symptoms';

const input = (over: Partial<SymptomInput> = {}): SymptomInput => ({
  systemId: 'muscular',
  position: { x: 0.1, y: 1.2, z: 0.05 },
  intensity: 6,
  type: 'muscle_fatigue',
  ...over,
});

describe('symptom reports (domain)', () => {
  it('keeps the picked point as plain coordinates', () => {
    const report = createSymptomReport(1, 500, input());
    expect(report.position).toEqual({ x: 0.1, y: 1.2, z: 0.05 });
    expect(Object.getPrototypeOf(report.position)).toBe(Object.prototype);
    expect(report.t).toBe(500);
  });

  it('clamps the intensity to a whole number from 1 to 10 and tidies the notes', () => {
    expect(createSymptomReport(1, 0, input({ intensity: 14 })).intensity).toBe(10);
    expect(createSymptomReport(1, 0, input({ intensity: 0 })).intensity).toBe(1);
    expect(createSymptomReport(1, 0, input({ intensity: 6.6 })).intensity).toBe(7);
    expect(createSymptomReport(1, 0, input({ notes: '  after   exercise \n' })).notes).toBe('after exercise');
    expect(createSymptomReport(1, 0, input({ notes: 'x'.repeat(999) })).notes).toHaveLength(SYMPTOM_NOTES_MAX);
  });

  it('rejects input that cannot be a real report', () => {
    expect(() => createSymptomReport(1, 0, input({ position: { x: Number.NaN, y: 0, z: 0 } }))).toThrow(RangeError);
    expect(() => createSymptomReport(1, 0, input({ type: 'made_up' as never }))).toThrow(RangeError);
  });

  it('suggests only the self-checks of the reported system, plus the dizziness score for dizziness', () => {
    expect(relatedSelfChecks('neuro', 'pressure')).toEqual(['mood']);
    expect(relatedSelfChecks('sensory', 'other')).toEqual(expect.arrayContaining(['visionChange', 'dizziness']));
    expect(relatedSelfChecks('muscular', 'muscle_fatigue')).toEqual([]);
    expect(relatedSelfChecks('muscular', 'dizziness')).toEqual(['dizziness']);
    expect(relatedSelfChecks('sensory', 'dizziness').filter((id) => id === 'dizziness')).toHaveLength(1);
  });
});

describe('symptom reports (store)', () => {
  it('records a report in the mission log, announces it and leaves report mode', () => {
    const store = new HealthStore('iss');
    store.ingest([], 1234);
    const seen: number[] = [];
    store.events.on('symptoms', (list) => seen.push(list.length));
    store.setReportMode(true);
    store.setSymptomDraft({ position: { x: 0, y: 1, z: 0 }, systems: ['muscular', 'skeletal'] });

    const report = store.reportSymptom(input());

    expect(store.symptoms).toEqual([report]);
    expect(report.t).toBe(1234);
    expect(seen).toEqual([1]);
    expect(store.reportMode).toBe(false);
    expect(store.symptomDraft).toBeNull();
  });

  it('never changes a status or the triage', () => {
    const store = new HealthStore('iss');
    store.ingest([{ indicatorId: 'heartRate', value: 64, t: 10, source: 'sensor' }], 10);
    const before = JSON.stringify(store.evaluation);
    store.reportSymptom(input({ systemId: 'cardiovascular', type: 'sharp_pain', intensity: 10 }));
    expect(JSON.stringify(store.evaluation)).toBe(before);
  });

  it('removes a report and forgets all of them on reset', () => {
    const store = new HealthStore('iss');
    const first = store.reportSymptom(input());
    const second = store.reportSymptom(input({ type: 'other' }));
    expect(second.id).not.toBe(first.id);
    store.removeSymptom(first.id);
    expect(store.symptoms.map((r) => r.id)).toEqual([second.id]);
    store.reset(0);
    expect(store.symptoms).toEqual([]);
  });

  it('drops the draft when report mode is switched off', () => {
    const store = new HealthStore('iss');
    store.setReportMode(true);
    store.setSymptomDraft({ position: { x: 0, y: 1, z: 0 }, systems: ['skeletal'] });
    store.setReportMode(false);
    expect(store.symptomDraft).toBeNull();
  });
});

describe('twin view (store)', () => {
  it('starts on the astronaut', () => {
    expect(new HealthStore('iss').twinView).toBe('astronaut');
  });

  it('opens the anatomy when a body system is selected, from anywhere', () => {
    const store = new HealthStore('iss');
    const order: string[] = [];
    store.events.on('twinView', (view) => order.push(`view:${view}`));
    store.events.on('selection', (id) => order.push(`selection:${id}`));
    store.select('skeletal');
    expect(store.twinView).toBe('anatomy');
    expect(order).toEqual(['view:anatomy', 'selection:skeletal']);
  });

  it('puts away selection, hover and report mode when going back to the astronaut', () => {
    const store = new HealthStore('iss');
    store.select('neuro');
    store.hover('neuro');
    store.setReportMode(true);
    store.setTwinView('astronaut');
    expect(store.selected).toBeNull();
    expect(store.hovered).toBeNull();
    expect(store.reportMode).toBe(false);
    expect(store.twinView).toBe('astronaut');
  });

  it('shows the body before a spot can be marked on it', () => {
    const store = new HealthStore('iss');
    store.setReportMode(true);
    expect(store.twinView).toBe('anatomy');
  });

  it('does not touch the evaluation', () => {
    const store = new HealthStore('iss');
    const before = JSON.stringify(store.evaluation);
    store.setTwinView('scan');
    store.setTwinView('anatomy');
    expect(JSON.stringify(store.evaluation)).toBe(before);
  });
});
