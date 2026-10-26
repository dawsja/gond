"use client";

import type { AiSettings, BoxStatus } from "@gond/shared";
import { ChevronLeft, ChevronRight, LogOut } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AboutCard } from "@/components/about-card";
import { ServerUpdateCard } from "@/components/server-update-card";
import { AccountSection } from "@/components/account-section";
import { ExportCard } from "@/components/export-card";
import { AppearanceCard } from "@/components/appearance-card";
import { PersonalizationCard } from "@/components/personalization-card";
import { ProfilesCard } from "@/components/profiles";
import { AppsCard } from "@/components/apps-card";
import { ComposioCard } from "@/components/composio-card";
import { ComputerCard } from "@/components/computer-card";
import { AiSteps } from "@/components/ai-steps";
import { HomeResetCard } from "@/components/home-reset-card";
import { McpCard } from "@/components/mcp-card";
import { NotificationsSection } from "@/components/notifications-section";
import { OidcCard } from "@/components/oidc-card";
import { UsageSection } from "@/components/usage-section";
import { VoiceCard } from "@/components/voice-card";
import { CallVoiceCard } from "@/components/call-voice-card";
import { SecretsCard } from "@/components/secrets-card";
import { OtherGondsSection, SpaceDefaultsCard } from "@/components/spaces/spaces-settings";
import { ServerCard } from "@/components/server-card";
import { SkillsCard } from "@/components/skills-card";
import { UsersCard } from "@/components/users-card";
import { useLiveEvents } from "@/components/hq/live-events";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { useCovered } from "@/components/conversation-chrome";
import { useNativeChrome, useNativeUi } from "@/lib/native-ui";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { PersonAvatar } from "@/components/bot-avatar";
import { useSignOut } from "@/components/profile-menu";
import { LoadFailed } from "@/components/load-failed";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { api } from "@/lib/api";
import type { SessionUser } from "@/lib/session";
import { SETTINGS_SECTIONS, groupedSections, settingsHref, type SettingsSection } from "@/lib/settings-sections";
import { cn } from "@/lib/utils";

