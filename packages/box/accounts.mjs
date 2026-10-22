import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const FIRST_UID = 2001;

export const NAME_PREFIX = "gond-";
export const LEGACY_NAME_PREFIX = "kru-";

const MAX_NAME = 32;
export const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function accountName(person, taken = new Set()) {
  const source = [person?.name, String(person?.email ?? "").split("@")[0], person?.id].find((value) => typeof value === "string" && /[a-z0-9]/i.test(value)) ?? "person";
  let slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME - NAME_PREFIX.length - 3)
    .replace(/-+$/g, "");
  if (!/^[a-z]/.test(slug)) slug = `p${slug}`;
  const base = `${NAME_PREFIX}${slug}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function nextUid(used) {
  let uid = FIRST_UID;
  while (used.has(uid)) uid += 1;
  return uid;
}

export function nextSlot(used) {
  let slot = 1;
  while (used.has(slot)) slot += 1;
  return slot;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function linuxUserExists(name) {
  return run("id", ["-u", name]).ok;
}

export class Accounts {
  constructor({ stateDir, homesDir, root, skillsRoot = null, agent, log = () => undefined }) {
    this.file = path.join(stateDir, "accounts.json");

    this.loginsDir = path.join(stateDir, "logins");
    this.homesDir = homesDir;
    this.root = root;
    this.skillsRoot = skillsRoot;
    this.agent = agent;
    this.log = log;

    this.records = new Map();
    this.load();
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [id, record] of Object.entries(data?.accounts ?? {})) {
        if (!USER_ID.test(id) || !record || typeof record.name !== "string") continue;
        this.records.set(id, { name: record.name, uid: Number(record.uid) || this.agent.uid, slot: Number(record.slot) || 0, admin: Boolean(record.admin) });
      }
    } catch {
      /* no registry yet */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const accounts = Object.fromEntries([...this.records].map(([id, record]) => [id, record]));
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  describe(id, record) {
    if (record.admin) {
      const home = this.agent.home;
      const dirs = this.agent.dirs ?? {};
      return this.withDirs({ id, name: this.agent.name, uid: this.agent.uid, gid: this.agent.gid, home, slot: 0, admin: true }, dirs);
    }
    const home = path.join(this.homesDir, record.name);

    const ids = this.root ? { uid: record.uid, gid: record.uid } : { uid: undefined, gid: undefined };
    return this.withDirs({ id, name: record.name, home, slot: record.slot, admin: false, ...ids }, {});
  }

  withDirs(account, dirs) {
    const home = account.home;
    account.bots = dirs.bots ?? path.join(home, ".bots");
    account.team = dirs.team ?? path.join(home, ".team");
    account.skills = dirs.skills ?? path.join(home, ".skills");

    account.library = this.skillsRoot ? path.join(this.skillsRoot, account.name) : null;
    account.cache = dirs.cache ?? path.join(home, ".cache");
    account.claude = dirs.claude ?? path.join(home, ".claude");
    account.run = dirs.run ?? path.join(home, ".run");
    account.browser = dirs.browser ?? path.join(home, ".config", "gond-browser");

    account.logins = [account.claude];
    return account;
  }

  get(id) {
    const record = this.records.get(id);
    return record ? this.describe(id, record) : null;
  }

  list() {
    return [...this.records.keys()].map((id) => this.get(id));
  }

  agentAccount() {
    return this.describe(null, { name: this.agent.name, uid: this.agent.uid, slot: 0, admin: true });
  }

  admin() {
    for (const [id, record] of this.records) if (record.admin) return this.describe(id, record);
    return null;
  }

  ensure(person) {
    if (!person || !USER_ID.test(person.id ?? "")) throw new Error("Bad user id");
    const existing = this.records.get(person.id);
    if (existing) {
      if (existing.admin !== Boolean(person.admin)) throw new Error("That account's role changed; the box can't move a home between users");
      const account = this.describe(person.id, existing);
      this.materialize(account);
      this.restoreLogins(account);
      return account;
    }
    if (person.admin) {
      for (const record of this.records.values()) if (record.admin) throw new Error("The box already has an admin account");
      this.records.set(person.id, { name: this.agent.name, uid: this.agent.uid, slot: 0, admin: true });
    } else {
      const names = new Set([this.agent.name, ...[...this.records.values()].map((r) => r.name)]);
      const uids = new Set([this.agent.uid, ...[...this.records.values()].map((r) => r.uid)]);
      const slots = new Set([...this.records.values()].map((r) => r.slot));
      this.records.set(person.id, { name: accountName(person, names), uid: nextUid(uids), slot: nextSlot(slots), admin: false });
    }
    this.save();
    const account = this.describe(person.id, this.records.get(person.id));
    this.materialize(account);

    this.restoreLogins(account);
    this.log(`account ${account.name} (uid ${account.uid ?? "-"}) for ${person.id}`);
    return account;
  }

  materialize(account) {
    if (!account.admin) fs.mkdirSync(this.homesDir, { recursive: true, mode: 0o755 });
    if (!account.admin && this.root) {
      if (!linuxUserExists(account.name)) {
        const group = run("groupadd", ["--gid", String(account.gid), account.name]);
        if (!group.ok && !/already exists/.test(group.output)) throw new Error(`groupadd failed: ${group.output.slice(0, 200)}`);
        const flag = fs.existsSync(account.home) ? "-M" : "-m";
        const user = run("useradd", [flag, "--uid", String(account.uid), "--gid", String(account.gid), "--home-dir", account.home, "--shell", "/bin/bash", account.name]);
        if (!user.ok && !/already exists/.test(user.output)) throw new Error(`useradd failed: ${user.output.slice(0, 200)}`);
      }
    }
    this.own(account.home, account, 0o700);
    for (const dir of [account.bots, account.team, account.cache, account.run]) this.own(dir, account);
    this.linkSkills(account);
  }

  linkSkills(account) {
    if (!account.library) return;
    this.makeLibrary(account);
    let stat = null;
    try {
      stat = fs.lstatSync(account.skills);
    } catch {
      /* nothing there */
    }
    if (stat?.isSymbolicLink()) {
      if (fs.readlinkSync(account.skills) === account.library) return;
      fs.unlinkSync(account.skills);
    } else if (stat?.isDirectory()) {
      // Never copied into the library: anyone can make this folder. The API writes the real skills back.
      fs.rmSync(account.skills, { recursive: true, force: true });
    } else if (stat) {
      fs.rmSync(account.skills, { force: true });
    }
    fs.symlinkSync(account.library, account.skills);
  }

  makeLibrary(account) {
    fs.mkdirSync(this.skillsRoot, { recursive: true, mode: 0o755 });
    fs.mkdirSync(account.library, { recursive: true, mode: 0o750 });
    if (this.root && account.gid !== undefined) {
      fs.chownSync(account.library, 0, account.gid);
      fs.chmodSync(account.library, 0o750);
    }
    return account.library;
  }

  clearLegacySkills() {
    if (!this.skillsRoot) return;
    let entries = [];
    try {
      entries = fs.readdirSync(this.skillsRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      const dir = path.join(this.skillsRoot, entry);
      if (fs.existsSync(path.join(dir, "SKILL.md"))) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  own(dir, account, mode = 0o755) {
    fs.mkdirSync(dir, { recursive: true, mode });
    if (account.uid === undefined) return;
    try {
      handOver(dir, account, mode);
    } catch (error) {
      this.log(`could not own ${dir}: ${error.message}`);
    }
  }

  adoptLegacyNames() {
    let changed = false;
    for (const [id, record] of this.records) {
      if (record.admin || !record.name.startsWith(LEGACY_NAME_PREFIX)) continue;
      const old = record.name;
      const taken = new Set([this.agent.name, ...[...this.records.values()].map((r) => r.name)]);
      const name = accountName({ name: old.slice(LEGACY_NAME_PREFIX.length) }, taken);
      const oldHome = path.join(this.homesDir, old);
      const home = path.join(this.homesDir, name);
      try {
        if (this.root && linuxUserExists(old)) {
          const user = run("usermod", ["-l", name, old]);
          if (!user.ok) throw new Error(`usermod failed: ${user.output.slice(0, 200)}`);
          const group = run("groupmod", ["-n", name, old]);
          if (!group.ok) this.log(`groupmod ${old}: ${group.output.slice(0, 200)}`);
          const move = fs.existsSync(oldHome) && !fs.existsSync(home) ? ["-d", home, "-m", name] : ["-d", home, name];
          const moved = run("usermod", move);
          if (!moved.ok) throw new Error(`usermod failed: ${moved.output.slice(0, 200)}`);
        } else if (fs.existsSync(oldHome) && !fs.existsSync(home)) {
          fs.renameSync(oldHome, home);
        }
      } catch (error) {
        this.log(`could not rename ${old}: ${error.message}`);
        continue;
      }
      if (this.skillsRoot) fs.rmSync(path.join(this.skillsRoot, old), { recursive: true, force: true });
      record.name = name;
      changed = true;
      this.log(`account ${old} is now ${name} for ${id}`);
    }
    if (changed) this.save();
  }

  restore() {
    for (const account of this.list()) {
      try {
        this.materialize(account);
      } catch (error) {
        this.log(`could not restore ${account.name}: ${error.message}`);
      }
    }
  }

  remove(id, { keepLogins = false } = {}) {
    if (!keepLogins) fs.rmSync(this.stashDir(id), { recursive: true, force: true });
    const record = this.records.get(id);
    if (!record) return false;
    if (record.admin) throw new Error("The admin's account can't be removed");
    const account = this.describe(id, record);
    if (keepLogins) this.stashLogins(account);
    this.records.delete(id);
    this.save();
    if (this.root && linuxUserExists(account.name)) {
      const result = run("userdel", ["--remove", account.name]);
      if (!result.ok) this.log(`userdel ${account.name}: ${result.output.slice(0, 200)}`);
      run("groupdel", [account.name]);
    }
    fs.rmSync(account.home, { recursive: true, force: true });
    if (account.library) fs.rmSync(account.library, { recursive: true, force: true });
    this.log(`removed account ${account.name} for ${id}`);
    return true;
  }

  reset({ keepLogins = true } = {}) {
    const people = [];
    for (const [id, record] of [...this.records]) {
      if (record.admin) continue;
      const name = this.records.get(id)?.name ?? id;
      this.remove(id, { keepLogins });
      people.push(name);
    }
    const admin = this.admin() ?? this.agentAccount();
    const removed = this.wipeHome(admin, { keepLogins });
    this.clearSkills();
    this.materialize(admin);
    return { removed, accounts: people };
  }

  wipeHome(account, { keepLogins = true } = {}) {
    const keep = new Set(keepLogins ? account.logins.map((dir) => path.resolve(dir)) : []);
    const removed = [];
    let entries = [];
    try {
      entries = fs.readdirSync(account.home);
    } catch {
      return removed;
    }
    for (const entry of entries) {
      const full = path.join(account.home, entry);
      if (keep.has(path.resolve(full))) continue;
      try {
        fs.rmSync(full, { recursive: true, force: true });
      } catch {
        for (const inner of fs.readdirSync(full)) fs.rmSync(path.join(full, inner), { recursive: true, force: true });
      }
      removed.push(entry);
    }
    return removed;
  }

  /**
   * A person's computer as it was built, but for what is theirs to keep: every
   * memory, the CLIs' sign-ins and the browser profile. Whatever they or their
   * bots installed, configured or left lying around goes, processes included.
   */
  refreshHome(account) {
    if (this.root && account.uid !== undefined && account.uid !== 0) run("pkill", ["-KILL", "-u", String(account.uid)]);
    const removed = clearHome(account.home, homeKeeps(account));
    this.materialize(account);
    return removed;
  }

  clearSkills() {
    if (!this.skillsRoot) return;
    try {
      for (const entry of fs.readdirSync(this.skillsRoot)) fs.rmSync(path.join(this.skillsRoot, entry), { recursive: true, force: true });
    } catch {
      /* no mirror yet */
    }
  }

  stashDir(id) {
    return path.join(this.loginsDir, encodeURIComponent(id));
  }

  stashLogins(account) {
    if (!account.id) return;
    const target = this.stashDir(account.id);
    fs.rmSync(target, { recursive: true, force: true });
    let any = false;
    for (const [engine, dir] of Object.entries(this.loginDirs(account))) {
      if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) continue;
      if (!any) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      moveInto(dir, path.join(target, engine));
      any = true;
    }
    if (any) this.log(`kept the sign-ins of ${account.name}`);
  }

  restoreLogins(account) {
    if (!account.id) return;
    const stash = this.stashDir(account.id);
    if (!fs.existsSync(stash)) return;
    for (const [engine, dir] of Object.entries(this.loginDirs(account))) {
      const kept = path.join(stash, engine);
      if (!fs.existsSync(kept)) continue;
      if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      moveInto(kept, dir);
      this.chownTree(dir, account);
    }
    fs.rmSync(stash, { recursive: true, force: true });
    this.log(`gave ${account.name} its sign-ins back`);
  }

  loginDirs(account) {
    return { claude: account.claude };
  }

  chownTree(dir, account) {
    if (account.uid === undefined) return;
    const walk = (current) => {
      try {
        fs.lchownSync(current, account.uid, account.gid);
      } catch (error) {
        this.log(`could not own ${current}: ${error.message}`);
        return;
      }
      let entries = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(full);
        else {
          try {
            fs.lchownSync(full, account.uid, account.gid);
          } catch {
            /* a file that went while we walked */
          }
        }
      }
    };
    walk(dir);
  }
}

const BOT_KEEPS = new Set(["MEMORY.md", "SOUL.md", "memory"]);

/** What `refreshHome` does with each path in a home: keep it, look inside it, or remove it. */
export function homeKeeps(account) {
  const exact = [account.claude, account.browser, account.skills].map((dir) => path.resolve(dir));
  const bots = path.resolve(account.bots);
  const team = path.resolve(account.team);
  return (full, isDir) => {
    const target = path.resolve(full);
    if (exact.includes(target)) return "keep";
    if (exact.some((kept) => kept.startsWith(target + path.sep))) return "descend";
    if (target === bots || target === team) return "descend";
    const name = path.basename(target);
    if (path.dirname(target) === bots) return isDir ? "descend" : "remove";
    if (path.dirname(path.dirname(target)) === bots) return BOT_KEEPS.has(name) ? "keep" : "remove";
    if (target.startsWith(team + path.sep)) {
      if (name === "MEMORY.md" || (isDir && name === "memory")) return "keep";
      return isDir ? "descend" : "remove";
    }
    return "remove";
  };
}

/** Removes everything under `dir` that `decide` doesn't keep; links are never followed. Answers what went, relative to `dir`. */
export function clearHome(dir, decide, root = dir) {
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const verdict = decide(full, entry.isDirectory());
    if (verdict === "keep") continue;
    if (verdict === "descend" && entry.isDirectory()) {
      removed.push(...clearHome(full, decide, root));
      continue;
    }
    try {
      fs.rmSync(full, { recursive: true, force: true });
    } catch {
      // A mount point (the admin's volumes) can't go itself; what is in it can.
      removed.push(...clearHome(full, () => "remove", root));
      continue;
    }
    removed.push(path.relative(root, full));
  }
  return removed;
}

export function handOver(target, account, mode = null) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  let fd;
  try {
    fd = fs.openSync(target, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (error.code === "ELOOP") throw new Error(`${target} is a link; left alone`);
    throw error;
  }
  try {
    const opened = openedPath(fd, target);
    const home = fs.realpathSync(account.home);
    if (opened !== home && !opened.startsWith(home + path.sep)) throw new Error(`${target} leads outside the home; left alone`);
    fs.fchownSync(fd, account.uid, account.gid);
    if (mode !== null) fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

export function openedPath(fd, fallback) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return fs.realpathSync(fallback);
  }
}

function moveInto(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
    return;
  } catch {
    fs.cpSync(from, to, { recursive: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}
