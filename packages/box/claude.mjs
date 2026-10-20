import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";

export const CLAUDE_CHECK_MODEL = "haiku";
export const CLAUDE_CHECK_TIMEOUT_MS = 30_000;

const KILL_GRACE_MS = 5_000;

const MAX_STDERR = 4_000;

const MAX_LINE = 256 * 1024;

export const READ_ONLY_DENIED = [
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  "Bash(git checkout:*)",
  "Bash(git reset:*)",
  "Bash(git clean:*)",
  "Bash(git stash:*)",
  "Bash(rm:*)",
];

export const MAX_TURNS_CAP = 200;

export function claudeArgs({ model, systemPromptFile, readOnly = false, maxTurns = null }) {
  const turns = Number(maxTurns);
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    ...(Number.isInteger(turns) && turns > 0 ? ["--max-turns", String(Math.min(turns, MAX_TURNS_CAP))] : []),
    "--dangerously-skip-permissions",
    "--no-session-persistence",
    "--disallowedTools",
    "Bash(git commit:*)",
    "Bash(git push:*)",
    ...(readOnly ? READ_ONLY_DENIED : []),
    "--append-system-prompt-file",
    systemPromptFile,
  ];
}

export const MODEL_ID = /^[A-Za-z0-9._-]{1,80}$/;

function killTree(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

export function spawnClaude({
  bin = CLAUDE_BIN,
  args,
  cwd,
  env,
  uid,
  gid,
  prompt,
  timeoutMs,
  signal,
  onLine,
  onStderr,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env,
      ...(uid !== undefined ? { uid, gid } : {}),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let timedOut = false;
    let aborted = false;
    let killTimer = null;
    const stop = (why) => {
      if (why === "timeout") timedOut = true;
      else aborted = true;
      killTree(child, "SIGTERM");
      killTimer = setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = timeoutMs ? setTimeout(() => stop("timeout"), timeoutMs) : null;
    const onAbort = () => stop("abort");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (line) onLine?.(line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line);
        newline = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE) pending = pending.slice(-MAX_LINE);
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-MAX_STDERR);
      onStderr?.(chunk);
    });

    const done = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (error) => {
      done();
      reject(error);
    });
    child.on("close", (code, sig) => {
      done();
      if (pending.trim()) onLine?.(pending.replace(/\r$/, ""));
      resolve({
        exitCode: code ?? (sig ? 128 : 1),
        signal: sig ?? null,
        timedOut,
        aborted,
        stderr,
      });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
  });
}

const NOT_SIGNED_IN = /not logged in|please run \/login|invalid api key|authentication|unauthori[sz]ed|oauth token/i;

export function classifyCheck({ spawnError, exitCode, output }) {
  if (spawnError) {
    return spawnError.code === "ENOENT" || spawnError.code === "EACCES" ? "missing" : "error";
  }
  if (exitCode === 0 && !NOT_SIGNED_IN.test(output ?? "")) return "ok";
  if (NOT_SIGNED_IN.test(output ?? "")) return "unauthenticated";
  return "error";
}

export function isSignInError(text) {
  return NOT_SIGNED_IN.test(text ?? "");
}

export async function checkClaude({ bin = CLAUDE_BIN, cwd, env, uid, gid }) {
  let output = "";
  const keep = (text) => {
    output = (output + text).slice(-2_000);
  };
  try {
    const result = await spawnClaude({
      bin,
      args: ["-p", "--model", CLAUDE_CHECK_MODEL, "--output-format", "text"],
      cwd,
      env,
      uid,
      gid,
      prompt: "reply ok",
      timeoutMs: CLAUDE_CHECK_TIMEOUT_MS,
      onLine: (line) => keep(`${line}\n`),
      onStderr: keep,
    });
    const status = result.timedOut ? "error" : classifyCheck({ exitCode: result.exitCode, output });
    const detail = result.timedOut ? "The check timed out" : output.trim().slice(0, 300);
    return { status, detail };
  } catch (error) {
    return { status: classifyCheck({ spawnError: error }), detail: error.message.slice(0, 300) };
  }
}

/**
 * Writes the system prompt where only the agent user reads it and returns
 * the path plus a cleanup. Outside the workspace on purpose: the repo's
 * working tree is what Gond collects, and nothing of ours belongs in it.
 *
 * @param {string} text
 * @param {{ uid?: number; gid?: number }} [owner]
 */
export function writeSystemPrompt(text, { uid, gid } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gond-claude-"));
  const file = path.join(dir, "system-prompt.md");
  fs.writeFileSync(file, text, { mode: 0o600 });
  if (uid !== undefined) {
    fs.chownSync(dir, uid, gid);
    fs.chownSync(file, uid, gid);
  }
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
