import { toDictationError } from './errors';
import { joinSegments } from './transcript';
import type { DictationError, DictationState, SpeechEngine, SpeechSession } from './types';

export interface DictationSnapshot {
  state: DictationState;
  /** Words of the utterance in progress (listening only). */
  partial: string;
  /** Finished utterances so far; the whole transcript once `ready`. */
  transcript: string;
  error: DictationError | null;
}

type Listener = (snapshot: DictationSnapshot) => void;

const IDLE: DictationSnapshot = { state: 'idle', partial: '', transcript: '', error: null };

/**
 * The dictation state machine, independent of any recognizer:
 *
 *   idle ─start→ loading ─model ready→ listening ─stop→ processing ─last words→ ready
 *     ↑            │                      │                                    │
 *     └── cancel ──┴──────────────────────┴──── any failure → error ──start──→ …
 *
 * The engine is created on first use, so the recognizer and its model are only downloaded
 * when somebody actually presses the microphone button. A transcript is only text handed to
 * the caller: it is not saved, interpreted or sent anywhere from here.
 */
export class DictationController {
  private snap: DictationSnapshot = IDLE;
  private readonly listeners = new Set<Listener>();
  private engine: Promise<SpeechEngine> | null = null;
  private session: SpeechSession | null = null;
  private segments: string[] = [];
  /** Bumped by every start and cancel, so late answers from an old session are ignored. */
  private generation = 0;

  constructor(private readonly createEngine: () => Promise<SpeechEngine>) {}

  get snapshot(): DictationSnapshot {
    return this.snap;
  }

  /** True while the microphone is open or about to be. */
  get active(): boolean {
    return this.snap.state === 'loading' || this.snap.state === 'listening' || this.snap.state === 'processing';
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The microphone button: start when idle, stop when listening, cancel while loading. */
  toggle(): Promise<void> {
    if (this.snap.state === 'listening') return this.stop();
    if (this.snap.state === 'loading') {
      this.cancel();
      return Promise.resolve();
    }
    return this.start();
  }

  async start(): Promise<void> {
    if (this.active) return;
    const generation = ++this.generation;
    this.segments = [];
    this.set({ state: 'loading', partial: '', transcript: '', error: null });
    try {
      const engine = await this.loadEngine();
      if (generation !== this.generation) return;
      const session = await engine.start({
        onPartial: (text) => {
          if (generation === this.generation && this.snap.state === 'listening') this.set({ ...this.snap, partial: text });
        },
        onSegment: (text) => {
          if (generation !== this.generation) return;
          this.segments.push(text);
          this.set({ ...this.snap, partial: '', transcript: joinSegments(this.segments) });
        },
        onError: (error) => {
          if (generation !== this.generation) return;
          this.closeSession(true);
          this.fail(error);
        },
      });
      if (generation !== this.generation) {
        session.abort();
        return;
      }
      this.session = session;
      this.set({ state: 'listening', partial: '', transcript: '', error: null });
    } catch (error) {
      if (generation === this.generation) this.fail(toDictationError(error, 'model-failed'));
    }
  }

  /** Stops listening and waits for the last words. */
  async stop(): Promise<void> {
    if (this.snap.state !== 'listening' || !this.session) return;
    const generation = this.generation;
    const session = this.session;
    this.session = null;
    this.set({ ...this.snap, state: 'processing', partial: '' });
    try {
      const last = await session.finish();
      if (generation !== this.generation) return;
      this.segments.push(last);
      this.set({ state: 'ready', partial: '', transcript: joinSegments(this.segments), error: null });
    } catch (error) {
      if (generation === this.generation) this.fail(toDictationError(error, 'engine-failed'));
    }
  }

  /** Closes the microphone at once and forgets this session's words. */
  cancel(): void {
    this.generation++;
    this.closeSession(true);
    this.segments = [];
    if (this.snap !== IDLE) this.set(IDLE);
  }

  private loadEngine(): Promise<SpeechEngine> {
    if (!this.engine) {
      this.engine = this.createEngine().then(async (engine) => {
        await engine.load();
        return engine;
      });
      // A failed load can be retried with the next press.
      this.engine.catch(() => (this.engine = null));
    }
    return this.engine;
  }

  private closeSession(abort: boolean): void {
    if (abort) this.session?.abort();
    this.session = null;
  }

  private fail(error: DictationError): void {
    // Words recognized before the failure are kept in the snapshot, so nothing said is lost.
    this.set({ state: 'error', partial: '', transcript: joinSegments(this.segments), error });
  }

  private set(next: DictationSnapshot): void {
    this.snap = next;
    this.listeners.forEach((listener) => listener(next));
  }
}
