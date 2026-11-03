import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function runFileJob(job) {
  if (job.op === "write") {
    fs.mkdirSync(path.dirname(job.path), { recursive: true });

    // Atomic: a crash mid-write leaves the old file intact. `wx` never
    // opens a link someone left at the temporary name.
    const tmp = `${job.path}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, job.encoding === "base64" ? Buffer.from(job.content, "base64") : job.content, { mode: 0o600, flag: "wx" });
    fs.renameSync(tmp, job.path);
    return;
  }
  if (job.op === "delete") {
    fs.rmSync(job.path, { recursive: true, force: true });
    return;
  }
  if (job.op === "fold-memory") {
    foldMemory(job.from, job.to);
    return;
  }
  throw Object.assign(new Error(`Unknown file job ${job.op}`), { code: "EINVAL" });
}

/**
 * Moves the notes Claude Code's own memory kept for a bot (`from`, its project's memory folder) into the
 * bot's memory (`to`, its home): each note under memory/ with a pointer line in MEMORY.md, as the house
 * rules keep topics. The old folder is renamed, not read again, and kept as it was.
 */
export function foldMemory(from, to) {
  let names;
  try {
    names = fs.readdirSync(from).filter((name) => name.endsWith(".md"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const pointers = [];
  fs.mkdirSync(path.join(to, "memory"), { recursive: true });
  for (const name of names) {
    const text = fs.readFileSync(path.join(from, name), "utf8");
    if (!text.trim()) continue;
    if (name === "MEMORY.md" && names.length > 1) continue;
    const stem = name.replace(/\.md$/, "").replace(/[^\w.-]+/g, "-");
    let target = `claude-code-${stem}.md`;
    for (let n = 2; fs.existsSync(path.join(to, "memory", target)); n++) target = `claude-code-${stem}-${n}.md`;
    fs.writeFileSync(path.join(to, "memory", target), text, { mode: 0o600, flag: "wx" });
    const described = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim();
    pointers.push(`- ${described || stem.replace(/[-_]+/g, " ")}: memory/${target}`);
  }
  if (pointers.length) fs.appendFileSync(path.join(to, "MEMORY.md"), `\n\n## Notes kept before memory moved here\n${pointers.join("\n")}\n`, { mode: 0o600 });
  fs.renameSync(from, `${from}.folded`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (input += chunk));
  process.stdin.on("end", () => {
    try {
      runFileJob(JSON.parse(input));
      process.stdout.write("ok");
    } catch (error) {
      process.stdout.write(JSON.stringify({ code: error.code ?? null, message: error.message }));
      process.exitCode = 1;
    }
  });
}
