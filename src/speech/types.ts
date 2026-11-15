/**
 * Voice dictation, as the rest of the app sees it. Nothing in this file (or in
 * `DictationController`) knows which recognizer is used: the Vosk adapter in `vosk/` is one
 * implementation of `SpeechEngine`, and the store and the domain never import any of it.
 *
 * Privacy contract for every engine: audio and text stay on the device. An engine may only
 * load files from the app's own origin and must not send audio or transcripts anywhere.
 */

export const DICTATION_STATES = ['idle', 'loading', 'listening', 'processing', 'ready', 'error'] as const;
export type DictationState = (typeof DICTATION_STATES)[number];

export type DictationErrorCode =
  /** The person (or a site setting) refused the microphone. */
  | 'permission-denied'
  /** No input device is connected or enabled. */
  | 'no-microphone'
  /** Another application holds the microphone, or the hardware failed. */
  | 'microphone-busy'
  /** getUserMedia is only offered on https:// or localhost. */
  | 'insecure-context'
  /** The browser lacks Web Workers, WebAssembly or Web Audio. */
  | 'unsupported'
  /** The voice model file is not installed in public/models/vosk/. */
  | 'model-missing'
  /** The model was found but could not be loaded or unpacked. */
  | 'model-failed'
  /** The recognizer stopped working while listening. */
  | 'engine-failed';

export class DictationError extends Error {
  constructor(readonly code: DictationErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = 'DictationError';
  }
}

/** What an engine reports while it listens. */
export interface SpeechCallbacks {
  /** The words heard so far in the current utterance; replaced on every call. */
  onPartial(text: string): void;
  /** A finished utterance (the recognizer detected a pause). */
  onSegment(text: string): void;
  /** The session cannot continue (device unplugged, recognizer crashed…). */
  onError(error: DictationError): void;
}

/** One listening session: from opening the microphone to the last word. */
export interface SpeechSession {
  /** Stops capturing and resolves with the words still pending in the recognizer. */
  finish(): Promise<string>;
  /** Stops at once and drops anything pending. */
  abort(): void;
}

export interface SpeechEngine {
  /** Loads the model. Safe to call again after it has resolved. */
  load(): Promise<void>;
  /** Opens the microphone and starts recognizing. Requires `load()` first. */
  start(callbacks: SpeechCallbacks): Promise<SpeechSession>;
}
