import assert from "node:assert/strict";
import test from "node:test";
import { engineModels } from "../models.mjs";

test("Claude Code runs on aliases, so the list never goes stale", async () => {
  const models = await engineModels("claude");
  assert.equal(models.find((model) => model.id === "opus")?.default, true);
  assert.equal(models.filter((model) => model.default).length, 1);
});

test("an engine without a list answers nothing", async () => {
  assert.deepEqual(await engineModels("api"), []);
});
