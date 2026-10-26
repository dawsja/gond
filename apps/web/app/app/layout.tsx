import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Reconnecting, SignInAgain } from "@/components/reconnecting";
import { Shell } from "@/components/shell";
import { apiFetch, getSessionUser } from "@/lib/session";

export const metadata: Metadata = { title: "Bots", description: "Message your bots like teammates." };

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const session = await getSessionUser();
  if ("down" in session) return <Reconnecting />;
  // A layout can't see which page it wraps, so the page itself sends the person to sign in and back.
  if ("signedOut" in session) return <SignInAgain />;
  const { user } = session;
  const settings = await apiFetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { settings?: { onboarding: { done: boolean } } } | null) => d?.settings ?? null)
    .catch(() => null);
  if (user.role === "admin" && settings && !settings.onboarding.done) redirect("/onboarding");
  return <Shell user={user}>{children}</Shell>;
}
