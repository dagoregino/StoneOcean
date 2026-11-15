import { normalizeId, toTypeCode, validateResource } from './inventory';
import { isStock, RESOURCE_CATEGORIES, type Resource, type ResourceCategory, type ResourceInput, type ResourceState } from './types';

/** Columns of the CSV template, in order. JSON uses the same names as keys. */
export const IMPORT_COLUMNS = [
  'id',
  'category',
  'name',
  'typeCode',
  'quantity',
  'unit',
  'minStock',
  'location',
  'state',
  'lot',
  'expiresOn',
  'storage',
  'brand',
  'model',
  'batteryPct',
  'lastMaintenance',
  'nextMaintenance',
  'nextCalibration',
  'lastInspection',
  'nextInspection',
  'notes',
] as const;

export const CSV_TEMPLATE = `${IMPORT_COLUMNS.join(',')}\n,consumable,Sterile gauze pads,wound-dressing,40,pads,10,Medical locker A2,available,LOT-123,2027-06-30,Dry,,,,,,,,,\n`;

export interface ImportResult {
  /** Rows that passed every check, ready to be saved. */
  valid: ResourceInput[];
  /** Rows that were refused, with the reason. Row 1 is the first data row. */
  errors: { row: number; message: string }[];
}

/** Splits CSV text into rows of cells, honouring quotes, doubled quotes and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

const text = (value: unknown): string => (value === null || value === undefined ? '' : String(value).trim());
const optional = (value: unknown): string | undefined => text(value) || undefined;

function toInput(raw: Record<string, unknown>): ResourceInput | string {
  const category = text(raw.category).toLowerCase() as ResourceCategory;
  if (!RESOURCE_CATEGORIES.includes(category)) return `category must be one of: ${RESOURCE_CATEGORIES.join(', ')}.`;
  const number = (value: unknown, name: string): number | null | string => {
    const t = text(value);
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : `${name} must be a number.`;
  };
  const quantity = number(raw.quantity, 'quantity');
  const minStock = number(raw.minStock, 'minStock');
  const batteryPct = number(raw.batteryPct, 'batteryPct');
  for (const value of [quantity, minStock, batteryPct]) if (typeof value === 'string') return value;
  const name = text(raw.name);
  const state = (text(raw.state).toLowerCase().replace(/[\s-]+/g, '_') || (isStock(category) ? 'available' : 'operational')) as ResourceState;
  return {
    id: text(raw.id) ? normalizeId(text(raw.id)) : undefined,
    category,
    name,
    typeCode: toTypeCode(text(raw.typeCode) || name),
    quantity: (quantity as number | null) ?? Number.NaN,
    unit: text(raw.unit),
    minStock: minStock as number | null,
    location: text(raw.location),
    state,
    lot: optional(raw.lot),
    expiresOn: optional(raw.expiresOn),
    storage: optional(raw.storage),
    brand: optional(raw.brand),
    model: optional(raw.model),
    batteryPct: batteryPct as number | null,
    lastMaintenance: optional(raw.lastMaintenance),
    nextMaintenance: optional(raw.nextMaintenance),
    nextCalibration: optional(raw.nextCalibration),
    lastInspection: optional(raw.lastInspection),
    nextInspection: optional(raw.nextInspection),
    notes: optional(raw.notes),
  };
}

/**
 * Reads an inventory file and checks every row with the same rules as the form. Nothing
 * is saved here: the caller decides what to do with the rows that passed.
 */
export function parseInventoryFile(content: string, format: 'csv' | 'json', existing: readonly Resource[]): ImportResult {
  let rows: Record<string, unknown>[];
  try {
    if (format === 'json') {
      const data: unknown = JSON.parse(content);
      const list = Array.isArray(data) ? data : (data as { resources?: unknown })?.resources;
      if (!Array.isArray(list)) return { valid: [], errors: [{ row: 0, message: 'The JSON file must be a list of resources, or an object with a "resources" list.' }] };
      rows = list.map((entry) => (entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}));
    } else {
      const [header, ...lines] = parseCsv(content);
      if (!header) return { valid: [], errors: [{ row: 0, message: 'The file is empty.' }] };
      const columns = header.map((h) => h.trim());
      const missing = ['category', 'name', 'quantity', 'unit', 'location'].filter((c) => !columns.includes(c));
      if (missing.length > 0) return { valid: [], errors: [{ row: 0, message: `Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Download the template to see the expected header.` }] };
      rows = lines.map((cells) => Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? ''])));
    }
  } catch {
    return { valid: [], errors: [{ row: 0, message: `The file is not valid ${format.toUpperCase()}.` }] };
  }

  const result: ImportResult = { valid: [], errors: [] };
  // Rows are also checked against each other: two rows of the file cannot be the same record.
  const accepted: Resource[] = [...existing];
  rows.forEach((raw, index) => {
    const input = toInput(raw);
    if (typeof input === 'string') {
      result.errors.push({ row: index + 1, message: input });
      return;
    }
    const problems = Object.entries(validateResource(input, accepted));
    if (problems.length > 0) {
      result.errors.push({ row: index + 1, message: problems.map(([field, message]) => `${field}: ${message}`).join(' ') });
      return;
    }
    result.valid.push(input);
    accepted.push({ ...input, id: input.id ?? `PENDING-${index}`, reserved: 0, active: true, simulated: false, createdAt: '', updatedAt: '' });
  });
  return result;
}
