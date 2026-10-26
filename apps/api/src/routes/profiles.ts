import { Hono, type Context } from "hono";
import { personId, userId } from "../access.ts";
import type { Env } from "../app.ts";
import { personOf, profileOf, setActiveProfile, setProfileMuted } from "../data/profiles.ts";
import { emit } from "../events.ts";
import { createProfile, deleteProfile, editProfile, listProfiles } from "../profiles.ts";

// Another person's profile is as unknown as a missing one.
function own(c: Context<Env>, id: string) {
  const profile = profileOf(id);
  return profile && personOf(id) === personId(c) ? profile : null;
}

export function profilesRoutes() {
  const app = new Hono<Env>();

  app.get("/profiles", (c) => c.json({ profiles: listProfiles(personId(c)), active: userId(c) }));

  app.post("/profiles", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; icon?: unknown };
    if (body.icon !== undefined && body.icon !== null && typeof body.icon !== "string") return c.json({ error: "Pick one of the icons on offer" }, 400);
    const made = createProfile(personId(c), typeof body.label === "string" ? body.label : "", typeof body.icon === "string" ? body.icon : null);
    if ("error" in made) return c.json(made, 400);
    return c.json({ profile: made }, 201);
  });

  app.post("/profiles/:id/open", (c) => {
    const profile = own(c, c.req.param("id"));
    if (!profile) return c.json({ error: "Couldn't find that profile" }, 404);
    setActiveProfile(c.get("session").session.id, profile);
    // Other tabs share this session: they hear it and start over in the profile now open.
    emit({ topic: "profiles", userId: profile.personId });
    return c.json({ active: profile.id });
  });

  app.patch("/profiles/:id", async (c) => {
    const profile = own(c, c.req.param("id"));
    if (!profile) return c.json({ error: "Couldn't find that profile" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { label?: unknown; icon?: unknown; muted?: unknown };
    if (body.label !== undefined && typeof body.label !== "string") return c.json({ error: "Give the profile a name" }, 400);
    if (body.icon !== undefined && body.icon !== null && typeof body.icon !== "string") return c.json({ error: "Pick one of the icons on offer" }, 400);
    if (body.label !== undefined || body.icon !== undefined) {
      const edited = editProfile(profile.id, { label: body.label as string | undefined, icon: body.icon as string | null | undefined });
      if ("error" in edited) return c.json(edited, 400);
    }
    if (body.muted !== undefined) {
      if (typeof body.muted !== "boolean") return c.json({ error: "Turn it on or off" }, 400);
      setProfileMuted(profile.id, body.muted);
      emit({ topic: "profiles", userId: profile.personId });
    }
    return c.json({ profiles: listProfiles(personId(c)) });
  });

  app.delete("/profiles/:id", async (c) => {
    const profile = own(c, c.req.param("id"));
    if (!profile) return c.json({ error: "Couldn't find that profile" }, 404);
    if (profile.isDefault) return c.json({ error: "Your Default profile can't be deleted" }, 400);
    await deleteProfile(profile.id);
    return c.body(null, 204);
  });

  return app;
}
