import type { CrewMember, Movement, Resource } from '../../domain/resources/types';

/** Everything the module keeps, as one snapshot. */
export interface ResourceSnapshot {
  resources: Resource[];
  movements: Movement[];
  crew: CrewMember[];
  /** Ids of alerts the crew has acknowledged. */
  acknowledged: string[];
  /** True once the demonstration data has been loaded, so it is not loaded twice. */
  seeded: boolean;
}

/**
 * One change to send to the ground when a link exists. Changes are queued in the order
 * they happen; a delay-tolerant (DTN) bundle agent can drain the queue later. Nothing
 * reads it yet: it is the hook for that integration.
 */
export interface OutboxEntry {
  entity: 'resource' | 'movement' | 'crew';
  id: string;
  op: 'put' | 'delete';
  at: string;
}

/** A group of writes that must all happen, or none. */
export interface WriteBatch {
  resources?: Resource[];
  movements?: Movement[];
  crew?: CrewMember[];
  deleteCrew?: string[];
  acknowledged?: string[];
  seeded?: boolean;
}

/**
 * Where the module's records live. The app uses IndexedDB (`IndexedDbResourceRepository`);
 * tests use memory. Movements are only ever added: there is no way to change or remove one.
 */
export interface ResourceRepository {
  load(): Promise<ResourceSnapshot>;
  write(batch: WriteBatch): Promise<void>;
  /** Removes every record: used to restart the demonstration. */
  clear(): Promise<void>;
  /** Changes not yet sent anywhere. */
  outbox(): Promise<OutboxEntry[]>;
}

export class MemoryResourceRepository implements ResourceRepository {
  private readonly resources = new Map<string, Resource>();
  private readonly movements = new Map<string, Movement>();
  private readonly crew = new Map<string, CrewMember>();
  private acknowledged: string[] = [];
  private seeded = false;
  private readonly queue: OutboxEntry[] = [];

  async load(): Promise<ResourceSnapshot> {
    return structuredClone({ resources: [...this.resources.values()], movements: [...this.movements.values()], crew: [...this.crew.values()], acknowledged: this.acknowledged, seeded: this.seeded });
  }

  async write(batch: WriteBatch): Promise<void> {
    const at = new Date().toISOString();
    for (const movement of batch.movements ?? []) {
      if (this.movements.has(movement.id)) throw new Error(`Movement ${movement.id} already exists: movements cannot be overwritten.`);
    }
    for (const r of batch.resources ?? []) {
      this.resources.set(r.id, structuredClone(r));
      this.queue.push({ entity: 'resource', id: r.id, op: 'put', at });
    }
    for (const m of batch.movements ?? []) {
      this.movements.set(m.id, structuredClone(m));
      this.queue.push({ entity: 'movement', id: m.id, op: 'put', at });
    }
    for (const c of batch.crew ?? []) {
      this.crew.set(c.id, structuredClone(c));
      this.queue.push({ entity: 'crew', id: c.id, op: 'put', at });
    }
    for (const id of batch.deleteCrew ?? []) {
      this.crew.delete(id);
      this.queue.push({ entity: 'crew', id, op: 'delete', at });
    }
    if (batch.acknowledged) this.acknowledged = [...batch.acknowledged];
    if (batch.seeded !== undefined) this.seeded = batch.seeded;
  }

  async clear(): Promise<void> {
    this.resources.clear();
    this.movements.clear();
    this.crew.clear();
    this.acknowledged = [];
    this.seeded = false;
    this.queue.length = 0;
  }

  async outbox(): Promise<OutboxEntry[]> {
    return [...this.queue];
  }
}
