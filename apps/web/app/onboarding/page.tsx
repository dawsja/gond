import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Reconnecting } from "@/components/reconnecting";
import { apiFetch, getSessionUser, loginHref } from "@/lib/session";
import { Onboarding } from "./onboarding";

export default async function OnboardingPage() {
  await connection();
  const session = await getSessionUser();
  if ("down" in session) return <Reconnecting />;
  if ("signedOut" in session) redirect(loginHref("/onboarding"));
  if (session.user.role !== "admin") redirect("/app");
  const settings = await apiFetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { settings?: { onboarding: { done: boolean } } } | null) => d?.settings ?? null)
    .catch(() => null);
  if (settings?.onboarding.done) redirect("/app");
  return <Onboarding />;
}