export function SettingsPage({ user, section, index = false }: { user: SessionUser; section: SettingsSection; index?: boolean }) {
  const { me, admin } = useStore();
  const params = useSearchParams();
  const [status, setStatus] = useState<BoxStatus | null>(null);
  const [ai, setAi] = useState<AiSettings | null>(null);

  const [appsRefresh, setAppsRefresh] = useState(0);
  const current = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];
  const signOut = useSignOut();

  const back = index ? "/app" : "/app/settings";
  useSwipeBack(back);
  // In the iPhone app the back button is the app's own, in Liquid Glass, and stays put while the page scrolls under it.
  const native = useNativeUi();

  const activeLink = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    activeLink.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current.id]);

  const [aiFailed, setAiFailed] = useState(false);
  const load = useCallback(async (fresh = false) => {
    const [a, st] = await Promise.all([
      api<{ ai: AiSettings }>("/api/ai").catch(() => null),
      api<{ status: BoxStatus }>(`/api/status${fresh ? "?fresh=1" : ""}`).catch(() => null),
    ]);
    setAiFailed(!a);
    if (a) setAi(a.ai);
    if (st) setStatus(st.status);
  }, []);

  useEffect(() => {
    const connected = params.get("connected");
    const mcp = params.get("mcp");
    const mcpError = params.get("mcp_error");
    const chatgptError = params.get("chatgpt_error");
    void Promise.resolve().then(() => {
      if (mcp) toast.add({ type: "success", title: `Signed in to ${mcp}.`, description: "Its tools work for every bot from their next reply." });
      if (mcpError) toast.add({ type: "error", title: "The sign-in to that tool server didn't finish.", description: "Try signing in again from its row under MCP servers." });
      if (chatgptError) toast.add({ type: "error", title: "The ChatGPT sign-in didn't finish.", description: "Try Continue with ChatGPT again." });
      return load(Boolean(connected));
    });
  }, [load, params]);
  useLiveEvents((event) => {
    if (event.topic === "settings" || event.topic === "ai") void load();

    if (event.topic === "box") void load();
  });

  const list = (
    <nav aria-label="Settings sections" className="flex flex-col gap-1">
      <Link href={settingsHref("account")} className="mb-2 flex items-center gap-3 rounded-2xl bg-card px-3 py-3 shadow-subtle outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <PersonAvatar name={me.name} avatar={me.avatar} size={44} />
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">{me.name}</span>
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
      </Link>
      {groupedSections(me.role, "account").map((group) => (
        <div key={group.id ?? "rest"} className="flex flex-col gap-1 pt-3 first-of-type:pt-0">
          {group.label ? <h2 className="px-3 pb-1 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">{group.label}</h2> : null}
          {group.sections.map((s) => {
            const Icon = s.icon;
            return (
              <Link key={s.id} href={settingsHref(s.id)} className="flex min-h-14 items-start gap-3 rounded-xl px-3 py-2 outline-none hover:bg-card/60 focus-visible:ring-3 focus-visible:ring-ring/50">
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-foreground">
                  <Icon className="size-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium">{s.label}</span>
                  <span className="line-clamp-2 block text-[12.5px] text-muted-foreground">{s.blurb}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 self-center text-muted-foreground" aria-hidden="true" />
              </Link>
            );
          })}
        </div>
      ))}

      <button type="button" onClick={() => void signOut()} className="mt-4 flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 text-left outline-none hover:bg-card/60 focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
          <LogOut className="size-4" aria-hidden="true" />
        </span>
        <span className="block text-[15px] font-medium">Sign out</span>
      </button>
    </nav>
  );

  const nav = (
    <nav aria-label="Settings sections" className="flex flex-col gap-1">
      {groupedSections(me.role).map((group) => (
        <div key={group.id ?? "rest"} className="flex flex-col gap-1 pt-4 first-of-type:pt-0">
          {group.label ? <h2 className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group.label}</h2> : null}
          {group.sections.map((s) => {
            const active = s.id === current.id;
            const Icon = s.icon;
            return (
              <Link
                key={s.id}
                ref={active ? activeLink : undefined}
                href={settingsHref(s.id)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-2.5 rounded-xl px-3 text-[13.5px] font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
                  active ? "bg-card text-foreground shadow-subtle" : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {s.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  let body: React.ReactNode;
  switch (current.id) {
    case "account":
      body = (
        <>
          <AccountSection user={user} />
          <ExportCard />
        </>
      );
      break;
    case "profiles":
      body = <ProfilesCard />;
      break;
    case "notifications":
      body = <NotificationsSection />;
      break;
    case "appearance":
      body = <AppearanceCard />;
      break;
    case "personalization":
      body = <PersonalizationCard />;
      break;
    case "shared-computer":
      body = <ComputerCard status={status} admin={admin} onCheck={() => load(true)} />;
      break;
    case "ai":
      body = (
        ai ? <AiSteps ai={ai} status={status} onChange={setAi} onRefresh={() => load(true)} /> : aiFailed ? <LoadFailed what="your AI settings" onRetry={() => void load()} /> : <Skeleton className="h-96 rounded-xl" />
      );
      break;
    case "usage":
      body = <UsageSection />;
      break;
    case "voice":
      body = (
        <>
          <VoiceCard />
          <CallVoiceCard />
        </>
      );
      break;
    case "computer":
      body = <HomeResetCard />;
      break;
    case "skills":
      body = <SkillsCard />;
      break;
    case "apps":
      body = (
        <>
          <ComposioCard onChange={() => setAppsRefresh((n) => n + 1)} />
          <AppsCard refresh={appsRefresh} />
          <McpCard />
        </>
      );
      break;
    case "secrets":
      body = <SecretsCard />;
      break;
    case "spaces":
      body = <SpaceDefaultsCard />;
      break;
    case "other-gonds":
      body = <OtherGondsSection />;
      break;
    case "about":
      body = (
        <>
          <ServerUpdateCard />
          <ServerCard />
          <AboutCard />
        </>
      );
      break;
    case "auth":
      body = (
        <>
          <OidcCard />
          <UsersCard />
        </>
      );
      break;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 pt-[calc(max(16px,var(--safe-top))+var(--call-pill-space)*2)] pb-[calc(32px+var(--safe-bottom))] wide:px-6 wide:py-8">

        <div className="flex h-11 items-center gap-3 wide:hidden">
          <Button size="icon-xl" aria-label={index ? "Back to chats" : "All settings"} render={<Link href={back} />} nativeButton={false} className={cn(native && "invisible")}>
            <ChevronLeft aria-hidden="true" />
          </Button>
          {native ? <SettingsChrome back={back} label={index ? "Back to chats" : "All settings"} /> : null}
          <h1 className="text-[22px] font-semibold tracking-[-0.4px]">{index ? "Settings" : current.label}</h1>
        </div>
        {index ? <div className="wide:hidden">{list}</div> : null}
        <div className={cn("flex flex-col gap-5 wide:flex-row wide:items-start wide:gap-8", index && "hidden wide:flex")}>
          {/* The title and the sections stay put while a section scrolls; the section starts level with the first of them. */}
          <div className="hidden wide:sticky wide:top-8 wide:flex wide:w-44 wide:shrink-0 wide:flex-col wide:gap-5">
            <h1 className="text-[22px] leading-8 font-semibold tracking-[-0.4px]">Settings</h1>
            {nav}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-5 wide:pt-[52px]">
            <div className={cn(!index && "hidden wide:block")}>
              <h2 className="text-[17px] font-semibold">{current.label}</h2>
              <p className="text-[13.5px] text-muted-foreground">{current.blurb}</p>
            </div>
            {!index ? <p className="-mt-3 text-[13.5px] text-muted-foreground wide:hidden">{current.blurb}</p> : null}
            {body}
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsChrome({ back, label }: { back: string; label: string }) {
  const router = useRouter();
  const covered = useCovered();
  const onEvent = useStableCallback((event: { type: string }) => {
    if (event.type === "back") router.push(back);
  });
  useNativeChrome({ screen: "settings", label, covered }, onEvent);
  return null;
}
