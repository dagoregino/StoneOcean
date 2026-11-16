/**
 * Medical resources on board: what the mission carries, what state it is in, and who is
 * trained to use it. Pure data and rules: no DOM, no storage, no three.js.
 *
 * Calendar dates are 'YYYY-MM-DD' strings; moments are ISO timestamps. Inventory runs on
 * the real calendar (lots expire on real dates), not on the simulator's mission clock.
 */

export const RESOURCE_CATEGORIES = ['pharmaceutical', 'device', 'consumable', 'emergency'] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<ResourceCategory, string> = {
  pharmaceutical: 'Medications',
  device: 'Devices',
  consumable: 'Supplies',
  emergency: 'Emergency kit',
};
export const CATEGORY_SHORT: Record<ResourceCategory, string> = {
  pharmaceutical: 'Medication',
  device: 'Device',
  consumable: 'Supplies',
  emergency: 'Emergency',
};
export const CATEGORY_PREFIX: Record<ResourceCategory, string> = { pharmaceutical: 'MED', device: 'DEV', consumable: 'CON', emergency: 'EMR' };

/** Things that are counted and used up, as opposed to equipment that is kept working. */
export const isStock = (category: ResourceCategory): boolean => category === 'pharmaceutical' || category === 'consumable';

/**
 * The state someone set on purpose. What the crew sees (expired, low, calibration due…)
 * is worked out from this plus dates and counts: see `findingsFor`.
 */
export const STOCK_STATES = ['available', 'quarantined', 'expired'] as const;
export const GEAR_STATES = ['operational', 'needs_attention', 'out_of_service'] as const;
export type ResourceState = (typeof STOCK_STATES)[number] | (typeof GEAR_STATES)[number];

export const STATE_LABEL: Record<ResourceState, string> = {
  available: 'Available',
  quarantined: 'Quarantined',
  expired: 'Expired',
  operational: 'Operational',
  needs_attention: 'Needs attention',
  out_of_service: 'Out of service',
};

export interface Resource {
  /** Unique identifier, also what its QR code carries. */
  id: string;
  category: ResourceCategory;
  /**
   * What kind of item this is, shared by every lot or unit of it (e.g. `pulse-oximeter`).
   * Protocols ask for a type, never for one specific record.
   */
  typeCode: string;
  name: string;
  /** Units on board. For equipment: number of units. */
  quantity: number;
  /** Units set aside for a planned use; they are on board but not free. */
  reserved: number;
  unit: string;
  /** At or below this many free units, the item is low. Null = not tracked. */
  minStock: number | null;
  location: string;
  state: ResourceState;
  // Stock (medication, consumables)
  lot?: string;
  expiresOn?: string;
  storage?: string;
  // Equipment
  brand?: string;
  model?: string;
  batteryPct?: number | null;
  lastMaintenance?: string;
  nextMaintenance?: string;
  nextCalibration?: string;
  lastInspection?: string;
  nextInspection?: string;
  notes?: string;
  /** False once removed from use. The record and its history are kept. */
  active: boolean;
  /** True for the demonstration records that ship with the app. */
  simulated: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What a form or an import provides; the service fills in the rest. */
export type ResourceInput = Omit<Resource, 'reserved' | 'active' | 'simulated' | 'createdAt' | 'updatedAt' | 'id'> & { id?: string };

export const MOVEMENT_TYPES = ['entry', 'restock', 'consumption', 'reservation', 'return', 'expired', 'damaged'] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_LABEL: Record<MovementType, string> = {
  entry: 'Entry',
  restock: 'Restock',
  consumption: 'Consumption',
  reservation: 'Reservation',
  return: 'Return',
  expired: 'Expired, removed',
  damaged: 'Damaged / out of service',
};

export const MOVEMENT_HELP: Record<MovementType, string> = {
  entry: 'First registration of units on board.',
  restock: 'More units added to an existing record.',
  consumption: 'Units used. They leave the count.',
  reservation: 'Units set aside for a planned use. They stay on board but are no longer free.',
  return: 'Unused units come back: reserved units are released first, the rest is added to the count.',
  expired: 'Units past their date are removed from the count.',
  damaged: 'Units broken or out of service are removed from the count.',
};

/** One line of the audit trail. Movements are only ever added, never changed. */
export interface Movement {
  id: string;
  resourceId: string;
  /** Kept on the line so the history still reads well if the record is later renamed. */
  resourceName: string;
  type: MovementType;
  quantity: number;
  at: string;
  user: string;
  reason: string;
  notes: string;
  /** The count right after this movement. */
  balance: { quantity: number; reserved: number };
}

export interface MovementInput {
  resourceId: string;
  type: MovementType;
  quantity: number;
  reason: string;
  notes?: string;
}

// ---------- Crew ----------

export const TRAINING_LEVELS = ['awareness', 'operator', 'advanced'] as const;
export type TrainingLevel = (typeof TRAINING_LEVELS)[number];
export const TRAINING_LABEL: Record<TrainingLevel, string> = {
  awareness: 'Can assist',
  operator: 'Can perform',
  advanced: 'Can lead',
};
export const TRAINING_RANK: Record<TrainingLevel, number> = { awareness: 1, operator: 2, advanced: 3 };

export const CREW_AVAILABILITY = ['available', 'off_duty', 'unavailable'] as const;
export type CrewAvailability = (typeof CREW_AVAILABILITY)[number];
export const AVAILABILITY_LABEL: Record<CrewAvailability, string> = { available: 'Available', off_duty: 'Off duty', unavailable: 'Unavailable' };

export interface Certification {
  procedureCode: string;
  level: TrainingLevel;
  certifiedOn: string;
  /** Empty when the certification does not lapse. */
  expiresOn?: string;
}

export interface CrewMember {
  id: string;
  name: string;
  role: string;
  availability: CrewAvailability;
  certifications: Certification[];
  simulated: boolean;
  updatedAt: string;
}
export type CrewInput = Omit<CrewMember, 'simulated' | 'updatedAt' | 'id'> & { id?: string };

// ---------- Findings and alerts ----------

export type Level = 'ok' | 'attention' | 'critical' | 'inactive';
export const LEVEL_RANK: Record<Level, number> = { inactive: 0, ok: 1, attention: 2, critical: 3 };
export const LEVEL_GLYPH: Record<Level, string> = { ok: '●', attention: '▲', critical: '◆', inactive: '○' };

export const FINDING_KINDS = [
  'expired',
  'quarantined',
  'out_of_stock',
  'expiring_soon',
  'low_stock',
  'all_reserved',
  'out_of_service',
  'needs_attention',
  'calibration_overdue',
  'calibration_due',
  'maintenance_overdue',
  'maintenance_due',
  'inspection_overdue',
  'inspection_due',
  'battery_low',
  'certification_expired',
  'certification_expiring',
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** One thing worth knowing about a record, in plain words. */
export interface Finding {
  kind: FindingKind;
  level: 'attention' | 'critical';
  /** Short, for a badge. */
  label: string;
  /** A full sentence saying what is wrong and by how much. */
  message: string;
  /** True when the record must not be used for a protocol while this stands. */
  blocksUse: boolean;
}

export interface ResourceAlert extends Finding {
  /** Stable: the same problem on the same record is the same alert. */
  id: string;
  subject: 'resource' | 'crew';
  subjectId: string;
  subjectName: string;
  category: ResourceCategory | null;
}
