"use client";

import { handleOf, isWatchRun, plainMarkdown, routineName, type Bot, type Message } from "@gond/shared";
import { Bot as BotIcon, MessageSquareText, Pin, Plus, Search, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment, memo, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { BotAvatar, PersonAvatar, RoomAvatar, roomMembers } from "@/components/bot-avatar";
import { GondBot } from "@/components/hq/gond-bot";
import { ProfileMenu } from "@/components/profile-menu";
import type { ShellDialog } from "@/components/shell";
import { useActivity, useStore, type ThreadRow } from "@/components/store";
import { threadActions, ThreadConfirms, type Ask } from "@/components/thread-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSkeleton, useSidebar } from "@/components/ui/sidebar";
import { api } from "@/lib/api";
import { useDrafts } from "@/lib/drafts";
import { shortTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import { WorthALook } from "@/components/worth-a-look";

const IDLE: Record<string, string> = {};

function preview(thread: ThreadRow, bots: Bot[], activity: Record<string, string>): string {
  const busyBot = Object.keys(activity)[0];
  if (busyBot) {
    const line = activity[busyBot]!;
    const name = bots.find((b) => b.id === busyBot)?.name;
    return thread.kind === "room" && name ? `${name}: ${line}` : line;
  }
  const last = thread.lastMessage;
  if (!last) return thread.kind === "room" ? "A room for several bots." : "Say hello, or hand over a task.";
  if (last.author === "routine") return isWatchRun(last.body) ? `Noticed: ${routineName(last.body) ?? "something"}` : `Routine: ${routineName(last.body) ?? "ran"}`;
  const who = last.author === "you" ? "You: " : thread.kind === "room" ? `${bots.find((b) => b.id === last.author)?.name ?? ""}: ` : "";
  return `${who}${plainMarkdown(last.body)}`;
}

function ThreadMenu({ thread, bot, onOpen, onAsk, trigger, children }: { thread: ThreadRow; bot: Bot | undefined; onOpen: (dialog: ShellDialog) => void; onAsk: (ask: Ask) => void; trigger: ReactElement; children: ReactNode }) {
  const { bots, refresh } = useStore();
  const groups = threadActions({ thread, bot, bots, onOpen, onAsk, refresh });
  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {groups.map((group, i) => (
          <Fragment key={i}>
            {i > 0 ? <ContextMenuSeparator /> : null}
            <ContextMenuGroup>
              {group.map((action) => (
                <ContextMenuItem key={action.id} variant={action.destructive ? "destructive" : "default"} onClick={action.run}>
                  <action.icon aria-hidden="true" />
                  {action.label}
                </ContextMenuItem>
              ))}
            </ContextMenuGroup>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

const PinnedTile = memo(function PinnedTile({ thread, bot, active, onOpen, onAsk }: { thread: ThreadRow; bot: Bot | undefined; active: boolean; onOpen: (dialog: ShellDialog) => void; onAsk: (ask: Ask) => void }) {
  const { setOpenMobile } = useSidebar();
  const { bots } = useStore();
  return (
    <ThreadMenu thread={thread} bot={bot} onOpen={onOpen} onAsk={onAsk} trigger={<li className="list-none" />}>
      <Link href={`/app/t/${thread.id}`} aria-current={active ? "page" : undefined} onClick={() => setOpenMobile(false)} className="relative flex w-28 flex-col items-center gap-3 rounded-2xl py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 wide:w-22 wide:gap-1.5 wide:py-2">
        {bot ? (
          <>
            <BotAvatar bot={bot} size={96} className="wide:hidden" />
            <BotAvatar bot={bot} size={64} className="hidden wide:inline-flex" />
          </>
        ) : (
          <>
            <RoomAvatar bots={roomMembers(thread, bots)} size={96} className="wide:hidden" />
            <RoomAvatar bots={roomMembers(thread, bots)} size={64} className="hidden wide:inline-block" />
          </>
        )}
        <span className={cn("max-w-full truncate text-[16px] wide:text-[13px]", active ? "font-medium text-foreground" : "text-muted-foreground")}>{bot?.name ?? thread.name}</span>
        {thread.unread > 0 && !active ? <span className="absolute top-2 right-3 size-2.5 rounded-full ring-2 ring-background" style={{ background: bot?.color ?? "var(--foreground)" }} aria-label={`${thread.unread} unread`} /> : null}
      </Link>
    </ThreadMenu>
  );
});

const Row = memo(function Row({ thread, bot, active, bots, activity, draft, onOpen, onAsk }: { thread: ThreadRow; bot: Bot | undefined; active: boolean; bots: Bot[]; activity: Record<string, string>; draft: string | undefined; onOpen: (dialog: ShellDialog) => void; onAsk: (ask: Ask) => void }) {
  const { setOpenMobile } = useSidebar();
  const working = Object.keys(activity).length > 0;
  const drafted = !active && !working && draft ? draft.replace(/\s+/g, " ").trim() : "";
  return (
    <ThreadMenu thread={thread} bot={bot} onOpen={onOpen} onAsk={onAsk} trigger={<SidebarMenuItem />}>
        <SidebarMenuButton size="lg" isActive={active} render={<Link href={`/app/t/${thread.id}`} aria-current={active ? "page" : undefined} onClick={() => setOpenMobile(false)} />} className="h-[76px] gap-4 rounded-2xl px-3 data-active:bg-card data-active:[--surface:var(--card)] data-active:shadow-subtle hover:bg-card/60 wide:h-14 wide:gap-3 wide:rounded-xl wide:px-2.5">
          {bot ? (
            <>
              <BotAvatar bot={bot} size={48} className="wide:hidden" />
              <BotAvatar bot={bot} size={40} className="hidden wide:inline-flex" />
            </>
          ) : (
            <>
              <RoomAvatar bots={roomMembers(thread, bots)} size={48} className="wide:hidden" />
              <RoomAvatar bots={roomMembers(thread, bots)} size={40} className="hidden wide:inline-block" />
            </>
          )}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-baseline justify-between gap-2">

              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="max-w-[75%] shrink-0 truncate text-[17px] font-semibold wide:text-[14px]">{thread.name || bot?.name || "Room"}</span>
                {bot?.title && thread.kind !== "room" ? (
                  <Badge variant="secondary" className="h-5 min-w-0 shrink px-1.5 text-[11.5px] font-normal text-muted-foreground wide:h-4 wide:text-[10.5px]" title={bot.title}>
                    <span className="truncate">{bot.title}</span>
                  </Badge>
                ) : null}
                {bot?.pinned || thread.pinned ? <Pin className="size-3 shrink-0 text-muted-foreground" aria-label="Pinned" /> : null}
              </span>
              {thread.lastMessage ? <span className="shrink-0 text-[13px] text-ash wide:text-[11px]">{shortTime(thread.lastMessage.at)}</span> : null}
            </span>
            <span className={cn("flex items-center gap-1.5 text-[15px] leading-6 text-muted-foreground wide:text-[12.5px] wide:leading-5", working && "italic")}>
              {drafted ? (
                <span className="truncate">
                  <span className="font-medium text-foreground">Draft: </span>
                  {drafted}
                </span>
              ) : (
                <span className="truncate">{preview(thread, bots, activity)}</span>
              )}
              {thread.unread > 0 && !active ? <span className="ml-auto size-2 shrink-0 rounded-full" style={{ background: bot?.color ?? "var(--foreground)" }} aria-label={`${thread.unread} unread`} /> : null}
            </span>
          </span>
        </SidebarMenuButton>
    </ThreadMenu>
  );
});

export function useBotSearch() {
  const { bots, threads } = useStore();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string; messages: Message[] }>({ q: "", messages: [] });
  const hits = found.q === query.trim() ? found.messages : [];
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      api<{ messages: Message[] }>(`/api/search?q=${encodeURIComponent(q)}`)
        .then((d) => alive && setFound({ q, messages: d.messages.slice(0, 12) }))
        .catch(() => undefined);
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byId = new Map(bots.map((b) => [b.id, b]));
    return threads
      .filter((t) => !t.botId || byId.has(t.botId))
      .filter((t) => {
        if (!q) return true;
        const bot = t.botId ? byId.get(t.botId) : undefined;
        return t.name.toLowerCase().includes(q) || Boolean(bot && (bot.name.toLowerCase().includes(q) || bot.title.toLowerCase().includes(q) || handleOf(bot.name).includes(q)));
      })
      .sort((a, b) => {
        const pa = a.botId ? Number(byId.get(a.botId)?.pinned) : Number(a.pinned);
        const pb = b.botId ? Number(byId.get(b.botId)?.pinned) : Number(b.pinned);
        if (pa !== pb) return pb - pa;
        return (b.lastMessage?.at ?? b.createdAt).localeCompare(a.lastMessage?.at ?? a.createdAt);
      });
  }, [threads, bots, query]);

  return { query, setQuery, rows, hits };
}

export function BotSearchInput({ query, setQuery, autoFocus = false, className }: { query: string; setQuery: (q: string) => void; autoFocus?: boolean; className?: string }) {
  return (
    <InputGroup variant="pill" className={cn("h-9 flex-1 rounded-full", className)}>
      <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search bots" autoFocus={autoFocus} className="text-[13px]" />
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
    </InputGroup>
  );
}

export function NewMenu({ onOpen, size = "icon-lg" }: { onOpen: (dialog: ShellDialog) => void; size?: "icon-xl" | "icon-lg" | "icon" }) {
  const { bots } = useStore();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size={size} aria-label="New" />}>
        <Plus aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => onOpen({ kind: "new-bot" })}>
            <BotIcon aria-hidden="true" />
            New bot
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onOpen({ kind: "new-room" })} disabled={bots.length === 0}>
            <Users aria-hidden="true" />
            {bots.length === 0 ? "New room (make a bot first)" : "New room"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function BotRows({ rows, hits, query, setQuery, lookAs, onOpen, onAsk }: { rows: ThreadRow[]; hits: Message[]; query: string; setQuery: (q: string) => void; lookAs: "sheet" | "popover"; onOpen: (dialog: ShellDialog) => void; onAsk: (ask: Ask) => void }): ReactNode {
  const { bots, threads, loaded } = useStore();
  const activity = useActivity();
  const pathname = usePathname();
  const drafts = useDrafts();
  const pinned = query.trim()
    ? []
    : rows.flatMap((thread) => {
        const bot = thread.botId ? bots.find((b) => b.id === thread.botId) : undefined;
        return bot?.pinned || (thread.kind === "room" && thread.pinned) ? [{ thread, bot }] : [];
      });
  return (
    <>
      {!loaded ? (
        <SidebarMenu className="gap-1">
          {Array.from({ length: 4 }, (_, i) => (
            <SidebarMenuSkeleton key={i} showIcon className="h-14 rounded-xl" />
          ))}
        </SidebarMenu>
      ) : rows.length === 0 && query.trim() ? (
        hits.length ? null : <p className="px-2.5 py-6 text-center text-[13px] text-muted-foreground">Nothing matches.</p>
      ) : rows.length === 0 ? (
        <Empty className="py-10">
          <EmptyHeader>
            <EmptyMedia>
              <GondBot color="#189C47" size={56} expression="wink" greet={false} />
            </EmptyMedia>
            <EmptyTitle>No bots yet</EmptyTitle>
            <EmptyDescription>Create one and give it a job.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => onOpen({ kind: "new-bot" })}>Create your first bot</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>

          {pinned.length ? (
            <ul className="mb-2 flex flex-wrap justify-center gap-x-2 gap-y-2 px-1 pt-6 pb-4 wide:mb-1 wide:gap-x-1 wide:pt-2 wide:pb-3" aria-label="Pinned">
              {pinned.map(({ thread, bot }) => (
                <PinnedTile key={thread.id} thread={thread} bot={bot} active={pathname === `/app/t/${thread.id}`} onOpen={onOpen} onAsk={onAsk} />
              ))}
            </ul>
          ) : null}
          {query.trim() ? null : <WorthALook as={lookAs} className={cn("mx-1 mb-2 w-[calc(100%-8px)]", !pinned.length && "mt-1")} />}
        <SidebarMenu className="gap-0.5" aria-label="Bots">
          {(pinned.length ? rows.filter((t) => !pinned.some((p) => p.thread.id === t.id)) : rows).map((thread) => (
            <Row key={thread.id} thread={thread} bot={thread.botId ? bots.find((b) => b.id === thread.botId) : undefined} active={pathname === `/app/t/${thread.id}`} bots={bots} activity={activity[thread.id] ?? IDLE} draft={drafts[thread.id]} onOpen={onOpen} onAsk={onAsk} />
          ))}
        </SidebarMenu>
        </>
      )}
      {hits.length ? (
        <div className="mt-3">
          <h3 className="px-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">In messages</h3>
          <SidebarMenu className="mt-1 gap-0.5" aria-label="Messages that match">
            {hits.map((hit) => {
              const thread = threads.find((t) => t.id === hit.threadId);
              const who = hit.author === "you" ? "You" : (bots.find((b) => b.id === hit.author)?.name ?? thread?.name ?? "Bot");
              return (
                <SidebarMenuItem key={hit.id}>
                  <SidebarMenuButton size="lg" render={<Link href={`/app/t/${hit.threadId}?m=${hit.id}`} onClick={() => setQuery("")} />} className="h-12 items-start gap-2.5 rounded-xl px-2.5 hover:bg-card/60">
                    <MessageSquareText className="mt-1 text-muted-foreground" aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[12.5px] font-medium">
                        {who}
                        {thread && thread.kind === "room" ? ` in ${thread.name}` : ""}
                        <span className="ml-1.5 font-normal text-ash">{shortTime(hit.createdAt)}</span>
                      </span>
                      <span className="truncate text-[12px] text-muted-foreground">{hit.body.replace(/\s+/g, " ")}</span>
                    </span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </div>
      ) : null}
    </>
  );
}

export function AppSidebar({ onOpen }: { onOpen: (dialog: ShellDialog) => void }) {
  const { me } = useStore();
  const pathname = usePathname();
  const [ask, setAsk] = useState<Ask | null>(null);
  const { query, setQuery, rows, hits } = useBotSearch();

  return (
    <Sidebar collapsible="offcanvas" className="bg-background [&_[data-sidebar=sidebar]]:bg-background">
      <SidebarHeader className="flex-row items-center gap-2 px-3 pt-3 pb-2">
        <BotSearchInput query={query} setQuery={setQuery} />
        <NewMenu onOpen={onOpen} />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <BotRows rows={rows} hits={hits} query={query} setQuery={setQuery} lookAs="popover" onOpen={onOpen} onAsk={setAsk} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <SidebarMenu className="gap-0.5">

          <SidebarMenuItem>
            <ProfileMenu trigger={<SidebarMenuButton isActive={pathname.startsWith("/app/settings")} aria-label="Your menu" className="h-10 gap-3 rounded-xl px-2.5 text-[13.5px] font-medium data-active:bg-card data-active:shadow-subtle hover:bg-card/60" />}>
              <PersonAvatar name={me.name} avatar={me.avatar} size={24} />
              <span className="truncate">{me.name}</span>
            </ProfileMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <ThreadConfirms ask={ask} onClose={() => setAsk(null)} />
    </Sidebar>
  );
}
