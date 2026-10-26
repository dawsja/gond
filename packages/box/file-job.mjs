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
  throw Object.assign(new Error(`Unknown file job ${job.op}`), { code: "EINVAL" });
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
