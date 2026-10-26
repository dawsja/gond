// A quick check without Xcode, for what would drift from the rest of Gond
// unnoticed: the bridge offers every method the web app's GondMobile type
// names, the MCP loopback port matches packages/shared, ServerURL is tested
// on every address the Android app's tests use, and the microphone has its
// reason. Xcode, in CI, does the rest.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ios = path.join(here, "..");
const repo = path.join(ios, "..", "..");
const read = (file) => fs.readFileSync(path.join(repo, file), "utf8");
const problems = [];

const shell = read("apps/web/lib/shell.ts");
const type = /export type GondMobile = \{([\s\S]*?)\n\};/.exec(shell)?.[1] ?? "";
const methods = [...type.matchAll(/^\s*([a-zA-Z]+)\??\(/gm)].map((m) => m[1]);
if (!methods.length) problems.push("apps/web/lib/shell.ts: couldn't read the GondMobile type");
const webShell = read("apps/ios/Gond/WebShell.swift");
for (const method of methods) {
  if (!new RegExp(`\\b${method}: function`).test(webShell)) problems.push(`apps/ios/Gond/WebShell.swift: the bridge has no ${method}(), which the web app's GondMobile type names`);
}

const port = /export const MCP_LOOPBACK_PORT = (\d+);/.exec(read("packages/shared/src/index.ts"))?.[1];
const iosPort = /static let loopbackPort = (\d+)/.exec(webShell)?.[1];
if (!port || port !== iosPort) problems.push(`apps/ios/Gond/WebShell.swift: loopbackPort is ${iosPort}, MCP_LOOPBACK_PORT is ${port}`);

const android = read("apps/android/app/src/test/kotlin/io/gond/android/ServerUrlTest.kt");
const swift = read("apps/ios/GondTests/ServerURLTests.swift");
for (const [, input] of android.matchAll(/(?:candidates|reason|sameOrigin)\("([^"]*)"/g)) {
  if (!swift.includes(`"${input}"`)) problems.push(`apps/ios/GondTests/ServerURLTests.swift: Android tests "${input}" and this doesn't`);
}

const project = read("apps/ios/project.yml");
for (const key of ["NSMicrophoneUsageDescription", "NSLocalNetworkUsageDescription", "UILaunchScreen"]) {
  if (!project.includes(`${key}:`)) problems.push(`apps/ios/project.yml: ${key} is missing`);
}
const iconDir = path.join(ios, "AppIcon.icon");
const iconJson = path.join(iconDir, "icon.json");
if (!fs.existsSync(iconJson)) problems.push("apps/ios: the app icon is missing");
else {
  const icon = JSON.parse(fs.readFileSync(iconJson, "utf8"));
  for (const layer of (icon.groups ?? []).flatMap((group) => group.layers ?? [])) {
    if (layer["image-name"] && !fs.existsSync(path.join(iconDir, "Assets", layer["image-name"]))) problems.push(`apps/ios: the app icon's ${layer["image-name"]} is missing`);
  }
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`ios: the bridge covers ${methods.length} methods, and the loopback port and address tests match`);
