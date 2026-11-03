import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { foldMemory } from "../file-job.mjs";

test("notes Claude Code kept on its own move into the bot's memory once, with a pointer line each", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gond-fold-"));
  try {
    const from = path.join(root, "claude", "memory");
    const to = path.join(root, "bot");
    fs.mkdirSync(from, { recursive: true });
    fs.mkdirSync(path.join(to, "memory"), { recursive: true });
    fs.writeFileSync(path.join(from, "MEMORY.md"), "- [Dentist](dentist.md)\n");
    fs.writeFileSync(path.join(from, "dentist.md"), "---\nname: dentist\ndescription: The person's dentist is Dr. Okafor on Elm Street\n---\nDr. Okafor, Elm Street.\n");
    fs.writeFileSync(path.join(to, "MEMORY.md"), "# Memory\n- likes tea\n");
    fs.writeFileSync(path.join(to, "memory", "claude-code-dentist.md"), "already here");

    foldMemory(from, to);

    const memory = fs.readFileSync(path.join(to, "MEMORY.md"), "utf8");
    assert.match(memory, /- likes tea/);
    assert.match(memory, /- The person's dentist is Dr\. Okafor on Elm Street: memory\/claude-code-dentist-2\.md/);
    // Its index points at the notes, which are folded themselves, so it isn't kept as a note of its own.
    assert.equal(fs.existsSync(path.join(to, "memory", "claude-code-MEMORY.md")), false);
    assert.equal(fs.readFileSync(path.join(to, "memory", "claude-code-dentist.md"), "utf8"), "already here");
    assert.match(fs.readFileSync(path.join(to, "memory", "claude-code-dentist-2.md"), "utf8"), /Dr\. Okafor, Elm Street/);
    assert.equal(fs.existsSync(from), false);
    assert.equal(fs.existsSync(`${from}.folded`), true);

    // Nothing left to move: no change, no error.
    foldMemory(from, to);
    assert.equal(fs.readFileSync(path.join(to, "MEMORY.md"), "utf8"), memory);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
