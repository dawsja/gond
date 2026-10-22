import { PACKAGED_SKILLS, SKILL_LIMITS, skillFilePath, skillInputSchema, skillPatchSchema, slugify } from "@gond/shared";
import { Hono, type Context } from "hono";
import { userId } from "../access.ts";
import type { Env } from "../app.ts";
import { createSkill, deleteSkill, deleteSkillFile, getSkill, installPackagedSkill, listSkills, putSkillFile, renameSkillFile, SkillFilesError, skillFile, skillFiles, updateSkill } from "../data/skills.ts";
import { isText, looksExecutable, nameFromFolder, packSkill, parseSkillMd, unpackSkill } from "../skill-bundle.ts";
import { syncSkills } from "../skills.ts";

const MAX_UPLOAD_BYTES = SKILL_LIMITS.totalBytes + 5 * 1024 * 1024;

function failure(c: Context<Env>, error: unknown) {
  if (error instanceof SkillFilesError) return c.json({ error: error.message }, 400);
  throw error;
}

export function skillsRoutes() {
  const app = new Hono<Env>();

  const own = (c: Context<Env>) => getSkill(c.req.param("id") ?? "", userId(c));
  const changed = (c: Context<Env>) => void syncSkills(userId(c));

  app.get("/skills", (c) => {
    const skills = listSkills(userId(c));
    const installed = new Set(skills.map((s) => s.slug));
    return c.json({ skills, packaged: PACKAGED_SKILLS.map((p) => ({ id: p.id, name: p.name, description: p.description, installed: installed.has(p.id) })) });
  });

  app.post("/skills", async (c) => {
    const parsed = skillInputSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "That skill isn't valid" }, 400);
    const skill = createSkill(userId(c), parsed.data);
    changed(c);
    return c.json({ skill }, 201);
  });

  app.post("/skills/install", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: string };
    const skill = installPackagedSkill(userId(c), String(body.id ?? ""));
    if (!skill) return c.json({ error: "Couldn't find that built-in skill" }, 404);
    changed(c);
    return c.json({ skill }, 201);
  });

  app.post("/skills/import", async (c) => {
    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return c.json({ error: "Send the skill as a file" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: `A skill must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    let skillMd: string;
    let folder: string | null;
    let files: { path: string; data: Uint8Array; executable: boolean }[] = [];
    if (/\.md$/i.test(file.name)) {
      if (!isText(bytes)) return c.json({ error: "That file isn't readable text" }, 400);
      skillMd = new TextDecoder().decode(bytes);
      folder = null;
    } else {
      const unpacked = unpackSkill(bytes);
      if ("error" in unpacked) return c.json({ error: unpacked.error }, 400);
      ({ skillMd, folder, files } = unpacked);
    }
    const parsed = parseSkillMd(skillMd);
    const input = skillInputSchema.safeParse({ name: (parsed.name ?? nameFromFolder(folder ?? file.name.replace(/\.[^.]+$/, ""))).slice(0, SKILL_LIMITS.name), description: parsed.description.slice(0, SKILL_LIMITS.description), instructions: parsed.instructions });
    if (!input.success) return c.json({ error: input.error.issues[0]?.path[0] === "instructions" ? "SKILL.md has no instructions" : (input.error.issues[0]?.message ?? "That skill isn't valid") }, 400);
    try {
      const skill = createSkill(userId(c), input.data, "imported", { files, meta: parsed.meta });
      changed(c);
      return c.json({ skill }, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.patch("/skills/:id", async (c) => {
    if (!own(c)) return c.json({ error: "Couldn't find that skill" }, 404);
    const parsed = skillPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "That skill isn't valid" }, 400);
    const skill = updateSkill(c.req.param("id"), parsed.data);
    if (!skill) return c.json({ error: "Couldn't find that skill" }, 404);
    changed(c);
    return c.json({ skill });
  });

  app.delete("/skills/:id", (c) => {
    const skill = own(c);
    if (!skill) return c.json({ error: "Couldn't find that skill" }, 404);
    deleteSkill(skill.id);
    changed(c);
    return c.body(null, 204);
  });

  app.get("/skills/:id/download", (c) => {
    const skill = own(c);
    if (!skill) return c.json({ error: "Couldn't find that skill" }, 404);
    const zip = packSkill(skill, skillFiles(skill.id));
    return new Response(Buffer.from(zip), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${slugify(skill.slug)}.skill"`,
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.get("/skills/:id/file", (c) => {
    const skill = own(c);
    const path = skillFilePath(c.req.query("path") ?? "");
    const file = skill && path ? skillFile(skill.id, path) : null;
    if (!file) return c.json({ error: "Couldn't find that file" }, 404);
    if (c.req.query("raw") === undefined && isText(file.data)) return c.json({ path: file.path, content: new TextDecoder().decode(file.data), executable: file.executable });
    const name = file.path.split("/").pop() ?? "file";
    return new Response(Buffer.from(file.data), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Content-Security-Policy": "sandbox",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

  app.put("/skills/:id/file", async (c) => {
    const skill = own(c);
    if (!skill) return c.json({ error: "Couldn't find that skill" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; content?: unknown; executable?: unknown };
    const path = skillFilePath(String(body.path ?? ""));
    if (!path) return c.json({ error: "Give the file a path inside the skill, like scripts/run.py" }, 400);
    if (typeof body.content !== "string") return c.json({ error: "The file's content must be text" }, 400);
    const data = new TextEncoder().encode(body.content);
    try {
      putSkillFile(skill.id, { path, data, executable: typeof body.executable === "boolean" ? body.executable : looksExecutable(data) });
    } catch (error) {
      return failure(c, error);
    }
    changed(c);
    return c.json({ skill: getSkill(skill.id) });
  });

  app.post("/skills/:id/files", async (c) => {
    const skill = own(c);
    if (!skill) return c.json({ error: "Couldn't find that skill" }, 404);
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: "Send the files as a form" }, 400);
    const dir = String(form.get("dir") ?? "").trim().replace(/^\/+|\/+$/g, "");
    const uploads = form.getAll("file").filter((f): f is File => f instanceof File);
    if (!uploads.length) return c.json({ error: "Add at least one file" }, 400);
    try {
      for (const upload of uploads) {
        if (upload.size > SKILL_LIMITS.fileBytes) throw new SkillFilesError(`"${upload.name}" is larger than ${SKILL_LIMITS.fileBytes / 1024 / 1024} MB.`);
        const path = skillFilePath(dir ? `${dir}/${upload.name}` : upload.name);
        if (!path) throw new SkillFilesError(`"${upload.name}" can't go there.`);
        const data = new Uint8Array(await upload.arrayBuffer());
        putSkillFile(skill.id, { path, data, executable: looksExecutable(data) });
      }
    } catch (error) {
      changed(c);
      return failure(c, error);
    }
    changed(c);
    return c.json({ skill: getSkill(skill.id) });
  });

  app.patch("/skills/:id/file", async (c) => {
    const skill = own(c);
    if (!skill) return c.json({ error: "Couldn't find that skill" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { path?: unknown; to?: unknown; executable?: unknown };
    const from = skillFilePath(String(body.path ?? ""));
    const current = from ? skillFile(skill.id, from) : null;
    if (!from || !current) return c.json({ error: "Couldn't find that file" }, 404);
    try {
      if (typeof body.executable === "boolean") putSkillFile(skill.id, { ...current, executable: body.executable });
      if (body.to !== undefined) {
        const to = skillFilePath(String(body.to));
        if (!to) return c.json({ error: "That path can't be used inside a skill" }, 400);
        renameSkillFile(skill.id, from, to);
      }
    } catch (error) {
      return failure(c, error);
    }
    changed(c);
    return c.json({ skill: getSkill(skill.id) });
  });

  app.delete("/skills/:id/file", (c) => {
    const skill = own(c);
    const path = skillFilePath(c.req.query("path") ?? "");
    if (!skill || !path || !deleteSkillFile(skill.id, path)) return c.json({ error: "Couldn't find that file" }, 404);
    changed(c);
    return c.json({ skill: getSkill(skill.id) });
  });

  return app;
}
