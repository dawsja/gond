import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FALLBACK_CLAUDE_MODELS, createModelLists, engineModels, modelsFromInfo } from "../models.mjs";

test("Claude Code runs on aliases, so the list never goes stale", async () => {
  const models = await engineModels("claude", { bins: { claude: "/nonexistent/claude" } });
  assert.equal(models.find((model) => model.id === "opus")?.default, true);
  assert.equal(models.filter((model) => model.default).length, 1);
});

test("an engine without a list answers nothing", async () => {
  assert.deepEqual(await engineModels("api"), []);
});

const RECORDED = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude-models.json"), "utf8"));

test("a signed-in CLI's list comes through whole, each model once, the CLI's pointer folded into the alias it names", () => {
  const models = modelsFromInfo(RECORDED.signedIn);
  assert.deepEqual(
    models.map((model) => model.id),
    RECORDED.signedIn.map((info) => info.value).filter((id) => id !== "default"),
  );
  assert.equal(models.find((model) => model.id === "fable")?.name, "Fable 5.2");
  assert.deepEqual(models.filter((model) => model.default).map((model) => model.id), ["opus"]);
  assert.ok(models.every((model) => Object.keys(model).every((key) => ["id", "name", "detail", "default"].includes(key))));
});

test("a signed-out CLI still lists its aliases", () => {
  assert.deepEqual(modelsFromInfo(RECORDED.signedOut).map((model) => model.id), ["opus", "fable", "sonnet", "haiku"]);
});

test("rows that are broken, repeated or name a model already listed are left out, and the recommended model is the default when opus isn't listed", () => {
  const models = modelsFromInfo([
    { value: "default", displayName: "Default (recommended)", description: "Fable 5.2", resolvedModel: "claude-fable-5-2" },
    { value: "claude-fable-5-2", displayName: "Fable 5.2", description: "For your toughest challenges", supportedEffortLevels: ["low", "max"], somethingNew: { x: 1 } },
    { value: "sonnet" },
    { value: "sonnet", displayName: "Sonnet again" },
    { value: "claude-sonnet-5-5", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" },
    { value: "sonnet-pinned", resolvedModel: "claude-sonnet-5-5", displayName: "Same model, other name" },
    { value: "has spaces; rm -rf" },
    { value: 42 },
    { displayName: "No id" },
    null,
    "haiku",
  ]);
  assert.deepEqual(models, [
    { id: "claude-fable-5-2", name: "Fable 5.2", detail: "For your toughest challenges", default: true },
    { id: "sonnet" },
    { id: "claude-sonnet-5-5", name: "Sonnet 5.5" },
  ]);
  assert.deepEqual(modelsFromInfo([]), []);
  assert.deepEqual(modelsFromInfo({ models: [] }), []);
});

test("a name or detail from the CLI is one short line, however long or odd", () => {
  const [model] = modelsFromInfo([{ value: "opus", displayName: `Opus\n\t5.5${"!".repeat(200)}`, description: `${"word ".repeat(100)}\u0007end` }]);
  assert.equal(model.name.length, 80);
  assert.ok(model.name.startsWith("Opus 5.5!") && model.name.endsWith("…"));
  assert.equal(model.detail.length, 300);
  assert.ok(!/[\n\t\u0007]/.test(model.name + model.detail));
  assert.deepEqual(modelsFromInfo([{ value: "haiku", displayName: "  Haiku 5.5 ", description: "Fastest" }]), [{ id: "haiku", name: "Haiku 5.5", detail: "Fastest", default: true }]);
});

test("the bundled fallback has one default and no version a person would have to keep current", () => {
  assert.equal(FALLBACK_CLAUDE_MODELS.filter((model) => model.default).length, 1);
  for (const model of FALLBACK_CLAUDE_MODELS) assert.doesNotMatch(`${model.id} ${model.name} ${model.detail}`, /\d/);
});

/** A fake CLI: `body` is shell run after it read the request, with `$id` its request id. Each launch is logged. */
function fakeCli(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gond-models-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "claude");
  const log = path.join(dir, "launches");
  const argv = path.join(dir, "argv");
  fs.writeFileSync(
    bin,
    `#!/bin/sh\necho $$ >> "${log}"\necho "$*" >> "${argv}"\nread line\nid=$(printf '%s' "$line" | sed 's/.*"request_id":"\\([^"]*\\)".*/\\1/')\n${body}\n`,
    { mode: 0o755 },
  );
  const launches = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  const args = () => fs.readFileSync(argv, "utf8");
  return { bin, launches, args };
}

const answer = (models, subtype = "success") =>
  `printf '%s\\n' "{\\"type\\":\\"control_response\\",\\"response\\":{\\"subtype\\":\\"${subtype}\\",\\"request_id\\":\\"$id\\",\\"response\\":{\\"models\\":${JSON.stringify(models).replace(/"/g, '\\"')}}}}"`;

