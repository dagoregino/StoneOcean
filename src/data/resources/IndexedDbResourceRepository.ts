import type { CrewMember, Movement, Resource } from '../../domain/resources/types';
import type { OutboxEntry, ResourceRepository, ResourceSnapshot, WriteBatch } from './ResourceRepository';

const DB_NAME = 'helios-medical-resources';
const DB_VERSION = 1;
const STORES = ['resources', 'movements', 'crew', 'meta', 'outbox'] as const;

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });

/**
 * The module's records in the browser's own database. They stay on the device, survive
 * reloads and need no connection. Every write is one transaction: a movement and the new
 * count it produces are saved together or not at all.
 */
export class IndexedDbResourceRepository implements ResourceRepository {
  private db: Promise<IDBDatabase> | null = null;

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined';
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('resources')) db.createObjectStore('resources', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('movements')) db.createObjectStore('movements', { keyPath: 'id' }).createIndex('resourceId', 'resourceId');
        if (!db.objectStoreNames.contains('crew')) db.createObjectStore('crew', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('The local database could not be opened.'));
      req.onblocked = () => reject(new Error('The local database is in use by another tab. Close it and try again.'));
    });
    return this.db;
  }

  private async transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => T | Promise<T>): Promise<T> {
    const db = await this.open();
    const tx = db.transaction([...STORES], mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('The change could not be saved.'));
      tx.onabort = () => reject(tx.error ?? new Error('The change was not saved.'));
    });
    let result: T;
    try {
      result = await work(tx);
    } catch (error) {
      tx.abort();
      await done.catch(() => undefined);
      throw error;
    }
    await done;
    return result;
  }

  load(): Promise<ResourceSnapshot> {
    return this.transaction('readonly', async (tx) => {
      const [resources, movements, crew, acknowledged, seeded] = await Promise.all([
        request(tx.objectStore('resources').getAll() as IDBRequest<Resource[]>),
        request(tx.objectStore('movements').getAll() as IDBRequest<Movement[]>),
        request(tx.objectStore('crew').getAll() as IDBRequest<CrewMember[]>),
        request(tx.objectStore('meta').get('acknowledged') as IDBRequest<string[] | undefined>),
        request(tx.objectStore('meta').get('seeded') as IDBRequest<boolean | undefined>),
      ]);
      return { resources, movements, crew, acknowledged: acknowledged ?? [], seeded: seeded ?? false };
    });
  }

  write(batch: WriteBatch): Promise<void> {
    return this.transaction('readwrite', (tx) => {
      const at = new Date().toISOString();
      const outbox = tx.objectStore('outbox');
      const log = (entry: Omit<OutboxEntry, 'at'>): void => void outbox.add({ ...entry, at });
      for (const r of batch.resources ?? []) {
        tx.objectStore('resources').put(r);
        log({ entity: 'resource', id: r.id, op: 'put' });
      }
      // `add`, never `put`: an existing movement can not be overwritten, the transaction fails instead.
      for (const m of batch.movements ?? []) {
        tx.objectStore('movements').add(m);
        log({ entity: 'movement', id: m.id, op: 'put' });
      }
      for (const c of batch.crew ?? []) {
        tx.objectStore('crew').put(c);
        log({ entity: 'crew', id: c.id, op: 'put' });
      }
      for (const id of batch.deleteCrew ?? []) {
        tx.objectStore('crew').delete(id);
        log({ entity: 'crew', id, op: 'delete' });
      }
      if (batch.acknowledged) tx.objectStore('meta').put(batch.acknowledged, 'acknowledged');
      if (batch.seeded !== undefined) tx.objectStore('meta').put(batch.seeded, 'seeded');
    });
  }

  clear(): Promise<void> {
    return this.transaction('readwrite', (tx) => {
      for (const name of STORES) tx.objectStore(name).clear();
    });
  }

  outbox(): Promise<OutboxEntry[]> {
    return this.transaction('readonly', (tx) => request(tx.objectStore('outbox').getAll() as IDBRequest<OutboxEntry[]>));
  }
}
