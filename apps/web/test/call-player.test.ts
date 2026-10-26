import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Processor = {
  pos: number;
  cushion: number;
  port: { onmessage: (event: { data: unknown }) => void };
  process: (inputs: unknown[], outputs: Float32Array[][]) => boolean;
};

const SOURCE = readFileSync(new URL("../public/call-player.js", import.meta.url), "utf8");
const RATE = 24000;
const CHUNK = RATE / 50;

function player(sampleRate: number) {
  const posted: { speaking: boolean; left: number }[] = [];
  class AudioWorkletProcessor {
    port = { onmessage: null as unknown as (event: { data: unknown }) => void, postMessage: (message: { speaking: boolean; left: number }) => posted.push(message) };
  }
  let Made: (new () => Processor) | null = null;
  new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", SOURCE)(AudioWorkletProcessor, (_name: string, made: new () => Processor) => (Made = made), sampleRate);
  const processor = new Made!();
  return { processor, posted, send: (data: unknown) => processor.port.onmessage({ data }) };
}

function pcm(samples: ArrayLike<number>): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(samples.length * 2));
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.round(samples[i]! * 0x7fff), true);
  return view.buffer;
}

const tone = (from: number, count: number, hz = 440, amp = 0.5) => Array.from({ length: count }, (_, i) => amp * Math.sin((2 * Math.PI * hz * (from + i)) / RATE));

/** Plays `frames` output frames one at a time, delivering a 20 ms chunk whenever `due` says so, and keeps where each was read. */
function run(p: ReturnType<typeof player>, sampleRate: number, frames: number, due: (frame: number) => boolean, state = { sent: 0 }) {
  const out: number[] = [];
  const at: number[] = [];
  const block = [[new Float32Array(1)]];
  const every = Math.round(sampleRate / 50);
  for (let n = 0; n < frames; n++) {
    if (n % every === 0 && due(n)) {
      p.send(pcm(tone(state.sent, CHUNK)));
      state.sent += CHUNK;
    }
    at.push(p.processor.pos);
    p.processor.process([], block);
    out.push(block[0]![0]![0]!);
  }
  return { out, at };
}

for (const sampleRate of [48000, 44100]) {
  test(`a steady voice comes out as the same tone at ${sampleRate} Hz, without clicks at the joins`, () => {
    const p = player(sampleRate);
    const { out, at } = run(p, sampleRate, sampleRate, () => true);
    let playing = 0;
    let worst = 0;
    for (let n = 1; n < out.length; n++) {
      if (at[n] === at[n - 1]) continue;
      if (++playing < 400) continue;
      worst = Math.max(worst, Math.abs(out[n - 1]! - 0.5 * Math.sin((2 * Math.PI * 440 * at[n - 1]!) / RATE)));
    }
    expect(playing).toBeGreaterThan(sampleRate * 0.8);
    expect(worst).toBeLessThan(0.002);
  });
}

test("a stall fades out instead of stopping dead, and the cushion grows for the next one", () => {
  const sampleRate = 48000;
  const p = player(sampleRate);
  const state = { sent: 0 };
  run(p, sampleRate, sampleRate / 2, () => true, state);
  const before = p.processor.cushion;
  const stalled = run(p, sampleRate, sampleRate / 2, (n) => n > sampleRate * 0.3, state);
  expect(p.processor.cushion).toBeGreaterThan(before);
  let jump = 0;
  for (let n = 1; n < stalled.out.length; n++) jump = Math.max(jump, Math.abs(stalled.out[n]! - stalled.out[n - 1]!));
  // A 440 Hz tone at half scale moves at most about 0.03 a frame; a cut to zero would be up to 0.5.
  expect(jump).toBeLessThan(0.05);
});

test("silence on its own is dropped, and the player says when it is speaking", () => {
  const sampleRate = 48000;
  const p = player(sampleRate);
  p.send(pcm(new Array(CHUNK).fill(0)));
  run(p, sampleRate, 4800, () => false);
  expect(p.posted.some((m) => m.speaking)).toBe(false);
  p.send(pcm(tone(0, CHUNK)));
  run(p, sampleRate, 128, () => false);
  expect(p.posted.at(-1)?.speaking).toBe(true);
  run(p, sampleRate, sampleRate / 2, () => false);
  expect(p.posted.at(-1)?.speaking).toBe(false);
});

test("clear drops what is queued", () => {
  const sampleRate = 48000;
  const p = player(sampleRate);
  for (let i = 0; i < 20; i++) p.send(pcm(tone(i * CHUNK, CHUNK)));
  run(p, sampleRate, sampleRate / 4, () => false);
  p.send("clear");
  const after = run(p, sampleRate, sampleRate / 10, () => false);
  expect(Math.max(...after.out.slice(sampleRate / 100).map(Math.abs))).toBe(0);
  expect(p.posted.at(-1)?.speaking).toBe(false);
});

test("a sample split across two chunks plays as if it came whole", () => {
  const sampleRate = 48000;
  const whole = player(sampleRate);
  const split = player(sampleRate);
  const bytes = new Uint8Array(pcm(tone(0, CHUNK * 10)));
  whole.send(bytes.slice().buffer);
  split.send(bytes.slice(0, 2001).buffer);
  split.send(bytes.slice(2001).buffer);
  const a = run(whole, sampleRate, sampleRate / 2, () => false).out;
  const b = run(split, sampleRate, sampleRate / 2, () => false).out;
  expect(b).toEqual(a);
});
