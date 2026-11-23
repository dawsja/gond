import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const root = join(import.meta.dir, "..");
const API_PORT = 8799;
const WEB_PORT = 3005;
const SERVER = `http://127.0.0.1:${WEB_PORT}`;
const APPEARANCES = ["light", "dark"] as const;
const DERIVED = join(tmpdir(), "gond-screens-derived");
const PLATFORMS = ["ios", "mac"] as const;
type Platform = (typeof PLATFORMS)[number];

const usage = `Usage: bun run screens [ios|mac] [--out <dir>] [--no-build]

Takes light and dark screenshots of the iPhone app in a simulator and of the
Mac app, against a throwaway Gond with seeded data. With no platform named,
it takes both.`;

function parseArgs(argv: string[]) {
  const platforms = new Set<Platform>();
  let out: string | null = null;
  let build = true;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      process.exit(0);
    } else if (arg === "--out") {
      out = argv[++i] ?? null;
      if (!out) throw new Error("--out needs a folder");
    } else if (arg === "--no-build") {
      build = false;
    } else if ((PLATFORMS as readonly string[]).includes(arg)) {
      platforms.add(arg as Platform);
    } else {
      throw new Error(`Unknown argument ${arg}\n\n${usage}`);
    }
  }
  return { platforms: platforms.size ? [...platforms] : [...PLATFORMS], out, build };
}

async function run(cmd: string[], options: { cwd?: string; env?: Record<string, string>; log?: string } = {}) {
  const log = options.log ? openSync(options.log, "a") : null;
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd ?? root,
    env: { ...process.env, ...options.env },
    stdout: log ?? "inherit",
    stderr: log ?? "inherit",
  });
  try {
    return await proc.exited;
  } finally {
    if (log !== null) closeSync(log);
  }
}