const gone = async (pid) => {
  for (let i = 0; i < 100; i += 1) {
    try {
      process.kill(Number(pid), 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
};

test("the CLI is asked for its list, and stopped as soon as it answers", async (t) => {
  const cli = fakeCli(t, `${answer([{ value: "opus", displayName: "Opus 9" }, { value: "claude-new-1", displayName: "New 1" }])}\nsleep 30`);
  const started = Date.now();
  const models = await engineModels("claude", { bins: { claude: cli.bin }, env: { PATH: process.env.PATH }, timeoutMs: 20_000 });
  assert.ok(Date.now() - started < 10_000, "the look waited for the CLI instead of stopping it");
  assert.deepEqual(models, [{ id: "opus", name: "Opus 9", default: true }, { id: "claude-new-1", name: "New 1" }]);
  assert.ok(await gone(cli.launches()[0]));
  assert.match(cli.args(), /--settings \{"disableAllHooks":true\}/, "the look would run the person's hooks");
});

test("whatever the CLI does, the list is never empty", async (t) => {
  const env = { PATH: process.env.PATH };
  const cases = {
    fails: "echo 'Error: something broke' >&2\nexit 1",
    hangs: "sleep 30",
    garbage: "echo 'not json'\necho '{\"type\":\"control_response\",'\nexit 0",
    "lists nothing": answer([]),
    "answers an error": answer([{ value: "opus" }], "error"),
    "answers another request": `id=other\n${answer([{ value: "opus" }])}`,
  };
  for (const [name, body] of Object.entries(cases)) {
    const cli = fakeCli(t, body);
    const models = await engineModels("claude", { bins: { claude: cli.bin }, env, timeoutMs: 500 });
    assert.deepEqual(models, FALLBACK_CLAUDE_MODELS.map((model) => ({ ...model })), name);
    assert.ok(await gone(cli.launches()[0]), `${name}: the CLI was left running`);
  }
  assert.deepEqual(await engineModels("claude", { bins: { claude: "/nonexistent/claude" }, env }), FALLBACK_CLAUDE_MODELS.map((model) => ({ ...model })));
});

test("a list is kept for its time, asked once by callers at the same moment, and the last good one outlives a failed look", async () => {
  let clock = 0;
  let listed = [{ id: "opus", name: "Opus 5.5", default: true }];
  let asks = 0;
  const lists = createModelLists({ ttlMs: 1000, retryMs: 100, now: () => clock, ask: async () => (asks += 1, listed) });

  const [a, b] = await Promise.all([lists.get("u:claude", "claude"), lists.get("u:claude", "claude")]);
  assert.deepEqual([a, b, asks], [listed, listed, 1]);
  clock = 999;
  await lists.get("u:claude", "claude");
  assert.equal(asks, 1);

  clock = 1000;
  listed = [{ id: "opus", name: "Opus 6", default: true }];
  assert.equal((await lists.get("u:claude", "claude"))[0].name, "Opus 6");
  assert.equal(asks, 2);

  clock = 2000;
  listed = null;
  assert.equal((await lists.get("u:claude", "claude"))[0].name, "Opus 6");
  clock = 2050;
  await lists.get("u:claude", "claude");
  assert.equal(asks, 3, "a failed look is tried again only after retryMs");
  clock = 2100;
  listed = [{ id: "sonnet", name: "Sonnet 6", default: true }];
  assert.deepEqual((await lists.get("u:claude", "claude")).map((model) => model.id), ["sonnet"], "a model the CLI stopped listing is gone");

  assert.deepEqual(await createModelLists({ ask: async () => null }).get("v:claude", "claude"), FALLBACK_CLAUDE_MODELS.map((model) => ({ ...model })));

  lists.forget("u:");
  listed = [{ id: "haiku", default: true }];
  assert.deepEqual((await lists.get("u:claude", "claude")).map((model) => model.id), ["haiku"]);
});

test("looks that keep failing keep the last good list only for a bounded time, then the fallback", async () => {
  let clock = 0;
  let listed = [{ id: "claude-retired-1", name: "Retired 1", default: true }];
  let asks = 0;
  const lists = createModelLists({ ttlMs: 1000, retryMs: 100, lastGoodMs: 10_000, now: () => clock, ask: async () => (asks += 1, listed) });
  await lists.get("u:claude", "claude");
  listed = null;
  for (clock = 1000; clock < 10_000; clock += 100) assert.equal((await lists.get("u:claude", "claude"))[0].id, "claude-retired-1");
  clock = 10_000;
  assert.deepEqual(await lists.get("u:claude", "claude"), FALLBACK_CLAUDE_MODELS.map((model) => ({ ...model })));
  assert.equal(asks, 92, "a failing look is still tried again every retryMs");
  clock = 10_100;
  listed = [{ id: "opus", name: "Opus 6", default: true }];
  assert.equal((await lists.get("u:claude", "claude"))[0].name, "Opus 6");
});

test("two calls inside the cache's time launch the CLI once", async (t) => {
  const cli = fakeCli(t, answer([{ value: "opus", displayName: "Opus 5.5" }]));
  const lists = createModelLists();
  const options = { bins: { claude: cli.bin }, env: { PATH: process.env.PATH } };
  await Promise.all([lists.get("u:claude", "claude", options), lists.get("u:claude", "claude", options)]);
  await lists.get("u:claude", "claude", options);
  assert.equal(cli.launches().length, 1);
});
