import { VoskClient, type KaldiRecognizer, type RecognizerMessage } from '@lichess-org/vosk-browser';
import wasmPath from '@lichess-org/vosk-browser/dist/vosk.wasm?url';
import workerPath from '@lichess-org/vosk-browser/dist/vosk.worker.js?url';
import { openMicrophone, type Microphone } from '../audio/microphone';
import { DictationError, type SpeechCallbacks, type SpeechEngine, type SpeechSession } from '../types';
import { assertModelInstalled, clearStoredModels, forgetModelCached, isModelCached, markModelCached, requestPersistentStorage, resolveLocalUrl } from './modelSource';

/** Unpacking a model on a slow device can take a while; past this, something is wrong. */
const LOAD_TIMEOUT_MS = 180_000;
/** How long to wait for the recognizer's last words after the microphone closes. */
const FINAL_RESULT_TIMEOUT_MS = 5_000;
/** Silences the library's info logs; it never logs transcripts below debug level. */
const LOG_LEVEL = -1;

export interface VoskEngineOptions {
  /** The model archive (.tar.gz), relative to the page. Must be on the page's own origin. */
  modelUrl: string;
}

/**
 * Offline speech recognition with Vosk (Kaldi compiled to WebAssembly).
 *
 * Recognition runs in the library's own Web Worker; the page only captures the microphone and
 * forwards samples to it. The worker, its WebAssembly binary and the model are all served by
 * this app, and nothing is sent anywhere else. This is the only file that imports Vosk: swap
 * it for another `SpeechEngine` and nothing else changes.
 */
export class VoskEngine implements SpeechEngine {
  private client: VoskClient | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly options: VoskEngineOptions) {}

  load(): Promise<void> {
    if (!this.loading) {
      this.loading = this.loadModel();
      this.loading.catch(() => (this.loading = null));
    }
    return this.loading;
  }

  private async loadModel(): Promise<void> {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') throw new DictationError('unsupported');
    // The worker resolves URLs against its own location, so every URL is made absolute here.
    const base = document.baseURI;
    const modelUrl = resolveLocalUrl(this.options.modelUrl, base);
    const workerUrl = resolveLocalUrl(workerPath, base);
    const wasmUrl = resolveLocalUrl(wasmPath, base);
    if (!isModelCached(modelUrl)) await assertModelInstalled(modelUrl);

    let client: VoskClient;
    try {
      client = new VoskClient({ modelUrl, workerUrl, wasmUrl, logLevel: LOG_LEVEL });
    } catch (error) {
      // Module workers are missing in some older browsers.
      throw new DictationError('unsupported', error instanceof Error ? error.message : undefined);
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new DictationError('model-failed', 'Timed out loading the voice model')), LOAD_TIMEOUT_MS);
        client.on('load', (message) => {
          clearTimeout(timer);
          if ('result' in message && message.result) resolve();
          else reject(new DictationError('model-failed'));
        });
        client.on('error', (message) => {
          clearTimeout(timer);
          reject(new DictationError('model-failed', 'error' in message ? message.error : undefined));
        });
      });
    } catch (error) {
      forgetModelCached();
      stopWorker(client);
      await clearStoredModels();
      throw error;
    }
    this.client = client;
    markModelCached(modelUrl);
    requestPersistentStorage();
  }

  async start(callbacks: SpeechCallbacks): Promise<SpeechSession> {
    const client = this.client;
    if (!client?.ready) throw new DictationError('model-failed', 'The voice model is not loaded');

    let recognizer: KaldiRecognizer | null = null;
    let closed = false;
    let chunksSent = 0;
    let answers = 0;
    // Each audio chunk gets exactly one answer from the worker, so the answer after the last
    // chunk's is the final result.
    let finishing: { after: number; resolve: (text: string) => void } | null = null;

    const settle = (text: string): void => {
      const pending = finishing;
      finishing = null;
      pending?.resolve(text);
      recognizer?.remove();
      recognizer = null;
    };

    const onMessage = (message: RecognizerMessage): void => {
      answers++;
      const isFinal = finishing !== null && answers > finishing.after;
      if (message.event === 'error') {
        if (isFinal) settle('');
        else if (!closed) callbacks.onError(new DictationError('engine-failed', message.error));
        return;
      }
      if (message.event === 'partialresult') {
        if (!closed) callbacks.onPartial(message.result.partial);
        return;
      }
      if (isFinal) settle(message.result.text);
      else callbacks.onSegment(message.result.text);
    };

    const microphone: Microphone = await openMicrophone((samples, sampleRate) => {
      if (closed) return;
      if (!recognizer) {
        recognizer = new client.KaldiRecognizer(sampleRate);
        recognizer.on('result', onMessage);
        recognizer.on('partialresult', onMessage);
        recognizer.on('error', onMessage);
      }
      chunksSent++;
      recognizer.acceptWaveformFloat(samples, sampleRate);
    });

    return {
      finish: () =>
        new Promise<string>((resolve) => {
          if (closed) return resolve('');
          closed = true;
          microphone.close();
          if (!recognizer) return resolve('');
          finishing = { after: chunksSent, resolve };
          recognizer.retrieveFinalResult();
          setTimeout(() => settle(''), FINAL_RESULT_TIMEOUT_MS);
        }),
      abort: () => {
        if (!closed) microphone.close();
        closed = true;
        settle('');
      },
    };
  }
}

/**
 * Ends the recognizer's worker at once. The library's own `terminate()` message fails inside
 * the worker when no model was loaded, which would leave it running and holding the database.
 */
function stopWorker(client: VoskClient): void {
  const worker = (client as unknown as { worker?: Worker }).worker;
  if (worker instanceof Worker) worker.terminate();
  else {
    try {
      client.terminate();
    } catch {
      // Already gone.
    }
  }
}
