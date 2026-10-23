"use client";

import { useSyncExternalStore } from "react";

// Devices differ from one computer or phone to the next, so the choice stays on this one.
const KEYS = { input: "gond-microphone", output: "gond-speaker" } as const;
export type AudioDeviceKind = keyof typeof KEYS;

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The device picked in Settings → Voice, or "" for the system's own. */
export function chosenDevice(kind: AudioDeviceKind): string {
  try {
    return localStorage.getItem(KEYS[kind]) ?? "";
  } catch {
    return "";
  }
}

export function chooseDevice(kind: AudioDeviceKind, id: string) {
  try {
    if (id) localStorage.setItem(KEYS[kind], id);
    else localStorage.removeItem(KEYS[kind]);
  } catch {
    /* kept for this page only */
  }
  for (const listener of listeners) listener();
}

export function useChosenDevice(kind: AudioDeviceKind): string {
  return useSyncExternalStore(
    subscribe,
    () => chosenDevice(kind),
    () => "",
  );
}

/** The picked microphone while it is still there, else the system's. */
export async function microphone(constraints: MediaTrackConstraints = {}): Promise<MediaStream> {
  const id = chosenDevice("input");
  if (id) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...constraints, deviceId: { exact: id } } });
    } catch (failure) {
      const gone = failure instanceof DOMException && (failure.name === "OverconstrainedError" || failure.name === "NotFoundError");
      if (!gone) throw failure;
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: Object.keys(constraints).length ? constraints : true });
}

type Sinkable = AudioContext & { setSinkId: (id: string) => Promise<void> };

/** Safari and some webviews can't send audio to a chosen speaker; there the setting isn't offered. */
export function canPickSpeaker(): boolean {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

export async function routeToSpeaker(context: AudioContext, id = chosenDevice("output")) {
  if (!id || !canPickSpeaker()) return;
  await (context as Sinkable).setSinkId(id).catch(() => undefined);
}
