import { describe, expect, it, vi } from 'vitest';
import { DictationController, type DictationSnapshot } from '../src/speech/DictationController';
import { classifyMicrophoneError, DICTATION_ERROR_TEXT } from '../src/speech/errors';
import { appendTranscript, joinSegments } from '../src/speech/transcript';
import { DictationError, type SpeechCallbacks, type SpeechEngine, type SpeechSession } from '../src/speech/types';
import { assertModelInstalled, forgetModelCached, isModelCached, markModelCached, resolveLocalUrl } from '../src/speech/vosk/modelSource';

/** A recognizer stand-in: the test decides what it "hears". */
class FakeEngine implements SpeechEngine {
  loads = 0;
  starts = 0;
  callbacks: SpeechCallbacks | null = null;
  aborted = 0;
  finalWords = '';
  failLoad: DictationError | null = null;
  failStart: DictationError | null = null;
  private releaseLoad: (() => void) | null = null;
  holdLoad = false;

  load(): Promise<void> {
    this.loads++;
    if (this.failLoad) return Promise.reject(this.failLoad);
    if (this.holdLoad) return new Promise((resolve) => (this.releaseLoad = resolve));
    return Promise.resolve();
  }

  finishLoad(): void {
    this.releaseLoad?.();
  }

  async start(callbacks: SpeechCallbacks): Promise<SpeechSession> {
    this.starts++;
    if (this.failStart) throw this.failStart;
    this.callbacks = callbacks;
    return {
      finish: async () => this.finalWords,
      abort: () => {
        this.aborted++;
      },
    };
  }
}

const setup = (engine = new FakeEngine()) => {
  const controller = new DictationController(async () => engine);
  const states: string[] = [];
  controller.subscribe((s: DictationSnapshot) => {
    if (states[states.length - 1] !== s.state) states.push(s.state);
  });
  return { engine, controller, states };
};

describe('dictation controller', () => {
  it('goes idle → loading → listening → processing → ready, with partials and the joined transcript', async () => {
    const { engine, controller, states } = setup();
    await controller.start();
    expect(controller.snapshot.state).toBe('listening');

    engine.callbacks!.onPartial('i feel');
    expect(controller.snapshot.partial).toBe('i feel');
    engine.callbacks!.onSegment('i feel dizzy');
    expect(controller.snapshot.transcript).toBe('i feel dizzy');
    expect(controller.snapshot.partial).toBe('');
    engine.callbacks!.onPartial('after');

    engine.finalWords = 'after exercise';
    await controller.stop();
    expect(controller.snapshot).toEqual({ state: 'ready', partial: '', transcript: 'i feel dizzy after exercise', error: null });
    expect(states).toEqual(['loading', 'listening', 'processing', 'ready']);
  });

  it('loads the engine once and reuses it for the next session', async () => {
    let created = 0;
    const engine = new FakeEngine();
    const controller = new DictationController(async () => {
      created++;
      return engine;
    });
    await controller.start();
    await controller.stop();
    await controller.start();
    expect(created).toBe(1);
    expect(engine.loads).toBe(1);
    expect(engine.starts).toBe(2);
    // A new session starts with an empty transcript.
    expect(controller.snapshot.transcript).toBe('');
  });

  it('toggle starts, then stops', async () => {
    const { controller } = setup();
    await controller.toggle();
    expect(controller.snapshot.state).toBe('listening');
    await controller.toggle();
    expect(controller.snapshot.state).toBe('ready');
  });

  it('cancel during loading never opens the microphone', async () => {
    const engine = new FakeEngine();
    engine.holdLoad = true;
    const { controller } = setup(engine);
    const started = controller.start();
    await Promise.resolve();
    expect(controller.snapshot.state).toBe('loading');
    controller.cancel();
    engine.finishLoad();
    await started;
    expect(engine.starts).toBe(0);
    expect(controller.snapshot.state).toBe('idle');
  });

  it('cancel while listening aborts the session and drops its words', async () => {
    const { engine, controller } = setup();
    await controller.start();
    engine.callbacks!.onSegment('something private');
    controller.cancel();
    expect(engine.aborted).toBe(1);
    expect(controller.snapshot).toEqual({ state: 'idle', partial: '', transcript: '', error: null });
    // Late answers from the old session are ignored.
    engine.callbacks!.onSegment('late');
    expect(controller.snapshot.transcript).toBe('');
  });

  it('reports a refused microphone as an error and can try again', async () => {
    const engine = new FakeEngine();
    engine.failStart = new DictationError('permission-denied');
    const { controller } = setup(engine);
    await controller.start();
    expect(controller.snapshot.state).toBe('error');
    expect(controller.snapshot.error?.code).toBe('permission-denied');

    engine.failStart = null;
    await controller.start();
    expect(controller.snapshot.state).toBe('listening');
  });

  it('retries a failed model load on the next press', async () => {
    const engine = new FakeEngine();
    engine.failLoad = new DictationError('model-missing');
    const { controller } = setup(engine);
    await controller.start();
    expect(controller.snapshot.error?.code).toBe('model-missing');
    engine.failLoad = null;
    await controller.start();
    expect(controller.snapshot.state).toBe('listening');
    expect(engine.loads).toBe(2);
  });

  it('keeps what was recognized when the engine fails while listening', async () => {
    const { engine, controller } = setup();
    await controller.start();
    engine.callbacks!.onSegment('my vision is blurry');
    engine.callbacks!.onError(new DictationError('engine-failed'));
    expect(controller.snapshot.state).toBe('error');
    expect(controller.snapshot.transcript).toBe('my vision is blurry');
    expect(engine.aborted).toBe(1);
  });

  it('turns unexpected failures into a dictation error', async () => {
    const controller = new DictationController(async () => {
      throw new Error('chunk failed to load');
    });
    await controller.start();
    expect(controller.snapshot.error).toBeInstanceOf(DictationError);
    expect(controller.snapshot.error?.code).toBe('model-failed');
  });
});

