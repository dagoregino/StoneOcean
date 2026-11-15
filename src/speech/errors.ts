import { DictationError, type DictationErrorCode } from './types';

export interface DictationErrorText {
  title: string;
  help: string;
}

/** Plain-language explanations shown next to the microphone button. */
export const DICTATION_ERROR_TEXT: Record<DictationErrorCode, DictationErrorText> = {
  'permission-denied': {
    title: 'Microphone access is blocked.',
    help: 'Allow the microphone for this page in the browser’s site settings (the icon next to the address), then press “Try again”. You can always type the notes instead.',
  },
  'no-microphone': {
    title: 'No microphone was found.',
    help: 'Connect or enable a microphone, then press “Try again”.',
  },
  'microphone-busy': {
    title: 'The microphone could not be started.',
    help: 'Another application may be using it. Close that application, then press “Try again”.',
  },
  'insecure-context': {
    title: 'Dictation needs a secure page.',
    help: 'Browsers only allow the microphone on https:// addresses or on localhost.',
  },
  unsupported: {
    title: 'This browser cannot run offline dictation.',
    help: 'It needs Web Workers, WebAssembly and Web Audio. Use a current Chrome, Edge, Firefox or Safari, or type the notes.',
  },
  'model-missing': {
    title: 'The offline voice model is not installed.',
    help: 'Place the Vosk model in public/models/vosk/ (run “npm run model:vosk”, see public/models/vosk/README.md) and reload.',
  },
  'model-failed': {
    title: 'The offline voice model could not be loaded.',
    help: 'The file may be damaged or the device may be out of storage. Reload the page and try again.',
  },
  'engine-failed': {
    title: 'Dictation stopped unexpectedly.',
    help: 'Press “Try again”. What was already recognized has been kept.',
  },
};

/**
 * Maps a getUserMedia failure to a code. Browsers name these DOMExceptions differently,
 * so both the standard and the legacy names are listed.
 */
export function classifyMicrophoneError(error: unknown): DictationErrorCode {
  if (error instanceof DictationError) return error.code;
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'no-microphone';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'microphone-busy';
    case 'NotSupportedError':
    case 'TypeError':
      return 'unsupported';
    default:
      return 'microphone-busy';
  }
}

/** Any thrown value as a DictationError, keeping its code when it already has one. */
export function toDictationError(error: unknown, fallback: DictationErrorCode): DictationError {
  if (error instanceof DictationError) return error;
  const detail = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
  return new DictationError(fallback, detail);
}
