import { oidcPatchSchema, type AuthConfig } from "@gond/shared";
import { Hono } from "hono";
import { personId } from "../access.ts";
import type { Env } from "../app.ts";
import { getAuth, invalidateAuth, oidcCallbackUrl, oidcLogoutUrl } from "../auth.ts";
import { clearOidcSecret, getOidcSettings, oidcReady, updateOidcSettings } from "../data/oidc.ts";
import { isExtraProfile } from "../data/profiles.ts";
import { getUser, listUsers } from "../data/users.ts";
import { removePerson } from "../profiles.ts";

export function authConfig(local: boolean): AuthConfig {
  const oidc = getOidcSettings();
  return { local, oidc: oidcReady() ? { enabled: true, name: oidc.name } : null };
}

export function usersRoutes() {
  const app = new Hono<Env>();

  app.get("/oidc", (c) => c.json({ oidc: getOidcSettings(), callbackUrl: oidcCallbackUrl(), logoutUrl: oidcLogoutUrl() }));

  app.patch("/oidc", async (c) => {
    const parsed = oidcPatchSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "Bad settings" }, 400);
    if (parsed.data.issuer && !/^https?:\/\//.test(parsed.data.issuer)) return c.json({ error: "The issuer is an https:// address" }, 400);
    const oidc = updateOidcSettings(parsed.data);
    if (oidc.enabled && (!oidc.issuer || !oidc.clientId || !oidc.hasClientSecret)) {
      updateOidcSettings({ enabled: false });
      return c.json({ error: "To turn it on, give the issuer, the client id and the client secret" }, 400);
    }

    invalidateAuth();
    return c.json({ oidc: getOidcSettings(), callbackUrl: oidcCallbackUrl(), logoutUrl: oidcLogoutUrl() });
  });

  app.delete("/oidc/secret", (c) => {
    const oidc = clearOidcSecret();
    invalidateAuth();
    return c.json({ oidc, callbackUrl: oidcCallbackUrl(), logoutUrl: oidcLogoutUrl() });
  });

  app.get("/users", (c) => c.json({ users: listUsers() }));

  app.delete("/users/:id", async (c) => {
    const id = c.req.param("id");
    if (id === personId(c)) return c.json({ error: "You can't remove yourself" }, 400);
    const user = isExtraProfile(id) ? null : getUser(id);
    if (!user) return c.json({ error: "Couldn't find that person" }, 404);
    if (user.role === "admin") return c.json({ error: "The admin can't be removed" }, 400);
    await removePerson(id);
    const auth = await getAuth();
    await auth.api.removeUser({ body: { userId: id }, headers: c.req.raw.headers });
    return c.body(null, 204);
  });

  return app;
}
