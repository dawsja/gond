"use client";

import { MAX_PROFILES } from "@gond/shared";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BotAvatar, PersonAvatar, RoomAvatar, roomMembers } from "@/components/bot-avatar";
import { useCall } from "@/components/call/call-provider";
import { dismissTopmost, useCovered, useTokenHex } from "@/components/conversation-chrome";
import { failed } from "@/components/failed";
import { useSignOut } from "@/components/profile-menu";
import { openProfile } from "@/components/profiles";
import type { ShellDialog } from "@/components/shell";
import { useBotSearch } from "@/components/sidebar";
import { useFederation } from "@/components/spaces/use-federation";
import { useActivity, useStore } from "@/components/store";
import { threadActions, ThreadConfirms, type Ask, type ThreadAction } from "@/components/thread-actions";
import { WorthALookDialog, useWorthALookLine } from "@/components/worth-a-look";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { useDrafts } from "@/lib/drafts";
import { pictureFaceKey, sidebarHits, sidebarLists, sidebarSections, settingsSectionOf, type FaceSpec } from "@/lib/native-sidebar";
import { faceSent, facePng, picturesLoaded, sendFaces, useNativeSidebarState, type NativeMenuItem, type SidebarEvent, type SidebarState } from "@/lib/native-ui";
import { groupedSections, SETTINGS_SECTIONS } from "@/lib/settings-sections";

const FACE_PX = 128;
// Drawn at 64 so every face keeps its detail (glow, sheen) and a room's two read; painted at FACE_PX.
const COPY_SIZE = 64;

const NEW_SYMBOLS: Record<string, string> = { "new-bot": "plus.bubble", "new-room": "person.3", "new-space": "link", "join-space": "arrow.right.circle" };

const items = (groups: ThreadAction[][]): NativeMenuItem[][] => groups.map((group) => group.map(({ id, label, symbol, destructive }) => ({ id, label, symbol, destructive })));
const nothing = () => {};

/**
 * The Mac app's sidebar, drawn natively from what the page's own sidebar shows: the chats (or, in
 * Settings, its sections), the New menu, Worth a look, a call away from its chat and your menu. What
 * the person does there comes back as `gond:native-sidebar` and runs what the page's sidebar would.
 */
export function NativeSidebar({ onOpen }: { onOpen: (dialog: ShellDialog) => void }) {
  const { me, profiles, bots, threads, loaded, refresh } = useStore();
  const activity = useActivity();
  const drafts = useDrafts();
  const pathname = usePathname();
  const router = useRouter();
  const { query, setQuery, rows, hits } = useBotSearch();
  const { federation } = useFederation();
  const { call, end, toggleMute } = useCall();
  const look = useWorthALookLine();
  const covered = useCovered();
  const ink = useTokenHex("--foreground");
  const signOut = useSignOut();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [looking, setLooking] = useState(false);

  const section = settingsSectionOf(pathname);
  const callThread = call ? threads.find((t) => t.id === call.info.threadId) : undefined;
  const callBot = call ? bots.find((b) => b.id === call.info.botId) : undefined;

  const lists = sidebarLists({
    rows,
    query,
    bots,
    activity,
    drafts,
    pathname,
    call: call ? { threadId: call.info.threadId, connecting: call.phase === "connecting" } : null,
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
      ...(federation?.canInvite
        ? [
            { id: "new-space", label: "New space", symbol: NEW_SYMBOLS["new-space"]! },
            { id: "join-space", label: "Join space", symbol: NEW_SYMBOLS["join-space"]! },
          ]
        : []),
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
    // As the page's CallBar: only away from the call's own chat, whose composer is the call.
    call:
      call && pathname !== `/app/t/${call.info.threadId}`
        ? { label: call.phase === "connecting" ? `Calling ${callBot?.name ?? "your bot"}` : (callBot?.name ?? callThread?.name ?? "Call"), since: Date.parse(call.info.startedAt), muted: call.muted, color: callBot?.color ?? "" }
        : null,
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
        if (event.id === "new-bot" || event.id === "new-space" || event.id === "join-space") onOpen({ kind: event.id });
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
      case "call-open":
        if (call) router.push(`/app/t/${call.info.threadId}`);
        return;
      case "call-mute":
        toggleMute();
        return;
      case "call-end":
        end();
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

/** Unseen copies of the faces the app hasn't been sent yet, painted once each and sent with the next state. */
function FaceCopies({ faces, me }: { faces: FaceSpec[]; me: MeFace | null }) {
  const [, setPainted] = useState(0);
  const waiting = faces.filter((face) => !faceSent(face.key));
  const meWaiting = me && !faceSent(me.key) ? me : null;
  const keys = [...waiting.map((face) => face.key), meWaiting?.key ?? ""].join(" ").trim();
  useEffect(() => {
    if (!keys) return;
    let stale = false;
    let tries = 0;
    let timer = 0;
    // The copies render with this; a frame later their faces are drawn. A picture (yours, a bot's) may
    // still be loading, and until it has, its copy shows the fallback, so it waits a few times for it.
    const paint = () => {
      const holders = [...document.querySelectorAll<HTMLElement>("[data-native-face]")].filter((holder) => !faceSent(holder.dataset.nativeFace!));
      const ready = holders.filter(picturesLoaded);
      if (ready.length < holders.length && (tries += 1) < 20) timer = window.setTimeout(paint, 250);
      void Promise.all(ready.map(async (holder) => [holder.dataset.nativeFace!, holder.firstElementChild ? await facePng(holder.firstElementChild, FACE_PX) : null] as const)).then((pairs) => {
        if (stale) return;
        const painted = Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair[1])));
        if (!Object.keys(painted).length) return;
        sendFaces(painted);
        setPainted((n) => n + 1);
      });
    };
    const frame = window.requestAnimationFrame(paint);
    return () => {
      stale = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [keys]);
  if (!waiting.length && !meWaiting) return null;
  return (
    <div aria-hidden="true" className="invisible fixed top-0 left-0 size-0 overflow-hidden">
      {waiting.map((face) => (
        <span key={face.key} data-native-face={face.key} className="block w-fit">
          {"bot" in face ? <BotAvatar bot={face.bot} size={COPY_SIZE} /> : <RoomAvatar bots={face.members} size={COPY_SIZE} space={face.space} />}
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
