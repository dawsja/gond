"use client";

import { useSyncExternalStore } from "react";

// What the person was typing in each conversation, kept on this device so moving between chats loses nothing.
// Typing changes the copy in memory; storage is written once typing pauses, when the page hides and when
// the person leaves the conversation, and only then does the chat list hear of it.
const KEY = "gond:drafts";
const MAX_DRAFT = 20_000;
const WRITE_MS = 300;

type Drafts = Readonly<Record<string, string>>;
const NONE: Drafts = {};

let drafts: Drafts | null = null;
let published: Drafts = NONE;
const changed = new Set<string>();
const listeners = new Set<() => void>();
let timer: number | null = null;
let hooked = false;

function parse(text: string | null): Drafts {
  try {
    const value = JSON.parse(text ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function stored(): Drafts | null {
  try {
    return parse(window.localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

function load(): Drafts {
  hook();
  if (drafts === null) {
    drafts = stored() ?? {};
    published = drafts;
  }
  return drafts;
}

/** Ours over theirs: another tab's drafts with what changed here since the last write. */
function withChanges(base: Drafts): Drafts {
  const next: Record<string, string> = { ...base };
  for (const id of changed) {
    const text = drafts?.[id];
    if (text) next[id] = text;
    else delete next[id];
  }
  return next;
}

function publish() {
  if (drafts === null || published === drafts) return;
  published = drafts;
  for (const listener of [...listeners]) listener();
}

function hook() {
  if (hooked || typeof window === "undefined") return;
  hooked = true;
  window.addEventListener("pagehide", flushDrafts);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushDrafts();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY) return;
    drafts = withChanges(parse(event.newValue));
    publish();
  });
}

export function flushDrafts() {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  if (!changed.size) return;
  // Storage that can't be read leaves memory as the only copy of the other conversations' drafts.
  drafts = withChanges(stored() ?? drafts ?? {});
  try {
    window.localStorage.setItem(KEY, JSON.stringify(drafts));
    changed.clear();
  } catch {
    // Kept in memory for this page all the same; the changes go out with the next write that saves.
  }
  publish();
}

export function readDraft(threadId: string): string {
  return load()[threadId] ?? "";
}

export function saveDraft(threadId: string, text: string) {
  const all = load();
  const next = text.trim() ? text.slice(0, MAX_DRAFT) : "";
  if ((all[threadId] ?? "") === next) return;
  const copy: Record<string, string> = { ...all };
  if (next) copy[threadId] = next;
  else delete copy[threadId];
  drafts = copy;
  changed.add(threadId);
  if (timer !== null) window.clearTimeout(timer);
  timer = window.setTimeout(flushDrafts, WRITE_MS);
}

function subscribe(onChange: () => void) {
  load();
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function snapshot(): Drafts {
  load();
  return published;
}

export function useDrafts(): Readonly<Record<string, string>> {
  return useSyncExternalStore(subscribe, snapshot, () => NONE);
}
