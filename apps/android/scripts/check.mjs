// A quick check without the Android SDK: every string, colour and drawable
// the Kotlin sources and layouts name exists in res/. Gradle does the rest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "app", "src", "main");
const repo = path.join(here, "..", "..", "..");
const res = path.join(root, "res");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else out.push(file);
  }
  return out;
}

const defined = { string: new Set(), color: new Set(), drawable: new Set(), mipmap: new Set() };
for (const file of walk(res)) {
  const kind = path.basename(path.dirname(file)).split("-")[0];
  const name = path.basename(file).replace(/\.[^.]+$/, "");
  if (kind === "drawable" || kind === "mipmap" || kind === "color") defined[kind].add(name);
  if (kind === "values") {
    const xml = fs.readFileSync(file, "utf8");
    for (const [, type, id] of xml.matchAll(/<(string|color)\s+name="([^"]+)"/g)) defined[type].add(id);
  }
}

const problems = [];
const sources = [...walk(path.join(root, "kotlin")), ...walk(res).filter((f) => f.endsWith(".xml")), path.join(root, "AndroidManifest.xml")];
for (const file of sources) {
  const text = fs.readFileSync(file, "utf8");
  for (const [, type, id] of text.matchAll(/R\.(string|color|drawable|mipmap)\.([a-z0-9_]+)/g)) {
    if (!defined[type].has(id)) problems.push(`${path.relative(root, file)}: R.${type}.${id} is not defined`);
  }
  for (const [, type, id] of text.matchAll(/@(string|color|drawable|mipmap)\/([a-z0-9_]+)/g)) {
    if (!defined[type].has(id)) problems.push(`${path.relative(root, file)}: @${type}/${id} is not defined`);
  }
}
const sharedMcp = fs.readFileSync(path.join(repo, "packages/shared/src/mcp.ts"), "utf8");
const port = /export const MCP_LOOPBACK_PORT = (\d+);/.exec(sharedMcp)?.[1];
const mainActivity = fs.readFileSync(path.join(root, "kotlin/io/gond/android/MainActivity.kt"), "utf8");
const androidPort = /const val LOOPBACK_PORT = (\d+)/.exec(mainActivity)?.[1];
if (!port || port !== androidPort) {
  problems.push(`apps/android/app/src/main/kotlin/io/gond/android/MainActivity.kt: LOOPBACK_PORT is ${androidPort}, MCP_LOOPBACK_PORT is ${port}`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`android: ${sources.length} files reference only resources that exist, and the loopback port matches`);
