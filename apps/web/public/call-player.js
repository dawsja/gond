// The bot's voice as one stream: mono 16-bit PCM at 24 kHz in, the context's own rate out. Played
// chunk by chunk, each one resampled on its own, the joins click and a late chunk leaves a hole; here
// a cushion rides out audio that arrives late, grows when it ran dry mid-word, and a gap fades.
const RATE = 24000;
// Quieter than this (about -48 dB) is silence, which GPT-Live streams the whole call while nobody talks.
const QUIET = 0.004;
const CUSHION_MIN_S = 0.12;
const CUSHION_MAX_S = 0.4;
const CUSHION_GROW_S = 0.06;
const CUSHION_SHRINK_S = 0.02;
// This long without running dry, the cushion gives a step back.
const SETTLE_S = 15;
// More words this soon after running dry mean the network was late, not that a sentence ended.
const LATE_S = 0.5;
// Running dry within this much of loud audio cut a word off.
const CUT_S = 0.05;
const FADE_S = 0.004;
const TAPS = 16;
const PHASES = 512;
const REPORT_BLOCKS = 32;

/** A windowed-sinc (Blackman) table, one row of taps per fraction of a sample, each row summing to 1. */
function kernel(cutoff) {
  const table = new Float32Array(PHASES * TAPS);
  const half = TAPS / 2;
  for (let p = 0; p < PHASES; p++) {
    const frac = p / PHASES;
    let sum = 0;
    for (let k = 0; k < TAPS; k++) {
      const d = k - half + 1 - frac;
      const x = Math.PI * cutoff * d;
      const sinc = x === 0 ? 1 : Math.sin(x) / x;
      const window = Math.abs(d) >= half ? 0 : 0.42 + 0.5 * Math.cos((Math.PI * d) / half) + 0.08 * Math.cos((2 * Math.PI * d) / half);
      table[p * TAPS + k] = sinc * window;
      sum += sinc * window;
    }
    for (let k = 0; k < TAPS; k++) table[p * TAPS + k] /= sum;
  }
  return table;
}

class CallPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = RATE / sampleRate;
    this.kernel = kernel(Math.min(1, sampleRate / RATE));
    this.ring = new Float32Array(1 << 16);
    // Positions count samples at 24 kHz since the call began; `pos` is where playback reads.
    this.written = 0;
    this.pos = 0;
    this.loudEnd = 0;
    this.playing = false;
    this.waited = 0;
    this.sinceDry = Infinity;
    this.cutOff = false;
    this.cushion = CUSHION_MIN_S;
    this.clean = 0;
    this.gain = 0;
    this.held = 0;
    this.carry = -1;
    this.blocks = 0;
    this.speaking = false;
    this.port.onmessage = (event) => {
      if (event.data === "clear") this.clear();
      else this.push(event.data);
    };
  }

  push(buffer) {
    let bytes = new Uint8Array(buffer);
    // A sample split across two deltas: its first byte waits for the rest rather than shifting every sample after it.
    if (this.carry >= 0) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.carry;
      joined.set(bytes, 1);
      bytes = joined;
      this.carry = -1;
    }
    if (bytes.length % 2) this.carry = bytes[bytes.length - 1];
    const count = bytes.length >> 1;
    if (!count) return;
    const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
    const samples = new Float32Array(count);
    let peak = 0;
    for (let i = 0; i < count; i++) {
      const sample = view.getInt16(i * 2, true) / 0x8000;
      samples[i] = sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const loud = peak >= QUIET;
    // Silence plays only as a pause inside what it is saying; once that is done, the quiet stream is dropped.
    if (!loud && this.loudLeft() <= 0) return;
    if (!this.playing && this.cutOff && this.sinceDry < LATE_S * sampleRate) {
      this.cushion = Math.min(CUSHION_MAX_S, this.cushion + CUSHION_GROW_S);
      this.clean = 0;
    }
    this.cutOff = false;
    this.room(count);
    const mask = this.ring.length - 1;
    for (let i = 0; i < count; i++) this.ring[(this.written + i) & mask] = samples[i];
    this.written += count;
    if (loud) this.loudEnd = this.written;
  }

  /** Grows the ring so what is waiting, the taps behind it and `count` more all fit. */
  room(count) {
    const from = Math.floor(this.pos) - TAPS;
    const needed = this.written + count - from;
    if (needed <= this.ring.length) return;
    let size = this.ring.length;
    while (size < needed) size *= 2;
    const ring = new Float32Array(size);
    const oldMask = this.ring.length - 1;
    const mask = size - 1;
    for (let i = Math.max(0, from); i < this.written; i++) ring[i & mask] = this.ring[i & oldMask];
    this.ring = ring;
  }

  /** Loud audio still to play, in samples; the last few taps play only once more comes, so they count as played. */
  loudLeft() {
    return this.loudEnd - TAPS / 2 - this.pos;
  }

  clear() {
    this.pos = this.written;
    this.loudEnd = this.written;
    this.playing = false;
    this.waited = 0;
    this.cutOff = false;
    this.sinceDry = Infinity;
    this.carry = -1;
  }

  sample() {
    const base = Math.floor(this.pos);
    const row = Math.min(PHASES - 1, Math.round((this.pos - base) * PHASES)) * TAPS;
    const mask = this.ring.length - 1;
    const start = base - TAPS / 2 + 1;
    let sum = 0;
    for (let k = 0; k < TAPS; k++) sum += this.ring[(start + k) & mask] * this.kernel[row + k];
    return sum;
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0];
    if (!out) return true;
    const fade = 1 / (FADE_S * sampleRate);
    for (let n = 0; n < out.length; n++) {
      if (!this.playing) {
        this.sinceDry++;
        if (this.written > this.pos) {
          this.waited++;
          if (this.written - this.pos >= this.cushion * RATE || this.waited >= this.cushion * sampleRate) {
            this.playing = true;
            this.waited = 0;
          }
        }
      }
      if (this.playing) {
        if (this.written - Math.floor(this.pos) <= TAPS / 2) {
          this.playing = false;
          this.cutOff = this.written - this.loudEnd < CUT_S * RATE;
          this.sinceDry = 0;
        } else {
          this.held = this.sample();
          this.pos += this.ratio;
          this.clean++;
        }
      }
      this.gain = this.playing ? Math.min(1, this.gain + fade) : Math.max(0, this.gain - fade);
      out[n] = this.held * this.gain;
    }
    if (this.clean >= SETTLE_S * sampleRate) {
      this.cushion = Math.max(CUSHION_MIN_S, this.cushion - CUSHION_SHRINK_S);
      this.clean = 0;
    }
    const left = this.loudLeft();
    const speaking = left > 0;
    if (speaking !== this.speaking || (speaking && ++this.blocks >= REPORT_BLOCKS)) {
      this.speaking = speaking;
      this.blocks = 0;
      this.port.postMessage({ speaking, left: Math.max(0, left) / RATE });
    }
    return true;
  }
}

registerProcessor("gond-call-player", CallPlayer);
