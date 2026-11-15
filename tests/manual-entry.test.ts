import { describe, expect, it } from 'vitest';
import { handle, type ApiResponse } from '../src/api/handlers';
import { MissionRuntime } from '../src/api/runtime';
import { HISTORY_DAYS, MISSION_START_MINUTES } from '../src/config';
import { HealthStore } from '../src/data/HealthStore';
import { MissionClock } from '../src/data/MissionClock';
import { SimulatedSource } from '../src/data/sources/SimulatedSource';
import { INDICATOR_LIST, INDICATORS } from '../src/domain/catalog/indicators';
import { STATUSES, type IndicatorId } from '../src/domain/types';
import { checkManualValue, UNUSUAL_MESSAGE } from '../src/domain/manualEntry';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const post = (runtime: MissionRuntime, body: unknown): ApiResponse & { body: Json } => handle(runtime, { method: 'POST', path: '/measurements', body }) as ApiResponse & { body: Json };

describe('plausible range (data entry, not a clinical threshold)', () => {
  it('is defined for all 16 indicators and contains the chart range', () => {
    expect(INDICATOR_LIST).toHaveLength(16);
    for (const def of INDICATOR_LIST) {
      expect(def.plausible.min, def.id).toBeLessThanOrEqual(def.display.min);
      expect(def.plausible.max, def.id).toBeGreaterThanOrEqual(def.display.max);
      expect(def.plausible.min, def.id).toBeLessThan(def.plausible.max);
    }
  });
});

describe('checkManualValue', () => {
  const hr = INDICATORS.heartRate;

  it('refuses what is not a number', () => {
    expect(checkManualValue(hr, '').kind).toBe('invalid');
    expect(checkManualValue(hr, '   ').kind).toBe('invalid');
    expect(checkManualValue(hr, 'fast')).toMatchObject({ kind: 'invalid', message: 'Enter a number in bpm.' });
    expect(checkManualValue(hr, 'NaN').kind).toBe('invalid');
    expect(checkManualValue(hr, 'Infinity').kind).toBe('invalid');
  });

  it('accepts a value inside the usual range', () => {
    expect(checkManualValue(hr, '72')).toEqual({ kind: 'ok', value: 72 });
    expect(checkManualValue(hr, ' 72 ')).toEqual({ kind: 'ok', value: 72 });
    expect(checkManualValue(hr, String(hr.display.min)).kind).toBe('ok');
    expect(checkManualValue(hr, String(hr.display.max)).kind).toBe('ok');
  });

  it('asks to confirm a value that is possible but outside the usual range, and keeps it whole', () => {
    expect(checkManualValue(hr, '150')).toEqual({ kind: 'unusual', value: 150, message: UNUSUAL_MESSAGE });
    expect(checkManualValue(INDICATORS.spo2, '80')).toMatchObject({ kind: 'unusual', value: 80 });
    expect(checkManualValue(INDICATORS.glucose, '300')).toMatchObject({ kind: 'unusual', value: 300 });
    expect(checkManualValue(INDICATORS.bodyTemp, '40.5')).toMatchObject({ kind: 'unusual', value: 40.5 });
    expect(checkManualValue(hr, String(hr.plausible.max)).kind).toBe('unusual');
    expect(checkManualValue(hr, String(hr.plausible.min)).kind).toBe('unusual');
  });

  it('refuses a value outside what can be measured, naming the unit and the accepted range', () => {
    const high = checkManualValue(hr, '400');
    expect(high.kind).toBe('implausible');
    expect(high).toMatchObject({ message: 'Not saved: Resting heart rate must be between 20 bpm and 250 bpm.' });
    expect(checkManualValue(hr, '19').kind).toBe('implausible');
    expect(checkManualValue(hr, '-5').kind).toBe('implausible');
    expect(checkManualValue(INDICATORS.mood, '99').kind).toBe('implausible');
  });

  it('rounds to the precision of the indicator, and reads a decimal comma', () => {
    expect(checkManualValue(hr, '71.6')).toEqual({ kind: 'ok', value: 72 });
    expect(checkManualValue(INDICATORS.bodyTemp, '36.84')).toEqual({ kind: 'ok', value: 36.8 });
    expect(checkManualValue(INDICATORS.bodyTemp, '40,5')).toMatchObject({ kind: 'unusual', value: 40.5 });
  });

  it('hints at mmol/L when a glucose value is 35 or less', () => {
    const typed = checkManualValue(INDICATORS.glucose, '5.5');
    expect(typed.kind).toBe('implausible');
    expect(typed).toMatchObject({ message: expect.stringContaining('Glucose is entered in mg/dL. 5.5 mmol/L ≈ 99 mg/dL.') });
    // Still plausible in mg/dL, so it can be saved after confirming; the hint is shown all the same.
    const low = checkManualValue(INDICATORS.glucose, '30');
    expect(low).toMatchObject({ kind: 'unusual', value: 30, message: expect.stringContaining('30 mmol/L ≈ 540 mg/dL') });
    expect(checkManualValue(INDICATORS.glucose, '36')).toMatchObject({ kind: 'unusual', message: UNUSUAL_MESSAGE });
  });

  it('hints at °F when a temperature is between 50 and 113', () => {
    const typed = checkManualValue(INDICATORS.bodyTemp, '98.6');
    expect(typed.kind).toBe('implausible');
    expect(typed).toMatchObject({ message: expect.stringContaining('Temperature is entered in °C. 98.6 °F ≈ 37.0 °C.') });
    expect(checkManualValue(INDICATORS.bodyTemp, '49')).toMatchObject({ kind: 'implausible', message: expect.not.stringContaining('°F') });
    expect(checkManualValue(INDICATORS.bodyTemp, '120')).toMatchObject({ kind: 'implausible', message: expect.not.stringContaining('°F') });
  });

  it('never returns a value different from the one typed (apart from rounding)', () => {
    for (const def of INDICATOR_LIST) {
      for (const raw of [def.plausible.min, def.display.min, (def.display.min + def.display.max) / 2, def.display.max, def.plausible.max]) {
        const check = checkManualValue(def, String(raw));
        if (check.kind === 'ok' || check.kind === 'unusual') expect(check.value, `${def.id} ${raw}`).toBe(Number(raw.toFixed(def.decimals)));
      }
    }
  });
});

