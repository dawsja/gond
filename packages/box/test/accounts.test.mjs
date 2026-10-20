import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Accounts, FIRST_UID, accountName, handOver, nextSlot, nextUid } from "../accounts.mjs";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gond-accounts-"));
  const skills = path.join(dir, "skills");
  const agentHome = path.join(dir, "agent");
  fs.mkdirSync(agentHome, { recursive: true });
  const make = () =>
    new Accounts({
      stateDir: path.join(dir, "state"),
      homesDir: path.join(dir, "homes"),
      root: false,
      skillsRoot: skills,
      agent: { name: "agent", uid: 1001, gid: 1001, home: agentHome, dirs: { claude: path.join(dir, "claude-volume") } },
    });
  return { dir, skills, agentHome, make, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("accountName is gond- plus the person's letters, unique among the taken", () => {
  assert.equal(accountName({ name: "Ada Lovelace" }), "gond-ada-lovelace");
  assert.equal(accountName({ name: "", email: "Bob.Smith@example.com" }), "gond-bob-smith");
  assert.equal(accountName({ name: "日本", email: "", id: "u1" }), "gond-u1");
  assert.equal(accountName({ name: "42" }), "gond-p42");
  assert.equal(accountName({ name: "ada" }, new Set(["gond-ada", "gond-ada-2"])), "gond-ada-3");
  assert.ok(accountName({ name: "x".repeat(80) }).length <= 32);
});

test("an account from before the rename gets its gond- name, the same uid and its home moved over", () => {
  const f = fixture();
  try {
    const state = path.join(f.dir, "state");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(
      path.join(state, "accounts.json"),
      JSON.stringify({ version: 1, accounts: { "u-admin": { name: "agent", uid: 1001, slot: 0, admin: true }, "u-ada": { name: "kru-ada", uid: FIRST_UID, slot: 1, admin: false } } }),
    );
    const oldHome = path.join(f.dir, "homes", "kru-ada");
    fs.mkdirSync(path.join(oldHome, ".bots"), { recursive: true });
    fs.writeFileSync(path.join(oldHome, "notes.md"), "mine");
    fs.mkdirSync(path.join(f.skills, "kru-ada", "hello"), { recursive: true });
    fs.symlinkSync(path.join(f.skills, "kru-ada"), path.join(oldHome, ".skills"));
    const accounts = f.make();
    accounts.adoptLegacyNames();
    accounts.restore();
    const ada = accounts.get("u-ada");
    assert.equal(ada.name, "gond-ada");
    assert.equal(ada.home, path.join(f.dir, "homes", "gond-ada"));
    assert.equal(accounts.get("u-admin").name, "agent");
    assert.equal(fs.existsSync(oldHome), false);
    assert.equal(fs.readFileSync(path.join(ada.home, "notes.md"), "utf8"), "mine");
    assert.equal(fs.readlinkSync(path.join(ada.home, ".skills")), path.join(f.skills, "gond-ada"));
    assert.equal(fs.existsSync(path.join(f.skills, "kru-ada")), false);
    const saved = JSON.parse(fs.readFileSync(path.join(state, "accounts.json"), "utf8"));
    assert.equal(saved.accounts["u-ada"].name, "gond-ada");
    assert.equal(saved.accounts["u-ada"].uid, FIRST_UID);
    assert.equal(f.make().get("u-ada").name, "gond-ada");
  } finally {
    f.cleanup();
  }
});

test("uids and desktop slots are the lowest free ones", () => {
  assert.equal(nextUid(new Set([1001])), FIRST_UID);
  assert.equal(nextUid(new Set([1001, FIRST_UID, FIRST_UID + 1])), FIRST_UID + 2);
  assert.equal(nextSlot(new Set()), 1);
  assert.equal(nextSlot(new Set([1, 2])), 3);
});

test("the admin is the agent; everyone else gets a home of their own, kept across restarts", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    const admin = accounts.ensure({ id: "u-admin", name: "Admin", email: "admin@example.com", admin: true });
    assert.equal(admin.name, "agent");
    assert.equal(admin.home, f.agentHome);
    assert.equal(admin.claude, path.join(f.dir, "claude-volume"));
    assert.equal(admin.slot, 0);
    const ada = accounts.ensure({ id: "u-ada", name: "Ada", email: "ada@example.com", admin: false });
    assert.equal(ada.name, "gond-ada");
    assert.equal(ada.home, path.join(f.dir, "homes", "gond-ada"));
    assert.equal(ada.slot, 1);
    assert.ok(fs.statSync(path.join(ada.home, ".bots")).isDirectory());
    assert.ok(fs.statSync(path.join(ada.home, ".team")).isDirectory());
    assert.equal(fs.readlinkSync(path.join(ada.home, ".skills")), path.join(f.skills, "gond-ada"));
    assert.ok(fs.statSync(path.join(f.skills, "gond-ada")).isDirectory());
    assert.deepEqual(ada.logins, [path.join(ada.home, ".claude"), path.join(ada.home, ".codex"), path.join(ada.home, ".grok")]);

    assert.equal(accounts.ensure({ id: "u-ada", name: "Ada", admin: false }).name, "gond-ada");
    assert.equal(accounts.ensure({ id: "u-ada2", name: "Ada", admin: false }).name, "gond-ada-2");
    assert.throws(() => accounts.ensure({ id: "u-ada", name: "Ada", admin: true }), /role changed/);
    assert.throws(() => accounts.ensure({ id: "u-other", name: "Other", admin: true }), /already has an admin/);

    const again = f.make();
    assert.equal(again.get("u-ada").name, "gond-ada");
    assert.equal(again.get("u-ada2").slot, 2);
    assert.equal(again.admin().id, "u-admin");
    assert.equal(again.get("nobody"), null);
    again.restore();
    assert.ok(fs.existsSync(path.join(f.dir, "homes", "gond-ada-2", ".bots")));
  } finally {
    f.cleanup();
  }
});

