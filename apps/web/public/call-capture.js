// The microphone at the call's rate: mono 16-bit PCM at 24 kHz, posted every 20 ms, so the voice hears
// the person as they speak rather than a tenth of a second late.
const RATE = 24000;
const CHUNK = RATE / 50;

class CallCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / RATE;
    this.at = 0;
    this.last = 0;
    this.chunk = new Int16Array(CHUNK);
    this.filled = 0;
  }

  process(inputs) {
    const data = inputs[0] && inputs[0][0];
    // Its output stays silent; it is connected only so the engine keeps running it.
    if (!data || data.length === 0) return true;
    // Linear interpolation across the block boundary: index -1 is the last sample of the block before.
    while (this.at < data.length - 1) {
      const i = Math.floor(this.at);
      const f = this.at - i;
      const a = i < 0 ? this.last : data[i];
      const b = data[i + 1];
      const s = Math.max(-1, Math.min(1, a + (b - a) * f));
      this.chunk[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.filled === CHUNK) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer]);
        this.chunk = new Int16Array(CHUNK);
        this.filled = 0;
      }
      this.at += this.step;
    }
    this.at -= data.length;
    this.last = data[data.length - 1];
    return true;
  }
}

registerProcessor("gond-call-capture", CallCapture);