describe('logging by hand, end to end', () => {
  /** What the dashboard does with a typed value: check it, confirm an unusual one, then log it. */
  const mission = () => {
    const store = new HealthStore('iss');
    const clock = new MissionClock(MISSION_START_MINUTES);
    const simulator = new SimulatedSource(clock, () => store.environment);
    simulator.connect(store);
    simulator.seedHistory(HISTORY_DAYS);
    const type = (id: IndicatorId, raw: string, confirm = true) => {
      const check = checkManualValue(INDICATORS[id], raw);
      if (check.kind === 'ok' || (check.kind === 'unusual' && confirm)) {
        const reading = { indicatorId: id, value: check.value, t: clock.now, source: 'manual' as const };
        simulator.absorb(reading);
        store.ingest([reading], clock.now);
      }
      return check;
    };
    const last = (id: IndicatorId) => store.history(id)[store.history(id).length - 1];
    const indicator = (id: IndicatorId) => store.evaluation.systems[INDICATORS[id].systemId].indicators.find((i) => i.def.id === id)!;
    return { store, type, last, indicator };
  };

  it('saves 150 bpm as 150, not clipped to the chart range, and lets the existing rules judge it', () => {
    const m = mission();
    expect(m.type('heartRate', '150').kind).toBe('unusual');
    expect(m.last('heartRate')).toMatchObject({ value: 150, source: 'manual' });
    expect(m.indicator('heartRate').latest?.value).toBe(150);
    expect(STATUSES).toContain(m.indicator('heartRate').status);
  });

  it('does not save an unusual value until it is confirmed', () => {
    const m = mission();
    const before = m.store.history('heartRate').length;
    m.type('heartRate', '150', false);
    expect(m.store.history('heartRate')).toHaveLength(before);
  });

  it('saves nothing for 400 bpm', () => {
    const m = mission();
    const before = m.store.history('heartRate').length;
    const evaluation = JSON.stringify(m.store.evaluation);
    expect(m.type('heartRate', '400').kind).toBe('implausible');
    expect(m.store.history('heartRate')).toHaveLength(before);
    expect(JSON.stringify(m.store.evaluation)).toBe(evaluation);
  });

  it('shows the mmol/L hint for glucose 5.5 and saves nothing', () => {
    const m = mission();
    const before = m.store.history('glucose').length;
    const check = m.type('glucose', '5.5');
    expect(check).toMatchObject({ kind: 'implausible', message: expect.stringContaining('mmol/L') });
    expect(m.store.history('glucose')).toHaveLength(before);
  });

  it('saves the other values that used to be clipped: SpO₂ 80 %, glucose 300 mg/dL, 40.5 °C', () => {
    const m = mission();
    m.type('spo2', '80');
    m.type('glucose', '300');
    m.type('bodyTemp', '40.5');
    expect(m.last('spo2').value).toBe(80);
    expect(m.last('glucose').value).toBe(300);
    expect(m.last('bodyTemp').value).toBe(40.5);
  });
});

describe('API: POST /measurements uses the same check', () => {
  it('accepts an unusual value as sent and flags it', () => {
    const runtime = new MissionRuntime();
    const { status, body } = post(runtime, { indicatorId: 'heartRate', value: 150 });
    expect(status).toBe(201);
    expect(body.unusual).toBe(true);
    expect(body.reading.value).toBe(150);
  });

  it('does not flag a usual value', () => {
    const { status, body } = post(new MissionRuntime(), { indicatorId: 'heartRate', value: 70 });
    expect(status).toBe(201);
    expect(body.unusual).toBeUndefined();
  });

  it('refuses an implausible value with the accepted range, and the unit hint when there is one', () => {
    const runtime = new MissionRuntime();
    const high = post(runtime, { indicatorId: 'heartRate', value: 400 });
    expect(high.status).toBe(400);
    expect(JSON.stringify(high.body)).toContain('between 20 bpm and 250 bpm');
    const glucose = post(runtime, { indicatorId: 'glucose', value: 5.5 });
    expect(glucose.status).toBe(400);
    expect(JSON.stringify(glucose.body)).toContain('mmol/L');
    expect(post(runtime, { indicatorId: 'heartRate', value: '150' }).status).toBe(400);
  });
});
