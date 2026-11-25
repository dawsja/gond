"use client";

import { MAX_PROFILES } from "@gond/shared";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BotAvatar, PersonAvatar, RoomAvatar, roomMembers } from "@/components/bot-avatar";
import { dismissTopmost, useCovered, useTokenHex } from "@/components/conversation-chrome";
import { failed } from "@/components/failed";
import { useSignOut } from "@/components/profile-menu";
import { openProfile } from "@/components/profiles";
import type { ShellDialog } from "@/components/shell";
import { useBotSearch } from "@/components/sidebar";
import { useActivity, useStore } from "@/components/store";
import { threadActions, ThreadConfirms, type Ask, type ThreadAction } from "@/components/thread-actions";
import { WorthALookDialog, useWorthALookLine } from "@/components/worth-a-look";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { useDrafts } from "@/lib/drafts";
import { pictureFaceKey, sidebarHits, sidebarLists, sidebarSections, settingsSectionOf, watchNativeFaces, type FaceSpec } from "@/lib/native-sidebar";
import { faceSent, facePng, picturesLoaded, sendFaces, useNativeSidebarState, type NativeMenuItem, type SidebarEvent, type SidebarState } from "@/lib/native-ui";
import { groupedSections, SETTINGS_SECTIONS } from "@/lib/settings-sections";

const FACE_PX = 128;
// Drawn at 64 so every face keeps its detail (glow, sheen) and a room's two read; painted at FACE_PX.
const COPY_SIZE = 64;

const NEW_SYMBOLS: Record<string, string> = { "new-bot": "plus.bubble", "new-room": "person.3" };

const items = (groups: ThreadAction[][]): NativeMenuItem[][] => groups.map((group) => group.map(({ id, label, symbol, destructive }) => ({ id, label, symbol, destructive })));
const nothing = () => {};

