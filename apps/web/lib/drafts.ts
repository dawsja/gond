"use client";

import { useMemo, useSyncExternalStore } from "react";

// What the person was typing in each conversation, kept on this device so moving between chats loses nothing.
const KEY = "gond:drafts";
const CHANGED = "gond:drafts";
const MAX_DRAFT = 20_000;

function raw(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "{}";
  } catch {
    return "{}";
  }
}

function parse(text: string): Record<string, string> {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function readDraft(threadId: string): string {
  const draft = parse(raw())[threadId];
  return typeof draft === "string" ? draft : "";
}

export function saveDraft(threadId: string, text: string) {
  const all = parse(raw());
  if ((all[threadId] ?? "") === (text.trim() ? text : "")) return;
  if (text.trim()) all[threadId] = text.slice(0, MAX_DRAFT);
  else delete all[threadId];
  try {
    window.localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    return;
  }
  window.dispatchEvent(new Event(CHANGED));
}

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => event.key === KEY && onChange();
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

/** Every saved draft by conversation; none on the server's render, so the list hydrates as it was sent. */
export function useDrafts(): Record<string, string> {
  const text = useSyncExternalStore(subscribe, raw, () => "{}");
  return useMemo(() => parse(text), [text]);
}
