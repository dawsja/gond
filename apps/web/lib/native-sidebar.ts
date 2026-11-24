import { isWatchRun, plainMarkdown, routineName, type Bot, type Message } from "@gond/shared";
import type { ThreadRow } from "@/components/store";
import type { NativeMenuItem, SidebarHit, SidebarRow, SidebarSection, SidebarTile } from "@/lib/native-ui";
import { settingsHref, type groupedSections } from "@/lib/settings-sections";
import { messageSnippet } from "@/lib/snippet";
import { remoteMember, spaceSubtitle } from "@/lib/spaces";
import { shortTime } from "@/lib/time";

type Activity = Readonly<Record<string, string>>;

export function threadPreview(thread: ThreadRow, bots: Bot[], activity: Activity): string {
  const busyBot = Object.keys(activity)[0];
  if (busyBot) {
    const line = activity[busyBot]!;
    const name = bots.find((b) => b.id === busyBot)?.name;
    return thread.kind === "room" && name ? `${name}: ${line}` : line;
  }
  const last = thread.lastMessage;
  if (!last) return thread.space ? spaceSubtitle(thread.space) : thread.kind === "room" ? "A room for several bots." : "Say hello, or hand over a task.";
  if (last.author === "routine") return isWatchRun(last.body) ? `Noticed: ${routineName(last.body) ?? "something"}` : `Routine: ${routineName(last.body) ?? "ran"}`;
  const who = last.author === "you" ? "You: " : thread.kind === "room" ? `${remoteMember(thread.space, last.author)?.name ?? bots.find((b) => b.id === last.author)?.name ?? ""}: ` : "";
  return `${who}${plainMarkdown(last.body)}`;
}

/** What a face is drawn from: a bot, or a room's bots (and whether it's a space). Its key changes only when the drawing would. */
export type FaceSpec = { key: string; bot: Bot } | { key: string; members: Bot[]; space: boolean };

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const looks = (bot: Bot) => [bot.id, bot.color, bot.shape, bot.avatar, bot.expression, bot.primary];

/** `ink` is the theme's text colour: a room's +N chip is painted in the theme, a bot's face isn't. */
export function faceOf(thread: ThreadRow, bot: Bot | undefined, members: Bot[], ink: string): FaceSpec {
  if (bot) return { key: `b${hash(JSON.stringify(looks(bot)))}`, bot };
  const space = Boolean(thread.space);
  return { key: `r${hash(JSON.stringify([space, members.map(looks), members.length > 2 ? ink : ""]))}`, members, space };
}

/** Your picture's face, by its address, which changes with the picture. */
export function pictureFaceKey(url: string): string {
  return `p${hash(url)}`;
}

export type SidebarListsInput = {
  rows: ThreadRow[];
  query: string;
  bots: Bot[];
  activity: Readonly<Record<string, Activity>>;
  drafts: Readonly<Record<string, string>>;
  pathname: string;
  /** The page's text colour, a room's unread dot as the page's sidebar draws it. */
  ink: string;
  membersOf: (thread: ThreadRow) => Bot[];
  menuOf: (thread: ThreadRow, bot: Bot | undefined) => NativeMenuItem[][];
  now?: Date;
};

export function sidebarLists({ rows, query, bots, activity, drafts, pathname, ink, membersOf, menuOf, now = new Date() }: SidebarListsInput): { pinned: SidebarTile[]; rows: SidebarRow[]; faces: FaceSpec[] } {
  const faces = new Map<string, FaceSpec>();
  const botOf = (thread: ThreadRow) => (thread.botId ? bots.find((b) => b.id === thread.botId) : undefined);
  const pinnedRows = query.trim() ? [] : rows.filter((thread) => botOf(thread)?.pinned || (thread.kind === "room" && thread.pinned));

  const common = (thread: ThreadRow, bot: Bot | undefined) => {
    const face = faceOf(thread, bot, bot ? [] : membersOf(thread), ink);
    faces.set(face.key, face);
    const path = `/app/t/${thread.id}`;
    const active = pathname === path;
    return {
      id: thread.id,
      path,
      face: face.key,
      active,
      unread: active ? null : thread.unread > 0 ? ("you" as const) : thread.unreadTeam ? ("team" as const) : null,
      color: bot?.color ?? ink,
      menu: menuOf(thread, bot),
    };
  };

  const pinned = pinnedRows.map((thread): SidebarTile => {
    const bot = botOf(thread);
    return { ...common(thread, bot), title: bot?.name ?? thread.name, working: Boolean(bot && activity[thread.id]?.[bot.id]) };
  });

  const listed = pinnedRows.length ? rows.filter((thread) => !pinnedRows.includes(thread)) : rows;
  const lines = listed.map((thread): SidebarRow => {
    const bot = botOf(thread);
    const base = common(thread, bot);
    const doing = activity[thread.id] ?? {};
    const working = Object.keys(doing).length > 0;
    const draft = !base.active && !working ? (drafts[thread.id] ?? "").replace(/\s+/g, " ").trim() : "";
    return {
      ...base,
      title: thread.name || bot?.name || "Room",
      job: bot?.title && thread.kind !== "room" ? bot.title : "",
      pinned: Boolean(bot?.pinned || thread.pinned),
      time: thread.lastMessage ? shortTime(thread.lastMessage.at, now) : "",
      preview: draft || threadPreview(thread, bots, doing),
      previewKind: draft ? "draft" : working ? "working" : "text",
      working,
    };
  });
  return { pinned, rows: lines, faces: [...faces.values()] };
}

