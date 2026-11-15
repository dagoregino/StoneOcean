import { classifyMicrophoneError } from '../errors';
import { DictationError } from '../types';

/** Raw microphone samples, mono, as floats in [-1, 1]. */
export type ChunkHandler = (samples: Float32Array, sampleRate: number) => void;

export interface Microphone {
  readonly sampleRate: number;
  /** Releases the device: the browser's recording indicator goes off. */
  close(): void;
}

const CHUNK_FRAMES = 2048;
const PROCESSOR_NAME = 'crew-dictation-capture';

/**
 * The capture step runs on the audio rendering thread. It only batches samples and hands
 * them to the page, which passes them straight to the recognizer's worker.
 * Inlined (and loaded from a blob: URL) so it needs no separate file and no network.
 */
const WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(${CHUNK_FRAMES});
    this.length = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let offset = 0;
    while (offset < channel.length) {
      const n = Math.min(channel.length - offset, this.buffer.length - this.length);
      this.buffer.set(channel.subarray(offset, offset + n), this.length);
      this.length += n;
      offset += n;
      if (this.length === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(${CHUNK_FRAMES});
        this.length = 0;
      }
    }
    return true;
  }
}
registerProcessor('${PROCESSOR_NAME}', CaptureProcessor);
`;

/** Opens the microphone and streams its samples to `onChunk` until `close()`. */
export async function openMicrophone(onChunk: ChunkHandler): Promise<Microphone> {
  if (typeof window !== 'undefined' && !window.isSecureContext) throw new DictationError('insecure-context');
  const AudioContextCtor = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!navigator.mediaDevices?.getUserMedia || !AudioContextCtor) throw new DictationError('unsupported');

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (error) {
    throw new DictationError(classifyMicrophoneError(error), error instanceof Error ? error.message : undefined);
  }

  // The context runs at the device rate; the recognizer resamples to its model's rate.
  const context = new AudioContextCtor();
  const stopStream = (): void => stream.getTracks().forEach((track) => track.stop());
  try {
    await context.resume();
    const source = context.createMediaStreamSource(stream);
    // Processing nodes only run when connected to the output, so they go through a muted gain.
    const mute = context.createGain();
    mute.gain.value = 0;
    mute.connect(context.destination);
    let node: AudioNode;
    let detach: () => void;
    let workletUrl: string | null = null;

    if (context.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      await context.audioWorklet.addModule(workletUrl);
      const worklet = new AudioWorkletNode(context, PROCESSOR_NAME, { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => onChunk(event.data, context.sampleRate);
      node = worklet;
      detach = () => (worklet.port.onmessage = null);
    } else {
      // Older browsers: the deprecated main-thread processor still works.
      const processor = context.createScriptProcessor(CHUNK_FRAMES, 1, 1);
      processor.onaudioprocess = (event) => onChunk(new Float32Array(event.inputBuffer.getChannelData(0)), context.sampleRate);
      node = processor;
      detach = () => (processor.onaudioprocess = null);
    }
    source.connect(node);
    node.connect(mute);

    return {
      sampleRate: context.sampleRate,
      close() {
        stopStream();
        source.disconnect();
        node.disconnect();
        detach();
        if (workletUrl) URL.revokeObjectURL(workletUrl);
        void context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    stopStream();
    void context.close().catch(() => undefined);
    throw new DictationError('unsupported', error instanceof Error ? error.message : undefined);
  }
}
