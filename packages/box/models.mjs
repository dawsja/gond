import { spawn } from "node:child_process";
import { RpcPeer } from "./rpc.mjs";

const TIMEOUT_MS = 20_000;

export const CLAUDE_ALIASES = [
  { id: "fable", name: "Fable 5.1", detail: "The newest, above Opus. Only where your plan includes it." },
  { id: "opus", name: "Opus 5.5", detail: "The most capable. Best for long, multi-step jobs. The default for every bot.", default: true },
  { id: "sonnet", name: "Sonnet 5.5", detail: "Fast and capable. Good for everyday work." },
  { id: "haiku", name: "Haiku 5.5", detail: "Quickest and cheapest. Good for triage and routines." },
];

export function parseGrokModels(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const found = /^\s*([*-])\s+([A-Za-z0-9][\w.:-]*)\s*(\(default\))?/.exec(line);
    if (!found) continue;
    const id = found[2];
    if (out.some((model) => model.id === id)) continue;
    out.push({ id, ...(found[1] === "*" || found[3] ? { default: true } : {}) });
  }
  return out;
}

export function readCodexModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const out = [];
  for (const row of rows) {
    const id = typeof row?.model === "string" && row.model ? row.model : typeof row?.id === "string" ? row.id : null;
    if (!id || row?.hidden === true || out.some((model) => model.id === id)) continue;
    out.push({
      id,
      ...(typeof row.displayName === "string" && row.displayName ? { name: row.displayName } : {}),
      ...(row.isDefault === true ? { default: true } : {}),
    });
  }
  return out;
}

function output(bin, args, options) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      resolve("");
      return;
    }
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function codexModels(bin, options) {
  let child;
  try {
    child = spawn(bin, ["app-server"], { ...options, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return [];
  }

  const died = new Promise((resolve) => child.once("error", () => resolve("gone")));
  try {
    const rpc = new RpcPeer(child, { jsonrpc: false });
    const start = await Promise.race([rpc.request("initialize", { clientInfo: { name: "gond", title: "Gond", version: "1.0.0" } }, { timeoutMs: TIMEOUT_MS }), died]);
    if (start === "gone") return [];
    rpc.notify("initialized", {});
    const answer = await Promise.race([rpc.request("model/list", { includeHidden: false }, { timeoutMs: TIMEOUT_MS }), died]);
    return answer === "gone" ? [] : readCodexModels(answer);
  } catch {
    return [];
  } finally {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export async function engineModels(engine, { bins, env, uid, gid }) {
  const options = { env, ...(uid !== undefined ? { uid, gid } : {}) };
  if (engine === "claude") return CLAUDE_ALIASES.map((model) => ({ ...model }));
  if (engine === "grok") return parseGrokModels(await output(bins.grok, ["models"], options));
  if (engine === "codex") return codexModels(bins.codex, options);
  return [];
}