export function sidebarHits(hits: Message[], query: string, threads: ThreadRow[], bots: Bot[], now = new Date()): SidebarHit[] {
  return hits.map((hit) => {
    const thread = threads.find((t) => t.id === hit.threadId);
    const who = hit.author === "you" ? "You" : (bots.find((b) => b.id === hit.author)?.name ?? thread?.name ?? "Bot");
    const { before, match, after } = messageSnippet(hit, query);
    return {
      id: hit.id,
      path: `/app/t/${hit.threadId}?m=${hit.id}`,
      title: `${who}${thread && thread.kind === "room" ? ` in ${thread.name}` : ""}`,
      time: shortTime(hit.createdAt, now),
      snippet: `${before}${match}${after}`,
    };
  });
}

export function sidebarSections(groups: ReturnType<typeof groupedSections>, active: string | null): { label: string; items: SidebarSection[] }[] {
  return groups.map((group) => ({
    label: group.label ?? "",
    items: group.sections.map((section) => ({ id: section.id, label: section.label, symbol: section.symbol, path: settingsHref(section.id), active: section.id === active })),
  }));
}

export function settingsSectionOf(pathname: string): string | null {
  if (pathname !== "/app/settings" && !pathname.startsWith("/app/settings/")) return null;
  return pathname.split("/")[3] || "account";
}

export type WatchableImage = {
  complete: boolean;
  addEventListener(type: "load" | "error", listener: () => void): void;
  removeEventListener(type: "load" | "error", listener: () => void): void;
};

export type WatchableFaceHolder = {
  dataset: { nativeFace?: string };
  firstElementChild: Element | null;
  querySelectorAll(selector: string): Iterable<WatchableImage>;
};

export type WatchableFaceContainer = {
  querySelectorAll(selector: string): Iterable<WatchableFaceHolder>;
};

export type WatchNativeFacesOptions = {
  container: WatchableFaceContainer;
  isSent: (key: string) => boolean;
  isReady: (holder: WatchableFaceHolder) => boolean;
  renderFace: (element: Element) => Promise<string | null>;
  onFaces: (faces: Record<string, string>) => void;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (id: number) => void;
  observe?: (container: WatchableFaceContainer, onMutate: () => void) => () => void;
};

function defaultObserve(container: WatchableFaceContainer, onMutate: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(onMutate);
  observer.observe(container as unknown as Node, { childList: true, subtree: true });
  return () => observer.disconnect();
}

export function watchNativeFaces({
  container,
  isSent,
  isReady,
  renderFace,
  onFaces,
  requestFrame = (cb) => window.requestAnimationFrame(cb),
  cancelFrame = (id) => window.cancelAnimationFrame(id),
  observe = defaultObserve,
}: WatchNativeFacesOptions): () => void {
  let stopped = false;
  let frame = 0;
  const inFlight = new Set<string>();
  const watched = new Map<WatchableImage, () => void>();
  const settledImages = new Set<WatchableImage>();
  let disconnect: (() => void) | null = null;

  const stopWatchingImages = () => {
    for (const [img, listener] of watched) {
      img.removeEventListener("load", listener);
      img.removeEventListener("error", listener);
    }
    watched.clear();
  };

  const stopObserving = () => {
    disconnect?.();
    disconnect = null;
    stopWatchingImages();
  };

  const schedule = () => {
    if (stopped || frame) return;
    frame = requestFrame(paint);
  };

  const watchImage = (img: WatchableImage) => {
    if (watched.has(img)) return;
    const onSettle = () => {
      img.removeEventListener("load", onSettle);
      img.removeEventListener("error", onSettle);
      watched.delete(img);
      settledImages.add(img);
      schedule();
    };
    watched.set(img, onSettle);
    img.addEventListener("load", onSettle);
    img.addEventListener("error", onSettle);
  };

  const imagesSettled = (holder: WatchableFaceHolder): boolean => {
    let settled = true;
    for (const img of holder.querySelectorAll("img")) {
      if (!img.complete && !settledImages.has(img)) {
        settled = false;
        watchImage(img);
      }
    }
    return settled;
  };

  const hasUnsentHolders = () =>
    [...container.querySelectorAll("[data-native-face]")].some((holder) => {
      const key = holder.dataset.nativeFace;
      return Boolean(key) && !isSent(key!);
    });

  const paint = () => {
    frame = 0;
    if (stopped) return;
    const pending = [...container.querySelectorAll("[data-native-face]")].filter((holder) => {
      const key = holder.dataset.nativeFace;
      return Boolean(key) && !isSent(key!) && !inFlight.has(key!);
    });
    const ready: WatchableFaceHolder[] = [];
    let waiting = 0;
    for (const holder of pending) {
      const loaded = isReady(holder);
      const settled = imagesSettled(holder);
      if (loaded && settled) ready.push(holder);
      else waiting += 1;
    }
    if (waiting === 0 && ready.length === 0 && inFlight.size === 0) {
      stopObserving();
      return;
    }
    if (ready.length === 0) return;
    for (const holder of ready) inFlight.add(holder.dataset.nativeFace!);
    void Promise.all(
      ready.map(async (holder) => {
        const key = holder.dataset.nativeFace!;
        try {
          return [key, holder.firstElementChild ? await renderFace(holder.firstElementChild) : null] as const;
        } finally {
          inFlight.delete(key);
        }
      }),
    ).then((pairs) => {
      if (stopped) return;
      const painted = Object.fromEntries(pairs.filter((pair): pair is readonly [string, string] => Boolean(pair[1])));
      if (Object.keys(painted).length) onFaces(painted);
      if (!hasUnsentHolders() && inFlight.size === 0) stopObserving();
    });
  };

  disconnect = observe(container, schedule);
  schedule();

  return () => {
    stopped = true;
    if (frame) cancelFrame(frame);
    frame = 0;
    stopObserving();
  };
}
