export type ClaudeStatus = {
  status: "ok" | "missing" | "unauthenticated" | "error" | "no-box";
  detail: string;
  email?: string | null;
};

export type BoxStatus = {
  configured: boolean;
  reachable: boolean;

  updating: boolean;

  claude: ClaudeStatus;

  composio: { configured: boolean; connected: number };

  agents: { id: string; running: boolean; busy: boolean }[];

  versions: { node: string | null; bun: string | null; claude: string | null } | null;
  /**
   * The admin's alone: how full the computer is and what each person's (and profile's) bots use of it, in bytes.
   * `disk` per person is measured now and then (`diskAt`); `memory` per person is null when the box can't tell.
   */
  health?: {
    disk: { total: number; free: number };
    memory: { total: number; used: number };
    people: { id: string; name: string; bots: number; screens: number; memory: number | null; disk: number | null }[];
    diskAt: string | null;
    at: string;
  };
};

export type BoxUpdatePhase = "idle" | "pausing" | "pulling" | "restarting" | "resetting" | "patching" | "resuming" | "done" | "failed";

export const BOX_UPDATE_PHASE_LABELS: Record<BoxUpdatePhase, string> = {
  idle: "Up to date as far as we know",
  pausing: "Pausing the computer",
  pulling: "Pulling the newest image",
  restarting: "Restarting on the new image",
  resetting: "Wiping the computer and rebuilding it",
  patching: "Patching Debian, Bun and Claude Code",
  resuming: "Bringing the computer back",
  done: "Updated",
  failed: "Update failed",
};

/** Updating Gond itself from Settings → About: the step it is on. */
export type ServerUpdatePhase = "idle" | "pulling" | "computer" | "web" | "server" | "done" | "failed";

export type ServerUpdate = {
  /** The version this server runs, "dev" when it wasn't built by a release. */
  current: string;
  latest: string | null;
  available: boolean;
  /** What changed since `current`, one line each, from the commits between the two releases. */
  notes: string[];
  /** Why this server can't update itself, when it can't (no Docker socket, say). */
  blocked: string | null;
  phase: ServerUpdatePhase;
  error: string | null;
};

/** Whether release `a` (1.2.3, with or without a v) is newer than `b`; anything that isn't one never is. */
export function newerVersion(a: string, b: string): boolean {
  const parse = (v: string) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())?.slice(1).map(Number) ?? null;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

export type BoxUpdate = {
  phase: BoxUpdatePhase;
  startedAt: string | null;
  finishedAt: string | null;
  log: string[];
  error: string | null;

  pulled: boolean;

  patched: boolean;

  kind: "update" | "reset";
};
