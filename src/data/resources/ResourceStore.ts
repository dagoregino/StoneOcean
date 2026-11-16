import { ruleById, RULES } from '../../domain/evidence/catalog';
import type { MedicalPlan } from '../../domain/medicalPlan';
import { computeAlerts } from '../../domain/resources/findings';
import { parseInventoryFile, type ImportResult } from '../../domain/resources/importing';
import { applyMovement, nextId, normalizeId, ResourceError, toTypeCode, validateResource, type FieldErrors } from '../../domain/resources/inventory';
import { procedureName } from '../../domain/resources/protocols';
import { assessProtocol, type ProtocolReadiness } from '../../domain/resources/readiness';
import { demoSeed } from '../../domain/resources/seed';
import { isDateString } from '../../domain/resources/dates';
import {
  CREW_AVAILABILITY,
  TRAINING_LEVELS,
  type CrewInput,
  type CrewMember,
  type Movement,
  type MovementInput,
  type Resource,
  type ResourceAlert,
  type ResourceInput,
} from '../../domain/resources/types';
import { Emitter } from '../Emitter';
import type { ResourceRepository } from './ResourceRepository';

export interface ResourceStoreEvents extends Record<string, unknown> {
  /** Something in the inventory, the roster or the alerts changed. */
  change: void;
}

export interface ResourceStoreOptions {
  /** Who is recorded as responsible for a movement. */
  currentUser: () => string;
  /** The clock; injected so tests can fix the date. */
  now?: () => Date;
}

const clean = <T extends object>(value: T): T => {
  // Empty optional fields are stored as absent, not as empty strings.
  const copy = { ...value } as Record<string, unknown>;
  for (const [key, entry] of Object.entries(copy)) {
    if (entry === '' || entry === undefined) delete copy[key];
    else if (typeof entry === 'string') copy[key] = entry.trim();
  }
  return copy as T;
};

/**
 * The medical resources service: the one place that changes inventory, movements and the
 * crew roster. It validates with the domain rules, saves through the repository, and only
 * then updates what the screens see, so the screen never shows something that was not saved.
 *
 * Reads are synchronous (the state is kept in memory after `init`); writes are async.
 */
export class ResourceStore {
  readonly events = new Emitter<ResourceStoreEvents>();
  private resourceMap = new Map<string, Resource>();
  private movementList: Movement[] = [];
  private crewMap = new Map<string, CrewMember>();
  private acknowledgedIds = new Set<string>();
  private isReady = false;
  private failure: string | null = null;
  private sequence = 0;
  private readonly channel: BroadcastChannel | null;
  private readonly now: () => Date;

  constructor(
    private readonly repository: ResourceRepository,
    private readonly options: ResourceStoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    // Cross-tab sync: a write in one tab tells the others to reload from IndexedDB.
    // shortcut: no conflict resolution; last write wins. Upgrade path: per-record versioning + merge.
    this.channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('helios-resources') : null;
    this.channel?.addEventListener('message', () => void this.refresh());
  }

  /** Loads what is saved. On the very first run, loads the demonstration data instead. */
  async init(): Promise<void> {
    try {
      let snapshot = await this.repository.load();
      if (!snapshot.seeded && snapshot.resources.length === 0) {
        await this.seed();
        snapshot = await this.repository.load();
      }
      this.adopt(snapshot);
      this.failure = null;
    } catch (error) {
      this.failure = error instanceof Error ? error.message : 'The local database could not be opened.';
    }
    this.isReady = true;
    this.emitChange();
  }

  private emitChange(): void {
    this.events.emit('change', undefined);
    this.channel?.postMessage('changed');
  }

  /** Reload from IndexedDB (used after a write in another tab). */
  async refresh(): Promise<void> {
    if (!this.isReady) return;
    try {
      const snapshot = await this.repository.load();
      this.adopt(snapshot);
      this.events.emit('change', undefined);
    } catch {
      // Keep the current in-memory state if reload fails.
    }
  }

