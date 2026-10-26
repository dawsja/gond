import type { LiveEvent } from "@gond/shared";
import { threadOwner } from "./data/threads.ts";

type Listener = (event: LiveEvent) => void;

const holder = globalThis as typeof globalThis & { __gondLiveListeners?: Set<Listener> };

function listeners(): Set<Listener> {
  return (holder.__gondLiveListeners ??= new Set());
}

export function subscribe(listener: Listener): () => void {
  listeners().add(listener);
  return () => {
    listeners().delete(listener);
  };
}

export function emit(event: LiveEvent) {
  for (const listener of [...listeners()]) {
    try {
      listener(event);
    } catch {
      listeners().delete(listener);
    }
  }
}

export const botsChanged = (userId?: string | null) => emit(userId ? { topic: "bots", userId } : { topic: "bots" });
export const threadChanged = (threadId: string, cleared?: true) => {
  emit(cleared ? { topic: "thread", threadId, cleared } : { topic: "thread", threadId });
  botsChanged(threadOwner(threadId));
};
export const approvalsChanged = () => emit({ topic: "approvals" });
export const settingsChanged = () => emit({ topic: "settings" });

export const skillsChanged = (userId: string | null | undefined) => {
  if (userId) emit({ topic: "skills", userId });
};
export const activity = (threadId: string, botId: string, line: string | null) => emit({ topic: "activity", threadId, botId, line });
