import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..", "..", "..");
const read = (file) => fs.readFileSync(path.join(repo, file), "utf8");
const problems = [];

const port = /export const MCP_LOOPBACK_PORT = (\d+);/.exec(read("packages/shared/src/mcp.ts"))?.[1];
const desktopPort = /pub const LOOPBACK_PORT:\s*u16\s*=\s*(\d+);/.exec(read("apps/desktop/src-tauri/src/lib.rs"))?.[1];
if (!port || port !== desktopPort) {
  problems.push(`apps/desktop/src-tauri/src/lib.rs: LOOPBACK_PORT is ${desktopPort}, MCP_LOOPBACK_PORT is ${port}`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`desktop: loopback port matches MCP_LOOPBACK_PORT (${port})`);