describe('microphone errors', () => {
  const named = (name: string) => Object.assign(new Error(name), { name });

  it('maps browser exceptions to clear causes', () => {
    expect(classifyMicrophoneError(named('NotAllowedError'))).toBe('permission-denied');
    expect(classifyMicrophoneError(named('PermissionDeniedError'))).toBe('permission-denied');
    expect(classifyMicrophoneError(named('NotFoundError'))).toBe('no-microphone');
    expect(classifyMicrophoneError(named('OverconstrainedError'))).toBe('no-microphone');
    expect(classifyMicrophoneError(named('NotReadableError'))).toBe('microphone-busy');
    expect(classifyMicrophoneError(new DictationError('insecure-context'))).toBe('insecure-context');
  });

  it('has a title and a way forward for every error', () => {
    for (const text of Object.values(DICTATION_ERROR_TEXT)) {
      expect(text.title.length).toBeGreaterThan(0);
      expect(text.help.length).toBeGreaterThan(0);
    }
    expect(DICTATION_ERROR_TEXT['permission-denied'].help).toMatch(/site settings/);
  });
});

describe('transcript into notes', () => {
  it('joins utterances and drops empty ones', () => {
    expect(joinSegments(['  i feel ', '', 'dizzy\n'])).toBe('i feel dizzy');
  });

  it('appends after existing notes and capitalizes a new sentence only', () => {
    expect(appendTranscript('', 'dizzy since lunch', 280)).toEqual({ value: 'Dizzy since lunch', truncated: false });
    expect(appendTranscript('Started at 9.', 'worse now', 280).value).toBe('Started at 9. Worse now');
    expect(appendTranscript('Started at 9', 'and worse now', 280).value).toBe('Started at 9 and worse now');
    expect(appendTranscript('Kept as is', '   ', 280)).toEqual({ value: 'Kept as is', truncated: false });
  });

  it('never exceeds the notes limit and says when it cut', () => {
    const result = appendTranscript('x'.repeat(250), 'the rest of a long sentence that does not fit', 280);
    expect(result.truncated).toBe(true);
    expect(result.value.length).toBeLessThanOrEqual(280);
    expect(result.value.startsWith('x'.repeat(250))).toBe(true);
  });
});

describe('local voice model', () => {
  it('resolves the model on the page origin and refuses any other origin', () => {
    expect(resolveLocalUrl('./models/vosk/m.tar.gz', 'https://app.example/twin/index.html')).toBe('https://app.example/twin/models/vosk/m.tar.gz');
    expect(resolveLocalUrl('/assets/vosk.wasm', 'http://localhost:5173/')).toBe('http://localhost:5173/assets/vosk.wasm');
    expect(() => resolveLocalUrl('https://cdn.example/model.tar.gz', 'https://app.example/')).toThrow(DictationError);
    expect(() => resolveLocalUrl('//cdn.example/model.tar.gz', 'https://app.example/')).toThrow(DictationError);
  });

  it('says "not installed" for a missing file or a dev-server HTML fallback, and trusts a stored copy when offline', async () => {
    const respond = (status: number, type: string) => vi.fn(async () => new Response(null, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;
    await expect(assertModelInstalled('http://localhost/m.tar.gz', respond(404, 'text/plain'))).rejects.toMatchObject({ code: 'model-missing' });
    await expect(assertModelInstalled('http://localhost/m.tar.gz', respond(200, 'text/html'))).rejects.toMatchObject({ code: 'model-missing' });
    await expect(assertModelInstalled('http://localhost/m.tar.gz', respond(200, 'application/gzip'))).resolves.toBeUndefined();
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    await expect(assertModelInstalled('http://localhost/m.tar.gz', offline)).resolves.toBeUndefined();
  });

  it('remembers which model has been unpacked on this device', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
      removeItem: (k: string) => void values.delete(k),
    };
    expect(isModelCached('http://localhost/m.tar.gz', storage)).toBe(false);
    markModelCached('http://localhost/m.tar.gz', storage);
    expect(isModelCached('http://localhost/m.tar.gz', storage)).toBe(true);
    expect(isModelCached('http://localhost/other.tar.gz', storage)).toBe(false);
    forgetModelCached(storage);
    expect(isModelCached('http://localhost/m.tar.gz', storage)).toBe(false);
  });
});

describe('layering', () => {
  // Source text of every module, read through Vite (no Node APIs needed).
  const sources = import.meta.glob<string>('../src/**/*.ts', { query: '?raw', import: 'default', eager: true });
  const under = (dir: string) => Object.entries(sources).filter(([path]) => path.startsWith(`../src/${dir}/`));

  it('keeps the store and the domain independent of speech recognition', () => {
    const checked = [...under('domain'), ...under('data')];
    expect(checked.length).toBeGreaterThan(10);
    for (const [file, source] of checked) {
      expect(source, file).not.toMatch(/vosk/i);
      expect(source, file).not.toMatch(/from '[^']*speech\//);
    }
  });

  it('imports Vosk from a single adapter file', () => {
    const importers = Object.entries(sources)
      .filter(([, source]) => /from '@lichess-org\/vosk-browser/.test(source))
      .map(([file]) => file);
    expect(importers).toEqual(['../src/speech/vosk/VoskEngine.ts']);
  });

  it('never uses the browser SpeechRecognition API', () => {
    for (const [file, source] of under('speech')) expect(source, file).not.toMatch(/SpeechRecognition|webkitSpeech/);
  });
});
