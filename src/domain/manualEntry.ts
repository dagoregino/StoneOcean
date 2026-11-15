import type { IndicatorDef } from './types';

/**
 * Checks a value typed by the crew member before it is saved.
 *
 * This is about data entry only. `plausible` separates a real reading from a typing or unit
 * mistake; `display` is where readings usually fall. Neither is a clinical threshold: whether
 * a saved value is nominal, caution or critical is decided afterwards by the rules engine,
 * exactly as for any other reading. Nothing is ever clipped: a value is saved as typed
 * (rounded to the indicator's precision) or not saved at all.
 */
export type ManualValueCheck =
  /** Not a number. */
  | { kind: 'invalid'; message: string }
  /** Outside what can be measured: not saved. */
  | { kind: 'implausible'; message: string }
  /** Possible, but outside the usual range: saved only after the crew member confirms. */
  | { kind: 'unusual'; value: number; message: string }
  | { kind: 'ok'; value: number };

export const UNUSUAL_MESSAGE = 'Outside the usual range for this indicator. Measure again to confirm.';

const withUnit = (value: number | string, def: IndicatorDef): string => (def.unit ? `${value} ${def.unit}` : String(value));

/**
 * A value that looks like it was typed in another unit gets a hint, since that is the most
 * likely mistake: blood sugar in mmol/L, temperature in °F.
 */
function unitHint(def: IndicatorDef, value: number): string {
  if (def.id === 'glucose' && value > 0 && value <= 35) return ` Glucose is entered in mg/dL. ${value} mmol/L ≈ ${Math.round(value * 18)} mg/dL.`;
  if (def.id === 'bodyTemp' && value >= 50 && value <= 113) return ` Temperature is entered in °C. ${value} °F ≈ ${(((value - 32) * 5) / 9).toFixed(1)} °C.`;
  return '';
}

export function checkManualValue(def: IndicatorDef, raw: string): ManualValueCheck {
  const text = raw.trim().replace(',', '.');
  if (text === '') return { kind: 'invalid', message: 'Enter a value.' };
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return { kind: 'invalid', message: `Enter a number${def.unit ? ` in ${def.unit}` : ''}.` };
  const value = Number(parsed.toFixed(def.decimals));
  const { plausible, display } = def;
  // The hint is worked out on what was typed, before rounding, so 5.5 mmol/L reads as 5.5.
  const hint = unitHint(def, parsed);
  if (value < plausible.min || value > plausible.max) {
    return { kind: 'implausible', message: `Not saved: ${def.name} must be between ${withUnit(plausible.min, def)} and ${withUnit(plausible.max, def)}.${hint}` };
  }
  if (value < display.min || value > display.max) return { kind: 'unusual', value, message: `${UNUSUAL_MESSAGE}${hint}` };
  return { kind: 'ok', value };
}