test("a home's old skills folder becomes the link to the person's own library, never copied into it, and removing an account removes the home and library", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    fs.mkdirSync(path.join(f.agentHome, ".skills", "hello"), { recursive: true });
    fs.writeFileSync(path.join(f.agentHome, ".skills", "hello", "SKILL.md"), "hi");

    fs.mkdirSync(path.join(f.skills, "old-shared"), { recursive: true });
    fs.writeFileSync(path.join(f.skills, "old-shared", "SKILL.md"), "old");
    accounts.clearLegacySkills();
    assert.equal(fs.existsSync(path.join(f.skills, "old-shared")), false);
    accounts.materialize(accounts.agentAccount());
    assert.equal(fs.readlinkSync(path.join(f.agentHome, ".skills")), path.join(f.skills, "agent"));
    assert.equal(fs.existsSync(path.join(f.skills, "agent", "hello")), false);
    const ada = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });
    fs.writeFileSync(path.join(ada.home, "notes.md"), "mine");
    fs.mkdirSync(path.join(ada.library, "mine"));

    assert.notEqual(ada.library, accounts.agentAccount().library);
    assert.equal(accounts.remove("u-ada"), true);
    assert.equal(fs.existsSync(ada.home), false);
    assert.equal(fs.existsSync(ada.library), false);
    assert.equal(accounts.get("u-ada"), null);
    assert.equal(accounts.remove("u-ada"), false);
    accounts.ensure({ id: "u-admin", name: "Admin", admin: true });
    assert.throws(() => accounts.remove("u-admin"), /admin/);
  } finally {
    f.cleanup();
  }
});

test("a reset empties the admin's home, takes every other account, and keeps the sign-ins", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    const admin = accounts.ensure({ id: "u-admin", name: "Admin", admin: true });
    const ada = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });

    fs.mkdirSync(path.join(admin.bots, "bot-1"), { recursive: true });
    fs.writeFileSync(path.join(admin.bots, "bot-1", "MEMORY.md"), "what it learned");
    fs.writeFileSync(path.join(admin.team, "MEMORY.md"), "the team's");
    fs.mkdirSync(path.join(admin.home, ".npm-global"), { recursive: true });
    fs.mkdirSync(admin.codex, { recursive: true });
    fs.writeFileSync(path.join(admin.codex, "auth.json"), "admin codex");
    fs.mkdirSync(admin.claude, { recursive: true });
    fs.writeFileSync(path.join(admin.claude, "creds.json"), "admin claude");
    fs.mkdirSync(path.join(f.skills, "hello"), { recursive: true });
    fs.writeFileSync(path.join(f.skills, "hello", "SKILL.md"), "hi");

    fs.writeFileSync(path.join(ada.home, "notes.md"), "mine");
    fs.mkdirSync(ada.grok, { recursive: true });
    fs.writeFileSync(path.join(ada.grok, "auth.json"), "ada grok");

    const result = accounts.reset();
    assert.deepEqual(result.accounts, ["gond-ada"]);
    assert.ok(result.removed.includes(".npm-global"));

    assert.equal(accounts.get("u-ada"), null);
    assert.equal(fs.existsSync(ada.home), false);
    assert.equal(accounts.admin().id, "u-admin");

    assert.deepEqual(fs.readdirSync(admin.bots), []);
    assert.deepEqual(fs.readdirSync(admin.team), []);
    assert.equal(fs.existsSync(path.join(admin.home, ".npm-global")), false);
    assert.equal(fs.readlinkSync(path.join(admin.home, ".skills")), path.join(f.skills, "agent"));

    assert.deepEqual(fs.readdirSync(f.skills), ["agent"]);
    assert.deepEqual(fs.readdirSync(path.join(f.skills, "agent")), []);

    assert.equal(fs.readFileSync(path.join(admin.codex, "auth.json"), "utf8"), "admin codex");
    assert.equal(fs.readFileSync(path.join(admin.claude, "creds.json"), "utf8"), "admin claude");
    const again = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });
    assert.equal(fs.readFileSync(path.join(again.grok, "auth.json"), "utf8"), "ada grok");
    assert.equal(fs.existsSync(path.join(again.home, "notes.md")), false);

    assert.equal(fs.existsSync(accounts.stashDir("u-ada")), false);
  } finally {
    f.cleanup();
  }
});

