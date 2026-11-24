import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const mac = path.join(here, "..");
const repo = path.join(mac, "..", "..");
const read = (file) => fs.readFileSync(path.join(repo, file), "utf8");
const problems = [];

const shell = read("apps/web/lib/shell.ts");
const type = /export type GondMac = \{([\s\S]*?)\n\};/.exec(shell)?.[1] ?? "";
const methods = [...type.matchAll(/^\s*([a-zA-Z]+)\??\(/gm)].map((m) => m[1]);
if (!methods.length) problems.push("apps/web/lib/shell.ts: couldn't read the GondMac type");
const webShell = read("apps/mac/Gond/WebShell.swift");
for (const method of methods) {
  if (!new RegExp(`\\b${method}: function`).test(webShell)) problems.push(`apps/mac/Gond/WebShell.swift: the bridge has no ${method}(), which the web app's GondMac type names`);
}
if (!webShell.includes('name: "gondMac"') || !webShell.includes("messageHandlers.gondMac.postMessage")) problems.push("apps/mac/Gond/WebShell.swift: the bridge and its message handler must both be gondMac");

const port = /export const MCP_LOOPBACK_PORT = (\d+);/.exec(read("packages/shared/src/mcp.ts"))?.[1];
const macPort = /static let loopbackPort = (\d+)/.exec(webShell)?.[1];
if (!port || port !== macPort) problems.push(`apps/mac/Gond/WebShell.swift: loopbackPort is ${macPort}, MCP_LOOPBACK_PORT is ${port}`);

const project = read("apps/mac/project.yml");
for (const key of ["NSAllowsArbitraryLoads: true", "ENABLE_HARDENED_RUNTIME: YES"]) {
  if (!project.includes(key)) problems.push(`apps/mac/project.yml: ${key} is missing`);
}
for (const [, source] of project.matchAll(/^\s*- path: (\.\.\/\S+)/gm)) {
  if (!fs.existsSync(path.join(mac, source))) problems.push(`apps/mac/project.yml: ${source} doesn't exist`);
}
const iconDir = path.join(repo, "apps/ios/AppIcon.icon");
const iconJson = path.join(iconDir, "icon.json");
if (!project.includes("path: ../ios/AppIcon.icon")) problems.push("apps/mac/project.yml: the app icon isn't the iPhone app's AppIcon.icon");
if (!fs.existsSync(iconJson)) problems.push("apps/ios: the app icon is missing");
else {
  const icon = JSON.parse(fs.readFileSync(iconJson, "utf8"));
  for (const layer of (icon.groups ?? []).flatMap((group) => group.layers ?? [])) {
    if (layer["image-name"] && !fs.existsSync(path.join(iconDir, "Assets", layer["image-name"]))) problems.push(`apps/ios: the app icon's ${layer["image-name"]} is missing`);
  }
}

// CLAUDE.md: no em dashes anywhere, comments and copy included.
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return ["build", "DerivedData", "Gond.xcodeproj", "node_modules"].includes(entry.name) ? [] : walk(full);
  return /\.(swift|ya?ml|mjs|json)$/.test(entry.name) ? [full] : [];
});
for (const file of walk(mac)) {
  if (fs.readFileSync(file, "utf8").includes(String.fromCharCode(0x2014))) problems.push(`${path.relative(repo, file)}: has an em dash`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`mac: the bridge covers ${methods.length} methods, and the loopback port, shared files and entitlements match`);
