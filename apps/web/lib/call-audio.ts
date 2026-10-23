import { CALL_SAMPLE_RATE } from "@gond/shared";
import { microphone } from "@/lib/audio-devices";

/** How loud a node is right now, 0 to 1, for the wave. */
export function levelOf(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
}

export type Capture = { analyser: AnalyserNode; stop: () => void; setMuted: (muted: boolean) => void };

/** Why the microphone didn't start, in words the person can act on. */
export class MicError extends Error {
  constructor(
    message: string,
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

function micError(failure: unknown): MicError {
  const name = failure instanceof DOMException ? failure.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return new MicError("Gond isn't allowed to use the microphone.", "Allow it for Gond, and check your system lets apps use the microphone (on Windows: Settings → Privacy & security → Microphone), then call again.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new MicError("No microphone was found.", "Plug one in or pick one in your system's sound settings, then call again.");
  if (name === "NotReadableError" || name === "AbortError") return new MicError("The microphone is busy.", "Another app may be using it. Close that, then call again.");
  return new MicError("The microphone didn't start.", name ? `The system said ${name}.` : null);
}

/** The call's rate from whatever the device gives, the same steps as `public/call-capture.js`, for engines without AudioWorklet. */
function resampler(from: number, onChunk: (pcm: ArrayBuffer) => void) {
  const step = from / CALL_SAMPLE_RATE;
  const size = CALL_SAMPLE_RATE / 10;
  let at = 0;
  let last = 0;
  let chunk = new Int16Array(size);
  let filled = 0;
  return (data: Float32Array) => {
    while (at < data.length - 1) {
      const i = Math.floor(at);
      const f = at - i;
      const a = i < 0 ? last : data[i]!;
      const b = data[i + 1]!;
      const sample = Math.max(-1, Math.min(1, a + (b - a) * f));
      chunk[filled++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      if (filled === size) {
        onChunk(chunk.buffer);
        chunk = new Int16Array(size);
        filled = 0;
      }
      at += step;
    }
    at -= data.length;
    last = data[data.length - 1] ?? 0;
  };
}

export async function startCapture(context: AudioContext, onChunk: (pcm: ArrayBuffer) => void): Promise<Capture> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new MicError("The microphone needs a secure connection.", "Connect to your Gond's https address, then call again.");
  }
  let stream: MediaStream;
  try {
    stream = await microphone({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  } catch (failure) {
    throw micError(failure);
  }
  if (context.state === "suspended") await context.resume().catch(() => undefined);
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  // A node only runs while something pulls it, and some engines pull only what reaches the speakers: a silent path keeps it running.
  const silent = context.createGain();
  silent.gain.value = 0;
  silent.connect(context.destination);
  let muted = false;
  const take = (pcm: ArrayBuffer) => {
    if (!muted) onChunk(pcm);
  };

  let node: AudioNode;
  let release: () => void;
  try {
    if (!context.audioWorklet) throw new Error("no AudioWorklet");
    await context.audioWorklet.addModule("/call-capture.js");
    const worklet = new AudioWorkletNode(context, "gond-call-capture", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => take(event.data);
    node = worklet;
    release = () => {
      worklet.port.onmessage = null;
    };
  } catch {
    const processor = context.createScriptProcessor(4096, 1, 1);
    const feed = resampler(context.sampleRate, take);
    processor.onaudioprocess = (event) => feed(event.inputBuffer.getChannelData(0));
    node = processor;
    release = () => {
      processor.onaudioprocess = null;
    };
  }
  source.connect(node);
  node.connect(silent);

  return {
    analyser,
    setMuted: (value) => {
      muted = value;
      for (const track of stream.getAudioTracks()) track.enabled = !value;
    },
    stop: () => {
      release();
      source.disconnect();
      node.disconnect();
      silent.disconnect();
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

function pcmFromBase64(data: string): Float32Array<ArrayBuffer> {
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const samples = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! / 0x8000;
  return out;
}

// A little runway so audio that arrives in bursts still plays without gaps.
const LEAD_S = 0.06;

/** The bot's voice, played in order as it arrives. */
export class CallPlayer {
  readonly analyser: AnalyserNode;
  private next = 0;
  private playing = new Set<AudioBufferSourceNode>();

  constructor(private readonly context: AudioContext) {
    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.connect(context.destination);
  }

  play(data: string) {
    const samples = pcmFromBase64(data);
    if (!samples.length) return;
    const buffer = this.context.createBuffer(1, samples.length, CALL_SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.analyser);
    const at = Math.max(this.context.currentTime + LEAD_S, this.next);
    source.start(at);
    this.next = at + buffer.duration;
    this.playing.add(source);
    source.onended = () => this.playing.delete(source);
  }

  /** The person spoke over it: what is queued goes, as a person would stop mid-word. */
  clear() {
    for (const source of this.playing) {
      try {
        source.stop();
      } catch {
        /* already done */
      }
    }
    this.playing.clear();
    this.next = 0;
  }

  get speaking(): boolean {
    return this.next > this.context.currentTime;
  }

  /** Resolves once what was said has played, so a goodbye isn't cut off. */
  drained(maxMs: number): Promise<void> {
    const left = Math.max(0, this.next - this.context.currentTime) * 1000;
    return new Promise((resolve) => setTimeout(resolve, Math.min(left, maxMs)));
  }
}
