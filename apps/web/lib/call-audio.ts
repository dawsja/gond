import { CALL_SAMPLE_RATE } from "@gond/shared";

/** How loud a node is right now, 0 to 1, for the wave. */
export function levelOf(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) sum += sample * sample;
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
}

export type Capture = { analyser: AnalyserNode; stop: () => void; setMuted: (muted: boolean) => void };

export async function startCapture(context: AudioContext, onChunk: (pcm: ArrayBuffer) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  await context.audioWorklet.addModule("/call-capture.js");
  const source = context.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(context, "gond-call-capture", { numberOfInputs: 1, numberOfOutputs: 0 });
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  let muted = false;
  worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (!muted) onChunk(event.data);
  };
  source.connect(worklet);
  source.connect(analyser);
  return {
    analyser,
    setMuted: (value) => {
      muted = value;
      for (const track of stream.getAudioTracks()) track.enabled = !value;
    },
    stop: () => {
      worklet.port.onmessage = null;
      source.disconnect();
      worklet.disconnect();
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
