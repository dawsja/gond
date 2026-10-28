import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

/** A process's real uid and resident memory in bytes, from `/proc/<pid>/status`; null when it says neither. */
export function parseProcStatus(text) {
  const uid = /^Uid:\s+(\d+)/m.exec(text ?? "");
  const rss = /^VmRSS:\s+(\d+)\s*kB/im.exec(text ?? "");
  if (!uid) return null;
  return { uid: Number(uid[1]), rss: rss ? Number(rss[1]) * 1024 : 0 };
}

/** Resident memory summed per uid over every process. */
export function rssByUid(statuses) {
  const out = new Map();
  for (const text of statuses) {
    const proc = parseProcStatus(text);
    if (proc) out.set(proc.uid, (out.get(proc.uid) ?? 0) + proc.rss);
  }
  return out;
}

/**
 * The container's memory from cgroup v2's `memory.max` and `memory.current`; a limit of "max" (none)
 * is the machine's total. Null when the files aren't there or can't be read as numbers.
 */
export function cgroupMemory(max, current, machineTotal) {
  if (typeof current !== "string" || typeof max !== "string") return null;
  const used = Number(current.trim());
  if (!Number.isFinite(used) || current.trim() === "") return null;
  const limit = max.trim() === "max" ? machineTotal : Number(max.trim());
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return { total: Math.min(limit, machineTotal), used: Math.min(used, limit) };
}

/** The bytes `du -sb` counted, from its first line. */
export function parseDu(output) {
  const match = /^(\d+)\s/.exec(output ?? "");
  return match ? Number(match[1]) : null;
}

const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export function memoryNow(cgroup = "/sys/fs/cgroup") {
  const total = os.totalmem();
  return cgroupMemory(readText(`${cgroup}/memory.max`), readText(`${cgroup}/memory.current`), total) ?? { total, used: total - os.freemem() };
}

export function diskOf(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return { total: stat.blocks * stat.bsize, free: stat.bavail * stat.bsize };
  } catch {
    return { total: 0, free: 0 };
  }
}

/** Resident memory per uid from `/proc`, which only root can read for everyone. */
export function memoryByUid(proc = "/proc") {
  let pids = [];
  try {
    pids = fs.readdirSync(proc).filter((name) => /^\d+$/.test(name));
  } catch {
    return new Map();
  }
  return rssByUid(pids.map((pid) => readText(`${proc}/${pid}/status`)).filter(Boolean));
}

const DU_TIMEOUT_MS = 2 * 60 * 1000;
const DU_KEEP_MS = 60 * 60 * 1000;

/**
 * How much each home holds, measured by `du` in the background, one home at a time, and kept for an
 * hour: a big home takes long to walk, so a request only ever reads what was last measured.
 */
export function createHomeSizes({ keepMs = DU_KEEP_MS, timeoutMs = DU_TIMEOUT_MS, measure = duBytes } = {}) {
  const sizes = new Map();
  const queue = [];
  let busy = false;

  const next = async () => {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    try {
      const bytes = await measure(job.home, timeoutMs).catch(() => null);
      if (bytes !== null) sizes.set(job.home, { bytes, at: new Date().toISOString(), checked: Date.now() });
      else sizes.set(job.home, { ...(sizes.get(job.home) ?? { bytes: null, at: null }), checked: Date.now() });
    } finally {
      busy = false;
      void next();
    }
  };

  return {
    /** The home's last size and when it was measured, queueing a new measure once it is old. */
    of(home) {
      const known = sizes.get(home);
      if ((!known || Date.now() - known.checked > keepMs) && !queue.some((job) => job.home === home)) {
        if (known) known.checked = Date.now();
        else sizes.set(home, { bytes: null, at: null, checked: Date.now() });
        queue.push({ home });
        void next();
      }
      const now = sizes.get(home);
      return { bytes: now?.bytes ?? null, at: now?.at ?? null };
    },
  };
}

function duBytes(home, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("du", ["-sxb", home], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    // du exits 1 when a few files can't be read but still prints the total.
    child.on("close", () => {
      clearTimeout(timer);
      resolve(parseDu(out));
    });
  });
}
