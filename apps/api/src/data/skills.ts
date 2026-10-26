import { PACKAGED_SKILLS, slugify, type Skill, type SkillFile, type SkillInput } from "@gond/shared";
import { ensureDatabase, transaction } from "../db/init.ts";
import { skillsChanged } from "../events.ts";
import { newId, now } from "../ids.ts";
import { checkBundleFiles, isText, type BundleFile } from "../skill-bundle.ts";

type Row = { id: string; user_id: string | null; slug: string; name: string; description: string; instructions: string; source: Skill["source"]; meta: string; created_at: string; updated_at: string };
type FileRow = { path: string; size: number; executable: number; text: number };

function filesOf(skillId: string): SkillFile[] {
  const rows = ensureDatabase().query("SELECT path, length(data) AS size, executable, text FROM gond_skill_files WHERE skill_id = ? ORDER BY path").all(skillId) as FileRow[];
  return rows.map((row) => ({ path: row.path, size: row.size, executable: Boolean(row.executable), text: Boolean(row.text) }));
}

function toSkill(row: Row): Skill & { userId: string | null; meta: string } {
  return {
    id: row.id,
    userId: row.user_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    instructions: row.instructions,
    source: row.source,
    meta: row.meta,
    files: filesOf(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type StoredSkill = ReturnType<typeof toSkill>;

export function listSkills(userId: string): StoredSkill[] {
  const rows = ensureDatabase().query("SELECT * FROM gond_skills WHERE user_id = ? ORDER BY name COLLATE NOCASE").all(userId) as Row[];
  return rows.map(toSkill);
}

export function skillOwners(): string[] {
  return (ensureDatabase().query("SELECT DISTINCT user_id FROM gond_skills WHERE user_id IS NOT NULL").all() as { user_id: string }[]).map((r) => r.user_id);
}

export function getSkill(id: string, userId?: string): StoredSkill | null {
  const row = ensureDatabase().query("SELECT * FROM gond_skills WHERE id = ?").get(id) as Row | null;
  if (!row || (userId !== undefined && row.user_id !== userId)) return null;
  return toSkill(row);
}

export function getSkillBySlug(userId: string, slug: string): StoredSkill | null {
  const row = ensureDatabase().query("SELECT * FROM gond_skills WHERE user_id = ? AND slug = ?").get(userId, slug) as Row | null;
  return row ? toSkill(row) : null;
}

function freeSlug(userId: string, name: string, except?: string): string {
  const base = slugify(name);
  const db = ensureDatabase();
  let slug = base;
  for (let n = 2; ; n += 1) {
    const taken = db.query("SELECT id FROM gond_skills WHERE user_id = ? AND slug = ?").get(userId, slug) as { id: string } | null;
    if (!taken || taken.id === except) return slug;
    slug = `${base}-${n}`;
  }
}

export class SkillFilesError extends Error {}

function ownerOf(skillId: string): string | null {
  return (ensureDatabase().query("SELECT user_id FROM gond_skills WHERE id = ?").get(skillId) as { user_id: string | null } | null)?.user_id ?? null;
}

function writeFiles(skillId: string, files: BundleFile[], at: string) {
  const db = ensureDatabase();
  for (const file of files) {
    db.query("INSERT INTO gond_skill_files (skill_id, path, data, executable, text, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (skill_id, path) DO UPDATE SET data = excluded.data, executable = excluded.executable, text = excluded.text, updated_at = excluded.updated_at").run(skillId, file.path, file.data, file.executable ? 1 : 0, isText(file.data) ? 1 : 0, at);
  }
}

export function createSkill(userId: string, input: SkillInput, source: Skill["source"] = "written", extra: { files?: BundleFile[]; meta?: string } = {}): StoredSkill {
  const files = extra.files ?? [];
  const problem = checkBundleFiles(files);
  if (problem) throw new SkillFilesError(problem);
  const id = newId("sk");
  const at = now();
  transaction((db) => {
    db.query("INSERT INTO gond_skills (id, user_id, slug, name, description, instructions, source, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, userId, freeSlug(userId, input.name), input.name, input.description, input.instructions, source, extra.meta ?? "", at, at);
    writeFiles(id, files, at);
  });
  skillsChanged(userId);
  return getSkill(id)!;
}

export function updateSkill(id: string, patch: Partial<SkillInput> & { files?: BundleFile[]; meta?: string }): StoredSkill | null {
  const current = getSkill(id);
  if (!current || !current.userId) return null;
  if (patch.files) {
    const problem = checkBundleFiles(patch.files);
    if (problem) throw new SkillFilesError(problem);
  }
  const next = { ...current, ...patch };
  const slug = patch.name && patch.name !== current.name ? freeSlug(current.userId, patch.name, id) : current.slug;
  const at = now();
  transaction((db) => {
    db.query("UPDATE gond_skills SET slug = ?, name = ?, description = ?, instructions = ?, meta = ?, updated_at = ? WHERE id = ?").run(slug, next.name, next.description, next.instructions, next.meta, at, id);
    if (patch.files) {
      db.query("DELETE FROM gond_skill_files WHERE skill_id = ?").run(id);
      writeFiles(id, patch.files, at);
    }
  });
  skillsChanged(current.userId);
  return getSkill(id);
}

export function deleteSkill(id: string): boolean {
  const owner = getSkill(id)?.userId;
  let changed = 0;
  transaction((db) => {
    db.query("DELETE FROM gond_skill_files WHERE skill_id = ?").run(id);
    changed = db.query("DELETE FROM gond_skills WHERE id = ?").run(id).changes;
  });
  if (changed) skillsChanged(owner);
  return changed > 0;
}

export function skillFiles(skillId: string): BundleFile[] {
  const rows = ensureDatabase().query("SELECT path, data, executable FROM gond_skill_files WHERE skill_id = ? ORDER BY path").all(skillId) as { path: string; data: Uint8Array; executable: number }[];
  return rows.map((row) => ({ path: row.path, data: new Uint8Array(row.data), executable: Boolean(row.executable) }));
}

export function skillFile(skillId: string, path: string): BundleFile | null {
  const row = ensureDatabase().query("SELECT path, data, executable FROM gond_skill_files WHERE skill_id = ? AND path = ?").get(skillId, path) as { path: string; data: Uint8Array; executable: number } | null;
  return row ? { path: row.path, data: new Uint8Array(row.data), executable: Boolean(row.executable) } : null;
}

export function putSkillFile(skillId: string, file: BundleFile): void {
  const others = skillFiles(skillId).filter((f) => f.path !== file.path);
  const problem = checkBundleFiles([...others, file]);
  if (problem) throw new SkillFilesError(problem);
  const at = now();
  transaction((db) => {
    writeFiles(skillId, [file], at);
    db.query("UPDATE gond_skills SET updated_at = ? WHERE id = ?").run(at, skillId);
  });
  skillsChanged(ownerOf(skillId));
}

export function renameSkillFile(skillId: string, from: string, to: string): boolean {
  const file = skillFile(skillId, from);
  if (!file) return false;
  if (from === to) return true;
  if (skillFile(skillId, to)) throw new SkillFilesError(`"${to}" is already there.`);
  const at = now();
  transaction((db) => {
    db.query("UPDATE gond_skill_files SET path = ?, updated_at = ? WHERE skill_id = ? AND path = ?").run(to, at, skillId, from);
    db.query("UPDATE gond_skills SET updated_at = ? WHERE id = ?").run(at, skillId);
  });
  skillsChanged(ownerOf(skillId));
  return true;
}

export function deleteSkillFile(skillId: string, path: string): boolean {
  const changed = ensureDatabase().query("DELETE FROM gond_skill_files WHERE skill_id = ? AND path = ?").run(skillId, path).changes;
  if (changed) {
    ensureDatabase().query("UPDATE gond_skills SET updated_at = ? WHERE id = ?").run(now(), skillId);
    skillsChanged(ownerOf(skillId));
  }
  return changed > 0;
}

export function installPackagedSkill(userId: string, packagedId: string): StoredSkill | null {
  const packaged = PACKAGED_SKILLS.find((s) => s.id === packagedId);
  if (!packaged) return null;
  const existing = getSkillBySlug(userId, packaged.id);
  if (existing) return existing;
  return createSkill(userId, { name: packaged.name, description: packaged.description, instructions: packaged.instructions }, "packaged");
}