test("a reset with nobody else on the box still empties the admin's home", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    const admin = accounts.ensure({ id: "u-admin", name: "Admin", admin: true });
    fs.writeFileSync(path.join(admin.home, "stray.txt"), "x");
    const result = accounts.reset();
    assert.deepEqual(result.accounts, []);
    assert.ok(result.removed.includes("stray.txt"));
    assert.equal(fs.existsSync(path.join(admin.home, "stray.txt")), false);
  } finally {
    f.cleanup();
  }
});

test("deleting a person takes the sign-ins a reset had kept for them", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    accounts.ensure({ id: "u-admin", name: "Admin", admin: true });
    const ada = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });
    fs.mkdirSync(ada.claude, { recursive: true });
    fs.writeFileSync(path.join(ada.claude, "creds.json"), "ada claude");
    accounts.reset();
    assert.ok(fs.existsSync(accounts.stashDir("u-ada")));

    assert.equal(accounts.remove("u-ada"), false);
    assert.equal(fs.existsSync(accounts.stashDir("u-ada")), false);
    const again = accounts.ensure({ id: "u-ada", name: "Ada", admin: false });
    assert.equal(fs.existsSync(path.join(again.claude, "creds.json")), false);
  } finally {
    f.cleanup();
  }
});

test("handOver owns what is in the home and refuses a link, or a path through one, that leads out", () => {
  const f = fixture();
  try {
    const home = path.join(f.dir, "home");
    const outside = path.join(f.dir, "outside");
    fs.mkdirSync(path.join(home, ".bots"), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, ".cache"));
    fs.symlinkSync(f.dir, path.join(home, "up"));
    const account = { home, uid: process.getuid(), gid: process.getgid() };
    handOver(path.join(home, ".bots"), account, 0o750);
    assert.equal(fs.statSync(path.join(home, ".bots")).mode & 0o777, 0o750);
    assert.throws(() => handOver(path.join(home, ".cache"), account, 0o700), /link/);
    assert.equal(fs.statSync(outside).mode & 0o777, 0o777 & ~process.umask());
    assert.throws(() => handOver(path.join(home, "up", "outside"), account, 0o700), /outside the home/);
  } finally {
    f.cleanup();
  }
});

test("resetting a home keeps memories and sign-ins, and takes everything installed and every bot's work", () => {
  const f = fixture();
  try {
    const accounts = f.make();
    const ada = accounts.ensure({ id: "u-ada", name: "Ada", email: "ada@example.com", admin: false });
    const write = (relative, text = "x") => {
      const full = path.join(ada.home, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text);
    };
    const kept = [
      ".bots/b1/MEMORY.md",
      ".bots/b1/SOUL.md",
      ".bots/b1/memory/clients.md",
      ".team/u-ada/MEMORY.md",
      ".team/u-ada/memory/people.md",
      ".team/MEMORY.md",
      ".claude/.credentials.json",
      ".codex/auth.json",
      ".grok/token",
      ".config/gond-browser/Default/Cookies",
    ];
    const gone = [
      ".bots/b1/report.md",
      ".bots/b1/app/node_modules/left-pad/index.js",
      ".bots/b1/inbox/photo.jpg",
      ".bots/notes.txt",
      ".team/u-ada/plan.md",
      ".local/bin/tool",
      ".npm/_cacache/index",
      ".cache/pip/wheel",
      ".bashrc",
      ".config/xfce4/settings.xml",
      "Downloads/setup.sh",
    ];
    for (const file of [...kept, ...gone]) write(file);
    fs.symlinkSync(path.join(ada.home, ".claude"), path.join(ada.home, "claude-link"));

    const removed = accounts.refreshHome(ada);

    for (const file of kept) assert.ok(fs.existsSync(path.join(ada.home, file)), `${file} is kept`);
    for (const file of gone) assert.ok(!fs.existsSync(path.join(ada.home, file)), `${file} is gone`);
    assert.ok(!fs.existsSync(path.join(ada.home, "claude-link")));
    assert.ok(fs.existsSync(path.join(ada.home, ".claude/.credentials.json")), "a link is removed, never followed");
    assert.ok(removed.includes(".bashrc") && removed.includes(path.join(".bots", "b1", "report.md")));
    assert.equal(fs.readlinkSync(path.join(ada.home, ".skills")), path.join(f.skills, "gond-ada"));
    assert.ok(fs.statSync(path.join(ada.home, ".cache")).isDirectory(), "the home is made again");
  } finally {
    f.cleanup();
  }
});