  get ready(): boolean {
    return this.isReady;
  }
  /** Why the records could not be loaded, if they could not. */
  get error(): string | null {
    return this.failure;
  }
  get today(): Date {
    return this.now();
  }
  get resources(): Resource[] {
    return [...this.resourceMap.values()];
  }
  get activeResources(): Resource[] {
    return this.resources.filter((r) => r.active);
  }
  resource(id: string): Resource | undefined {
    return this.resourceMap.get(normalizeId(id));
  }
  /** Newest first. */
  get movements(): readonly Movement[] {
    return this.movementList;
  }
  movementsOf(resourceId: string): Movement[] {
    return this.movementList.filter((m) => m.resourceId === resourceId);
  }
  get crew(): CrewMember[] {
    return [...this.crewMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  /** Open alerts that nobody has acknowledged yet, worst first. */
  get alerts(): ResourceAlert[] {
    return this.allAlerts.filter((alert) => !this.acknowledgedIds.has(alert.id));
  }
  get allAlerts(): ResourceAlert[] {
    return computeAlerts(this.activeResources, this.crew, this.now(), procedureName);
  }
  isAcknowledged(alertId: string): boolean {
    return this.acknowledgedIds.has(alertId);
  }
  /** True while any record on screen is demonstration data. */
  get hasSimulatedData(): boolean {
    return this.resources.some((r) => r.simulated) || this.crew.some((c) => c.simulated);
  }

  /** Can this protocol be carried out with what is on board and who is trained? */
  readiness(ruleId: string, plan: MedicalPlan): ProtocolReadiness | null {
    const rule = ruleById(ruleId);
    return rule ? assessProtocol(rule, this.activeResources, this.crew, plan, this.now()) : null;
  }
  readinessOfAll(plan: MedicalPlan): ProtocolReadiness[] {
    return RULES.map((rule) => assessProtocol(rule, this.activeResources, this.crew, plan, this.now()));
  }

  /** Looks a record up from what a scanner or a person typed: a QR payload or a bare identifier. */
  findByCode(code: string): Resource | undefined {
    const match = /(?:HELIOS:RES:)?([A-Za-z0-9-]+)\s*$/.exec(code.trim());
    return match ? this.resource(match[1]) : undefined;
  }

  // ---------- Inventory ----------

  /** Registers a record. Its starting count is written to the history as an entry. */
  async createResource(input: ResourceInput, simulated = false): Promise<Resource> {
    const [resource, movement] = this.buildNew(input, this.resources, simulated, 'First registration');
    await this.repository.write({ resources: [resource], movements: movement ? [movement] : [] });
    this.resourceMap.set(resource.id, resource);
    if (movement) this.movementList.unshift(movement);
    this.emitChange();
    return resource;
  }

  /**
   * Changes a record's details. The count is not editable here: it only ever changes
   * through a movement, so the history always explains it.
   */
  async updateResource(id: string, input: ResourceInput): Promise<Resource> {
    const current = this.mustGet(id);
    const next: ResourceInput = { ...input, id: undefined, category: current.category, quantity: current.quantity };
    const errors = validateResource(next, this.resources.filter((r) => r.id !== current.id));
    this.throwIfInvalid(errors);
    const updated: Resource = { ...current, ...clean(next), id: current.id, typeCode: toTypeCode(next.typeCode), quantity: current.quantity, reserved: current.reserved, updatedAt: this.now().toISOString() };
    // Fields cleared in the form are removed, not kept from before.
    for (const key of Object.keys(current) as (keyof Resource)[]) {
      if (!(key in clean(next)) && !['id', 'reserved', 'active', 'simulated', 'createdAt', 'updatedAt', 'quantity', 'category'].includes(key)) delete (updated as Partial<Resource>)[key];
    }
    if (next.minStock === null) updated.minStock = null;
    await this.repository.write({ resources: [updated] });
    this.resourceMap.set(updated.id, updated);
    this.emitChange();
    return updated;
  }

  /** Takes a record out of use, or back into it. Nothing is deleted: its history stays. */
  async setActive(id: string, active: boolean): Promise<void> {
    const current = this.mustGet(id);
    if (current.active === active) return;
    const updated = { ...current, active, updatedAt: this.now().toISOString() };
    await this.repository.write({ resources: [updated] });
    this.resourceMap.set(updated.id, updated);
    this.emitChange();
  }

  /** Records a movement and the count it produces, together. */
  async recordMovement(input: MovementInput): Promise<Movement> {
    const current = this.mustGet(input.resourceId);
    const result = applyMovement(current, input);
    const at = this.now().toISOString();
    const movement = this.buildMovement(current, input, result, at, this.options.currentUser());
    const updated: Resource = { ...current, ...result, updatedAt: at };
    await this.repository.write({ resources: [updated], movements: [movement] });
    this.resourceMap.set(updated.id, updated);
    this.movementList.unshift(movement);
    this.emitChange();
    return movement;
  }

  /** Checks a file without saving anything, so the crew can review it first. */
  previewImport(content: string, format: 'csv' | 'json'): ImportResult {
    return parseInventoryFile(content, format, this.resources);
  }

  /** Saves the rows of a file that passed every check, all together. */
  async importResources(inputs: readonly ResourceInput[]): Promise<number> {
    const resources: Resource[] = [];
    const movements: Movement[] = [];
    for (const input of inputs) {
      const [resource, movement] = this.buildNew(input, [...this.resources, ...resources], false, 'Imported from file');
      resources.push(resource);
      if (movement) movements.push(movement);
    }
    if (resources.length === 0) return 0;
    await this.repository.write({ resources, movements });
    for (const r of resources) this.resourceMap.set(r.id, r);
    this.movementList.unshift(...movements.reverse());
    this.emitChange();
    return resources.length;
  }

  // ---------- Crew ----------

  async saveCrewMember(input: CrewInput): Promise<CrewMember> {
    const errors: FieldErrors = {};
    if (!input.name?.trim()) errors.name = 'Give the crew member a name.';
    if (!input.role?.trim()) errors.role = 'Say what their role is.';
    if (!CREW_AVAILABILITY.includes(input.availability)) errors.availability = 'Choose an availability.';
    const seen = new Set<string>();
    input.certifications.forEach((cert, i) => {
      const at = `certifications.${i}`;
      if (!cert.procedureCode) errors[at] = 'Choose a procedure.';
      else if (seen.has(cert.procedureCode)) errors[at] = `${procedureName(cert.procedureCode)} is listed twice.`;
      else if (!TRAINING_LEVELS.includes(cert.level)) errors[at] = 'Choose a level.';
      else if (!isDateString(cert.certifiedOn)) errors[at] = 'Enter the certification date.';
      else if (cert.expiresOn && !isDateString(cert.expiresOn)) errors[at] = 'The expiry is not a real date.';
      else if (cert.expiresOn && cert.expiresOn < cert.certifiedOn) errors[at] = 'The expiry is before the certification date.';
      seen.add(cert.procedureCode);
    });
    const id = input.id ?? this.nextCrewId();
    if (!input.id && this.crew.some((c) => c.name.trim().toLowerCase() === input.name?.trim().toLowerCase())) errors.name = 'A crew member with this name is already registered.';
    this.throwIfInvalid(errors);
    const member: CrewMember = {
      id,
      name: input.name.trim(),
      role: input.role.trim(),
      availability: input.availability,
      certifications: input.certifications.map((c) => clean(c)),
      simulated: this.crewMap.get(id)?.simulated ?? false,
      updatedAt: this.now().toISOString(),
    };
    await this.repository.write({ crew: [member] });
    this.crewMap.set(member.id, member);
    this.emitChange();
    return member;
  }

  async removeCrewMember(id: string): Promise<void> {
    if (!this.crewMap.has(id)) return;
    await this.repository.write({ deleteCrew: [id] });
    this.crewMap.delete(id);
    this.emitChange();
  }

  // ---------- Alerts ----------

  /** Marks an alert as seen. It comes back by itself if the same problem appears again later. */
  async acknowledge(alertId: string, acknowledged = true): Promise<void> {
    if (acknowledged) this.acknowledgedIds.add(alertId);
    else this.acknowledgedIds.delete(alertId);
    // Alerts that no longer exist are dropped from the list, so a problem that returns is shown again.
    const open = new Set(this.allAlerts.map((a) => a.id));
    this.acknowledgedIds = new Set([...this.acknowledgedIds].filter((id) => open.has(id)));
    await this.repository.write({ acknowledged: [...this.acknowledgedIds] });
    this.emitChange();
  }

  // ---------- Demonstration data ----------

  /** Erases everything and loads the demonstration data again. */
  async resetDemo(): Promise<void> {
    await this.repository.clear();
    await this.seed();
    this.adopt(await this.repository.load());
    this.emitChange();
  }

  private async seed(): Promise<void> {
    const now = this.now();
    const seed = demoSeed(now);
    const resources = new Map<string, Resource>();
    const movements: Movement[] = [];
    const stamp = (daysAgo: number, minute: number): string => new Date(now.getTime() - daysAgo * 86_400_000 + minute * 60_000).toISOString();
    seed.resources.forEach((input, index) => {
      const resource: Resource = { ...clean(input), typeCode: toTypeCode(input.typeCode), reserved: 0, active: true, simulated: true, createdAt: stamp(60, index), updatedAt: stamp(60, index) };
      resources.set(resource.id, resource);
      movements.push(this.buildMovement(resource, { resourceId: resource.id, type: 'entry', quantity: resource.quantity, reason: 'Loaded before launch (simulated)' }, resource, stamp(60, index), 'Ground logistics'));
    });
    seed.movements.forEach((entry, index) => {
      const current = resources.get(entry.resourceId)!;
      const result = applyMovement(current, entry);
      const at = stamp(entry.daysAgo, index);
      movements.push(this.buildMovement(current, entry, result, at, entry.user));
      resources.set(current.id, { ...current, ...result, updatedAt: at });
    });
    const crew: CrewMember[] = seed.crew.map((member) => ({ ...member, simulated: true, updatedAt: now.toISOString() }));
    await this.repository.write({ resources: [...resources.values()], movements, crew, acknowledged: [], seeded: true });
  }

  // ---------- Helpers ----------

  private adopt(snapshot: Awaited<ReturnType<ResourceRepository['load']>>): void {
    this.resourceMap = new Map(snapshot.resources.map((r) => [r.id, r]));
    this.movementList = [...snapshot.movements].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    this.crewMap = new Map(snapshot.crew.map((c) => [c.id, c]));
    this.acknowledgedIds = new Set(snapshot.acknowledged);
  }

  private buildNew(input: ResourceInput, others: readonly Resource[], simulated: boolean, reason: string): [Resource, Movement | null] {
    this.throwIfInvalid(validateResource(input, others));
    const at = this.now().toISOString();
    const id = input.id ? normalizeId(input.id) : nextId(input.category, others.map((r) => r.id));
    const resource: Resource = { ...clean(input), id, typeCode: toTypeCode(input.typeCode), minStock: input.minStock, reserved: 0, active: true, simulated, createdAt: at, updatedAt: at };
    const movement = resource.quantity > 0 ? this.buildMovement(resource, { resourceId: id, type: 'entry', quantity: resource.quantity, reason }, resource, at, this.options.currentUser()) : null;
    return [resource, movement];
  }

  private buildMovement(resource: Resource, input: MovementInput, balance: { quantity: number; reserved: number }, at: string, user: string): Movement {
    return {
      id: `MOV-${at.replace(/\D/g, '').slice(0, 17)}-${String(++this.sequence).padStart(4, '0')}`,
      resourceId: resource.id,
      resourceName: resource.name,
      type: input.type,
      quantity: input.quantity,
      at,
      user,
      reason: input.reason.trim(),
      notes: input.notes?.trim() ?? '',
      balance: { quantity: balance.quantity, reserved: balance.reserved },
    };
  }

  private nextCrewId(): string {
    let max = 0;
    for (const id of this.crewMap.keys()) max = Math.max(max, Number(id.replace(/\D/g, '')) || 0);
    return `CREW-${String(max + 1).padStart(2, '0')}`;
  }

  private mustGet(id: string): Resource {
    const resource = this.resource(id);
    if (!resource) throw new ResourceError(`No record with identifier ${id}.`, { resourceId: `No record with identifier ${id}.` });
    return resource;
  }

  private throwIfInvalid(errors: FieldErrors): void {
    const messages = Object.values(errors).filter((m): m is string => Boolean(m));
    if (messages.length > 0) throw new ResourceError(messages[0], errors);
  }
}
