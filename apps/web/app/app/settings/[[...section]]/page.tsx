import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Reconnecting } from "@/components/reconnecting";
import { SettingsPage } from "@/components/settings-page";
import { canOpenSection, isSettingsSection } from "@/lib/settings-sections";
import { getSessionUser, loginHref } from "@/lib/session";

export const metadata: Metadata = { title: "Settings" };

export default async function Settings({ params }: { params: Promise<{ section?: string[] }> }) {
  const { section: parts = [] } = await params;
  const section = parts[0] ?? "account";
  if (parts.length > 1 || !isSettingsSection(section)) notFound();
  const session = await getSessionUser();
  if ("down" in session) return <Reconnecting />;
  if ("signedOut" in session) redirect(loginHref(`/app/settings${parts.length ? `/${parts[0]}` : ""}`));

  if (!canOpenSection(session.user.role, section)) notFound();
  return <SettingsPage user={session.user} section={section} index={parts.length === 0} />;
}
