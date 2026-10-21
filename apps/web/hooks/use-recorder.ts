"use client";

import { TRANSCRIBE_MAX_SECONDS } from "@gond/shared";
import { useCallback, useEffect, useRef, useState } from "react";

// Both transcription APIs take webm and mp4; Safari records only mp4.
const FORMATS = [
  ["audio/webm;codecs=opus", "webm"],
  ["audio/webm", "webm"],
  ["audio/mp4", "mp4"],
] as const;

type Take = { recorder: MediaRecorder; stream: MediaStream; timer: number; started: number; extension: string; chunks: Blob[]; keep: boolean };

export function useRecorder(onDone: (audio: File) => void) {
  const take = useRef<Take | null>(null);
  const done = useRef(onDone);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    done.current = onDone;
  }, [onDone]);

  const finish = useCallback((keep: boolean) => {
    const current = take.current;
    if (!current) return;
    take.current = null;
    current.keep = keep;
    window.clearInterval(current.timer);
    if (current.recorder.state !== "inactive") current.recorder.stop();
    for (const track of current.stream.getTracks()) track.stop();
    setRecording(false);
    setSeconds(0);
  }, []);

  const start = useCallback(async () => {
    if (take.current) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const [mimeType, extension] = FORMATS.find(([type]) => MediaRecorder.isTypeSupported(type)) ?? ["", "webm"];
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const current: Take = { recorder, stream, timer: 0, started: Date.now(), extension, chunks: [], keep: true };
    recorder.ondataavailable = (event) => {
      if (event.data.size) current.chunks.push(event.data);
    };
    recorder.onstop = () => {
      if (!current.keep || !current.chunks.length) return;
      const type = recorder.mimeType || mimeType || `audio/${extension}`;
      done.current(new File(current.chunks, `recording.${extension}`, { type }));
    };
    current.timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - current.started) / 1000);
      setSeconds(elapsed);
      if (elapsed >= TRANSCRIBE_MAX_SECONDS) finish(true);
    }, 250);
    take.current = current;
    recorder.start();
    setRecording(true);
  }, [finish]);

  const stop = useCallback(() => finish(true), [finish]);

  useEffect(() => () => finish(false), [finish]);

  return { recording, seconds, start, stop };
}