export function NativeSidebar({ onOpen }: { onOpen: (dialog: ShellDialog) => void }) {
  const { me, profiles, bots, threads, loaded, refresh } = useStore();
  const activity = useActivity();
  const drafts = useDrafts();
  const pathname = usePathname();
  const router = useRouter();
  const { query, setQuery, rows, hits } = useBotSearch();
  const look = useWorthALookLine();
  const covered = useCovered();
  const ink = useTokenHex("--foreground");
  const signOut = useSignOut();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [looking, setLooking] = useState(false);

  const section = settingsSectionOf(pathname);

  const lists = sidebarLists({
    rows,
    query,
    bots,
    activity,
    drafts,
    pathname,
    ink,
    membersOf: (thread) => roomMembers(thread, bots),
    menuOf: (thread, bot) => items(threadActions({ thread, bot, bots, onOpen: nothing, onAsk: nothing, refresh })),
  });
  const meFace = me.avatar ? pictureFaceKey(me.avatar) : null;

  const state: Omit<SidebarState, "faces"> = {
    mode: section ? "settings" : "chats",
    title: section ? (SETTINGS_SECTIONS.find((s) => s.id === section)?.label ?? "Settings") : "Gond",
    covered,
    query,
    loaded,
    empty: loaded && !threads.some((t) => !t.botId || bots.some((b) => b.id === t.botId)),
    pinned: lists.pinned,
    rows: lists.rows,
    hits: sidebarHits(hits, query, threads, bots),
    look,
    newItems: [
      { id: "new-bot", label: "New bot", symbol: NEW_SYMBOLS["new-bot"]! },
      { id: "new-room", label: bots.length === 0 ? "New room (make a bot first)" : "New room", symbol: NEW_SYMBOLS["new-room"]! },
    ],
    me: { name: me.name, face: meFace, initial: me.name.trim().charAt(0).toUpperCase() || "Y", profile: profiles.length > 1 ? me.profile.label : null, active: Boolean(section) },
    profileMenu: [
      ...(profiles.length
        ? [
            [
              ...profiles.map((profile) => {
                const waiting = profile.unread + profile.needsYou;
                const current = profile.id === me.profile.id;
                return { id: `profile:${profile.id}`, label: !current && waiting > 0 ? `${profile.label} · ${waiting}` : profile.label, symbol: current ? "checkmark" : "person.crop.circle" };
              }),
              ...(profiles.length < MAX_PROFILES ? [{ id: "add-profile", label: "Add a profile", symbol: "plus" }] : []),
            ],
          ]
        : []),
      [{ id: "settings", label: "Settings", symbol: "gearshape" }],
      [{ id: "sign-out", label: "Sign out", symbol: "rectangle.portrait.and.arrow.right" }],
    ],
    sections: sidebarSections(groupedSections(me.role), section),
  };

  const onEvent = useStableCallback((event: SidebarEvent) => {
    switch (event.type) {
      case "open":
        if (typeof event.path !== "string" || !event.path.startsWith("/app") || event.path.startsWith("//")) return;
        if (state.hits.some((hit) => hit.path === event.path)) setQuery("");
        router.push(event.path);
        return;
      case "search":
        if (typeof event.value === "string") setQuery(event.value);
        return;
      case "row-menu": {
        const thread = threads.find((t) => t.id === event.thread);
        if (!thread) return;
        const bot = thread.botId ? bots.find((b) => b.id === thread.botId) : undefined;
        threadActions({ thread, bot, bots, onOpen, onAsk: setAsk, refresh })
          .flat()
          .find((action) => action.id === event.id)
          ?.run();
        return;
      }
      case "new":
        if (event.id === "new-bot") onOpen({ kind: "new-bot" });
        else if (event.id === "new-room" && bots.length > 0) onOpen({ kind: "new-room" });
        return;
      case "profile":
        if (event.id === "settings") router.push("/app/settings");
        else if (event.id === "sign-out") void signOut();
        else if (event.id === "add-profile") onOpen({ kind: "add-profile" });
        else if (typeof event.id === "string" && event.id.startsWith("profile:")) {
          const profile = profiles.find((p) => p.id === event.id.slice("profile:".length));
          if (profile && profile.id !== me.profile.id) void openProfile(profile.id).catch(failed(`Couldn't open ${profile.label}.`));
        }
        return;
      case "look":
        setLooking(true);
        return;
      case "dismiss":
        dismissTopmost();
        return;
    }
  });
  useNativeSidebarState(state, onEvent);

  return (
    <>
      {/* Until the theme's colours are read, a room's face would be painted in the wrong one. */}
      {ink ? <FaceCopies faces={lists.faces} me={meFace && me.avatar ? { key: meFace, name: me.name, avatar: me.avatar } : null} /> : null}
      <ThreadConfirms ask={ask} onClose={() => setAsk(null)} />
      <WorthALookDialog open={looking} onOpenChange={setLooking} />
    </>
  );
}

type MeFace = { key: string; name: string; avatar: string };

function FaceCopies({ faces, me }: { faces: FaceSpec[]; me: MeFace | null }) {
  const [, setPainted] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const waiting = faces.filter((face) => !faceSent(face.key));
  const meWaiting = me && !faceSent(me.key) ? me : null;
  const keys = [...waiting.map((face) => face.key), meWaiting?.key ?? ""].join(" ").trim();
  useEffect(() => {
    if (!keys || !containerRef.current) return;
    return watchNativeFaces({
      container: containerRef.current,
      isSent: faceSent,
      isReady: (holder) => picturesLoaded(holder as unknown as Element),
      renderFace: (element) => facePng(element, FACE_PX),
      onFaces: (painted) => {
        sendFaces(painted);
        setPainted((n) => n + 1);
      },
    });
  }, [keys]);
  if (!waiting.length && !meWaiting) return null;
  return (
    <div ref={containerRef} aria-hidden="true" className="invisible fixed top-0 left-0 size-0 overflow-hidden">
      {waiting.map((face) => (
        <span key={face.key} data-native-face={face.key} className="block w-fit">
          {"bot" in face ? <BotAvatar bot={face.bot} size={COPY_SIZE} /> : <RoomAvatar bots={face.members} size={COPY_SIZE} />}
        </span>
      ))}
      {meWaiting ? (
        <span data-native-face={meWaiting.key} className="block w-fit">
          <PersonAvatar name={meWaiting.name} avatar={meWaiting.avatar} size={COPY_SIZE} />
        </span>
      ) : null}
    </div>
  );
}