async function output(cmd: string[], env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, { cwd: root, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  return text;
}

async function xcodeEnv(): Promise<Record<string, string>> {
  if (process.env.DEVELOPER_DIR) return {};
  const selected = (await output(["xcode-select", "-p"]).catch(() => "")).trim();
  if (!selected.includes("CommandLineTools")) return {};
  const xcode = "/Applications/Xcode.app/Contents/Developer";
  if (!existsSync(xcode)) throw new Error("Xcode isn't installed; the Command Line Tools alone can't run UI tests");
  return { DEVELOPER_DIR: xcode };
}

async function portFree(port: number) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

async function waitForHealth() {
  for (let i = 0; i < 90; i += 1) {
    const ok = await fetch(`${SERVER}/api/health`).then((r) => r.ok, () => false);
    if (ok) return;
    await Bun.sleep(1000);
  }
  throw new Error("The throwaway Gond never answered; see api.log and web.log");
}

async function register(): Promise<string> {
  const response = await fetch(`${SERVER}/api/register`, {
    method: "POST",
    headers: { Origin: SERVER, "Content-Type": "application/json" },
    body: JSON.stringify({ token: "screens", username: "screens", password: "screens-pass-123", confirm: "screens-pass-123" }),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`Registering failed: ${response.status} ${await response.text()}`);
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith("better-auth.session_token="));
  if (!cookie) throw new Error("Registering gave no session cookie");
  return cookie.split(";")[0]!;
}

async function pickSimulator(env: Record<string, string>) {
  const list = JSON.parse(await output(["xcrun", "simctl", "list", "devices", "available", "-j"], env)) as {
    devices: Record<string, { udid: string; name: string }[]>;
  };
  const phones = Object.values(list.devices).flat().filter((d) => d.name.startsWith("iPhone"));
  const number = (name: string) => Number(/^iPhone (\d+)/.exec(name)?.[1] ?? 0);
  const pros = phones.filter((d) => /^iPhone \d+ Pro$/.test(d.name)).sort((a, b) => number(b.name) - number(a.name));
  const device = pros[0] ?? phones[0];
  if (!device) throw new Error("No iPhone simulator; add one in Xcode → Settings → Components");
  return device;
}

interface Seeded {
  cookie: string;
  thread: string;
  room: string;
}

function testEnv(seeded: Seeded, folder: string, appearance: string) {
  return {
    TEST_RUNNER_GOND_SCREENS_SERVER: SERVER,
    TEST_RUNNER_GOND_SCREENS_COOKIE: seeded.cookie,
    TEST_RUNNER_GOND_SCREENS_THREAD: seeded.thread,
    TEST_RUNNER_GOND_SCREENS_ROOM: seeded.room,
    TEST_RUNNER_GOND_SCREENS_DIR: folder,
    TEST_RUNNER_GOND_SCREENS_APPEARANCE: appearance,
  };
}

async function iphone(seeded: Seeded, out: string, work: string, xcode: Record<string, string>) {
  const project = join(root, "apps/ios");
  if ((await run(["xcodegen", "generate", "--quiet"], { cwd: project, env: xcode })) !== 0) return false;
  const device = await pickSimulator(xcode);
  console.log(`iPhone: ${device.name}`);
  await run(["xcrun", "simctl", "boot", device.udid], { env: xcode, log: join(work, "simctl.log") });
  await run(["xcrun", "simctl", "bootstatus", device.udid, "-b"], { env: xcode, log: join(work, "simctl.log") });
  const folder = join(out, "iphone");
  await mkdir(folder, { recursive: true });
  let ok = true;
  for (const appearance of APPEARANCES) {
    await run(["xcrun", "simctl", "ui", device.udid, "appearance", appearance], { env: xcode });
    const log = join(work, `iphone-${appearance}.log`);
    console.log(`iPhone, ${appearance}: building and running (log: ${log})`);
    const code = await run(
      ["xcodebuild", "test", "-project", "Gond.xcodeproj", "-scheme", "GondScreens", "-destination", `id=${device.udid}`,
        ...(appearance === "light" ? [] : ["-only-testing:GondUITests/ScreensTests/testScreens"]), "-derivedDataPath", join(DERIVED, "ios"),
        "-resultBundlePath", join(work, `iphone-${appearance}.xcresult`), "CODE_SIGNING_ALLOWED=NO"],
      { cwd: project, env: { ...xcode, ...testEnv(seeded, folder, appearance) }, log },
    );
    if (code !== 0) {
      ok = false;
      console.log(`iPhone, ${appearance}: xcodebuild exited ${code}`);
    }
  }
  return ok;
}

export async function exportAttachments(bundle: string, folder: string, xcode: Record<string, string>) {
  if (!existsSync(bundle)) return 0;
  const exported = await mkdtemp(join(tmpdir(), "gond-attachments-"));
  try {
    await output(["xcrun", "xcresulttool", "export", "attachments", "--path", bundle, "--output-path", exported], xcode);
    const manifest = JSON.parse(await Bun.file(join(exported, "manifest.json")).text()) as {
      attachments: { exportedFileName: string; suggestedHumanReadableName: string }[];
    }[];
    let count = 0;
    for (const { exportedFileName, suggestedHumanReadableName } of manifest.flatMap((test) => test.attachments)) {
      if (!exportedFileName.endsWith(".png")) continue;
      const name = suggestedHumanReadableName.replace(/_\d+_[0-9A-F-]+\.png$/i, ".png");
      await Bun.write(join(folder, name), Bun.file(join(exported, exportedFileName)));
      count += 1;
    }
    return count;
  } finally {
    await rm(exported, { recursive: true, force: true });
  }
}

async function mac(seeded: Seeded, out: string, work: string, xcode: Record<string, string>) {
  const project = join(root, "apps/mac");
  if ((await run(["xcodegen", "generate", "--quiet"], { cwd: project, env: xcode })) !== 0) return false;
  const folder = join(out, "mac");
  await mkdir(folder, { recursive: true });
  console.log("Mac: the tests drive the app with the mouse and keyboard; leave them be until it's done.");
  console.log("Mac: macOS may ask to allow Automation Mode the first time.");
  let ok = true;
  for (const appearance of APPEARANCES) {
    const log = join(work, `mac-${appearance}.log`);
    console.log(`Mac, ${appearance}: building and running (log: ${log})`);
    const bundle = join(work, `mac-${appearance}.xcresult`);
    const code = await run(
      ["xcodebuild", "test", "-project", "Gond.xcodeproj", "-scheme", "GondScreens", "-destination", "platform=macOS",
        "-only-testing:GondUITests/ScreensTests/testScreens", "-derivedDataPath", join(DERIVED, "mac"),
        "-resultBundlePath", bundle, "CODE_SIGN_IDENTITY=-"],
      { cwd: project, env: { ...xcode, ...testEnv(seeded, folder, appearance) }, log },
    );
    console.log(`Mac, ${appearance}: ${await exportAttachments(bundle, folder, xcode)} screenshots`);
    if (code !== 0) {
      ok = false;
      console.log(`Mac, ${appearance}: xcodebuild exited ${code}`);
    }
  }
  return ok;
}

async function main() {
  const { platforms, out: outArg, build } = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin") throw new Error("Screenshots need a Mac with Xcode");
  if (!Bun.which("xcodegen")) throw new Error("XcodeGen is missing: brew install xcodegen");
  const xcode = await xcodeEnv();
  if (!(await portFree(API_PORT)) || !(await portFree(WEB_PORT))) {
    throw new Error(`Ports ${API_PORT} and ${WEB_PORT} must be free for the throwaway Gond`);
  }

  const work = await mkdtemp(join(tmpdir(), "gond-screens-"));
  const out = resolve(outArg ?? join(work, "screens"));
  await mkdir(out, { recursive: true });
  const data = join(work, "gond");
  await mkdir(data);

  if (build && (await run(["bun", "run", "--filter", "@gond/web", "build"], { log: join(work, "web-build.log") })) !== 0) {
    throw new Error(`The web build failed; see ${join(work, "web-build.log")}`);
  }

  const apiLog = openSync(join(work, "api.log"), "a");
  const webLog = openSync(join(work, "web.log"), "a");
  const servers: Subprocess[] = [];
  const stop = () => servers.forEach((server) => server.kill());
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
  try {
    servers.push(Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: join(root, "apps/api"),
      env: { ...process.env, GOND_DATA_DIR: data, GOND_SETUP_TOKEN: "screens", PORT: String(API_PORT), APP_URL: SERVER },
      stdout: apiLog,
      stderr: apiLog,
    }));
    servers.push(Bun.spawn(["bunx", "--bun", "next", "start", "-H", "127.0.0.1", "-p", String(WEB_PORT)], {
      cwd: join(root, "apps/web"),
      env: { ...process.env, GOND_API_URL: `http://127.0.0.1:${API_PORT}` },
      stdout: webLog,
      stderr: webLog,
    }));
    await waitForHealth();
    const cookie = await register();
    const seededLine = (await output(["bun", "apps/ios/scripts/screens-seed.ts"], { GOND_DATA_DIR: data })).trim().split("\n").at(-1)!;
    const [thread, room] = seededLine.split(" ");
    if (!thread || !room) throw new Error(`The seed gave no conversation: ${seededLine}`);
    const seeded = { cookie, thread, room };

    let ok = true;
    if (platforms.includes("ios")) ok = (await iphone(seeded, out, work, xcode)) && ok;
    if (platforms.includes("mac")) ok = (await mac(seeded, out, work, xcode)) && ok;
    console.log(`\nScreenshots: ${out}\nLogs and result bundles: ${work}`);
    if (!ok) process.exitCode = 1;
  } finally {
    stop();
    await Promise.all(servers.map((server) => server.exited));
    closeSync(apiLog);
    closeSync(webLog);
    await rm(data, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
