import { isDateString } from './dates';
import { freeUnits } from './findings';
import {
  CATEGORY_PREFIX,
  GEAR_STATES,
  isStock,
  MOVEMENT_TYPES,
  RESOURCE_CATEGORIES,
  STOCK_STATES,
  type MovementInput,
  type Resource,
  type ResourceInput,
  type ResourceState,
} from './types';

/** Field name -> what is wrong with it, in words a form can show as they are. */
export type FieldErrors = Partial<Record<string, string>>;

export class ResourceError extends Error {
  constructor(
    message: string,
    readonly fields: FieldErrors = {},
  ) {
    super(message);
    this.name = 'ResourceError';
  }
}

const isWholeCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const DATE_FIELDS = ['expiresOn', 'lastMaintenance', 'nextMaintenance', 'nextCalibration', 'lastInspection', 'nextInspection'] as const;
export const ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,23}$/;

/** Turns free text into a type code: "Pulse Oximeter" -> "pulse-oximeter". */
export const toTypeCode = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const normalizeId = (id: string): string => id.trim().toUpperCase();

/** The next free identifier for a category: MED-0007. */
export function nextId(category: Resource['category'], taken: Iterable<string>): string {
  const prefix = `${CATEGORY_PREFIX[category]}-`;
  let max = 0;
  for (const id of taken) if (id.startsWith(prefix)) max = Math.max(max, Number(id.slice(prefix.length)) || 0);
  return `${prefix}${String(max + 1).padStart(4, '0')}`;
}

/**
 * Checks a record before it is saved. `others` are the records it must not duplicate
 * (leave out the record itself when editing).
 */
export function validateResource(input: ResourceInput, others: readonly Resource[]): FieldErrors {
  const errors: FieldErrors = {};
  const stock = isStock(input.category);
  if (!RESOURCE_CATEGORIES.includes(input.category)) errors.category = 'Choose a category.';
  if (!input.name?.trim()) errors.name = 'Give it a name.';
  else if (input.name.trim().length > 80) errors.name = 'Keep the name under 80 characters.';
  if (!input.typeCode?.trim()) errors.typeCode = 'Say what kind of item this is.';
  if (input.id !== undefined && input.id !== '') {
    const id = normalizeId(input.id);
    if (!ID_PATTERN.test(id)) errors.id = 'Use 3 to 24 letters, digits or dashes (for example MED-0012).';
    else if (others.some((r) => r.id === id)) errors.id = `${id} is already in use.`;
  }
  if (!isWholeCount(input.quantity)) errors.quantity = 'Enter a whole number, 0 or more.';
  if (!input.unit?.trim()) errors.unit = 'Say what is being counted (tablets, units…).';
  if (input.minStock !== null && !isWholeCount(input.minStock)) errors.minStock = 'Enter a whole number, or leave it empty.';
  if (!input.location?.trim()) errors.location = 'Say where it is kept.';
  const states: readonly ResourceState[] = stock ? STOCK_STATES : GEAR_STATES;
  if (!states.includes(input.state)) errors.state = 'Choose a state.';
  for (const field of DATE_FIELDS) {
    const value = input[field];
    if (value !== undefined && value !== '' && !isDateString(value)) errors[field] = 'Use a real date.';
  }
  if (input.batteryPct !== undefined && input.batteryPct !== null && !(Number.isFinite(input.batteryPct) && input.batteryPct >= 0 && input.batteryPct <= 100)) {
    errors.batteryPct = 'Battery is a percentage from 0 to 100.';
  }
  // The same lot of the same item kept in the same place is one record, not two.
  if (stock && !errors.name) {
    const key = (r: { typeCode: string; lot?: string; location: string }): string => `${toTypeCode(r.typeCode)}|${(r.lot ?? '').trim().toLowerCase()}|${r.location.trim().toLowerCase()}`;
    const twin = others.find((r) => r.active && r.category === input.category && key(r) === key(input));
    if (twin) errors.lot = `This lot is already registered here as ${twin.id}. Restock that record instead.`;
  }
  return errors;
}

export interface MovementResult {
  quantity: number;
  reserved: number;
  state: ResourceState;
}

/**
 * Works out the count after a movement, or throws with the reason it cannot happen.
 * The count can never go below zero and nothing can be taken that is not there.
 */
export function applyMovement(resource: Resource, movement: MovementInput): MovementResult {
  const { type, quantity } = movement;
  const fail = (message: string, field = 'quantity'): never => {
    throw new ResourceError(message, { [field]: message });
  };
  if (!MOVEMENT_TYPES.includes(type)) fail('Choose a type of movement.', 'type');
  if (!resource.active) fail(`${resource.name} is deactivated. Reactivate it before recording movements.`, 'resourceId');
  if (!Number.isInteger(quantity) || quantity <= 0) fail('Enter a whole number greater than 0.');
  if (!movement.reason?.trim()) fail('Say why: the history must explain every movement.', 'reason');

  const free = freeUnits(resource);
  const unit = resource.unit;
  let { quantity: onBoard, reserved, state } = resource;
  switch (type) {
    case 'entry':
    case 'restock':
      onBoard += quantity;
      // New units put a record that had run out back in use.
      if (state === 'out_of_service' && onBoard > 0) state = 'needs_attention';
      break;
    case 'consumption':
      if (quantity > free) fail(reserved > 0 ? `Only ${free} ${unit} are free (${reserved} are reserved). Release the reservation with a return first.` : `Only ${free} ${unit} are on board.`);
      onBoard -= quantity;
      break;
    case 'reservation':
      if (quantity > free) fail(`Only ${free} ${unit} are free to reserve.`);
      reserved += quantity;
      break;
    case 'return': {
      const released = Math.min(reserved, quantity);
      reserved -= released;
      onBoard += quantity - released;
      break;
    }
    case 'expired':
    case 'damaged':
      if (quantity > onBoard) fail(`Only ${onBoard} ${unit} are on board.`);
      onBoard -= quantity;
      reserved = Math.min(reserved, onBoard);
      if (onBoard === 0) state = isStock(resource.category) ? (type === 'expired' ? 'expired' : state) : 'out_of_service';
      break;
  }
  return { quantity: onBoard, reserved, state };
}
