import { DictationError } from '../types';

/**
 * Where the Vosk model comes from, and how we make sure that is this device.
 *
 * The model is a static file in `public/models/vosk/`, served by the app itself. The
 * recognizer unpacks it once into IndexedDB (keyed by its URL) and reads it from there on
 * every later visit, so dictation keeps working with no network at all.
 */

/**
 * Resolves `path` against the page and refuses anything outside the page's own origin:
 * the recognizer must never be pointed at a remote server.
 */
export function resolveLocalUrl(path: string, base: string): string {
  const baseUrl = new URL(base);
  const url = new URL(path, baseUrl);
  if (url.origin !== baseUrl.origin) throw new DictationError('model-failed', `Refusing to load speech files from another origin: ${url.origin}`);
  return url.href;
}

const READY_KEY = 'crew-health-twin:vosk-model-ready';

/** True once this model URL has been unpacked into this browser's storage. */
export function isModelCached(modelUrl: string, storage: Pick<Storage, 'getItem'> | undefined = safeStorage()): boolean {
  try {
    return storage?.getItem(READY_KEY) === modelUrl;
  } catch {
    return false;
  }
}

export function markModelCached(modelUrl: string, storage: Pick<Storage, 'setItem'> | undefined = safeStorage()): void {
  try {
    storage?.setItem(READY_KEY, modelUrl);
  } catch {
    // Private mode or storage full: dictation still works, it just checks the file again next time.
  }
}

/** After a failed load: check the file again next time instead of trusting the stored copy. */
export function forgetModelCached(storage: Pick<Storage, 'removeItem'> | undefined = safeStorage()): void {
  try {
    storage?.removeItem(READY_KEY);
  } catch {
    // Nothing to forget.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Checks, before the worker downloads it, that the model file is really there. A missing file
 * gets a clear "not installed" message instead of an opaque unpacking error.
 * A network failure is not treated as missing: an unpacked copy may already be stored.
 */
export async function assertModelInstalled(modelUrl: string, fetcher: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(modelUrl, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
  } catch {
    return;
  }
  // Dev servers answer unknown paths with the app's index.html.
  const html = (response.headers.get('content-type') ?? '').includes('text/html');
  if (response.status === 404 || response.status === 410 || (response.ok && html)) {
    throw new DictationError('model-missing', `No voice model at ${modelUrl}`);
  }
}

/** IndexedDB database where the Vosk worker keeps unpacked models (its Emscripten IDBFS mount point). */
export const VOSK_STORE_NAME = '/vosk';

/**
 * Deletes the unpacked models. Needed after a failed load: Vosk marks a bad archive as
 * unpacked and would otherwise never fetch the file again, even once it has been replaced.
 */
export function clearStoredModels(idb: Pick<IDBFactory, 'deleteDatabase'> | undefined = globalThis.indexedDB): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (!idb) return resolve();
      const request = idb.deleteDatabase(VOSK_STORE_NAME);
      request.onsuccess = request.onerror = () => resolve();
      // Still open somewhere (another tab): it is deleted once that closes; do not wait for it.
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** Asks the browser not to evict the unpacked model under storage pressure. Best effort. */
export function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    // Not offered: the model is simply unpacked again if the browser ever clears it.
  }
}
