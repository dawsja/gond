"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { PersonAvatar } from "@/components/bot-avatar";
import { ProfileMark, useOthersWaiting } from "@/components/profiles";
import { useCovered } from "@/components/conversation-chrome";
import type { ShellDialog } from "@/components/shell";
import { openShellDialog } from "@/components/shell";
import { BotRows, BotSearchInput, NewMenu, useBotSearch } from "@/components/sidebar";
import { useStore } from "@/components/store";
import { ThreadConfirms, type Ask } from "@/components/thread-actions";
import { Button } from "@/components/ui/button";
import { MessageScrollerEdges } from "@/components/ui/message-scroller";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { avatarPng, useNativeChrome, useNativeUi, type ChromeEvent } from "@/lib/native-ui";
import { cn } from "@/lib/utils";

const onOpen = (dialog: ShellDialog) => dialog && openShellDialog(dialog);

export function ChatsScreen({ className }: { className?: string }) {
  const { me, bots, profiles } = useStore();
  const othersWaiting = useOthersWaiting();
  const current = profiles.find((p) => p.id === me.profile.id);
  // In the iPhone app the header's buttons are the app's own, in Liquid Glass; the page keeps its own in place, unseen.
  const native = useNativeUi();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [searching, setSearching] = useState(false);
  const { query, setQuery, rows, hits } = useBotSearch();
  function closeSearch() {
    setQuery("");
    setSearching(false);
  }
  const onEvent = useStableCallback((event: ChromeEvent) => {
    if (event.type === "settings") onOpen({ kind: "profiles" });
    else if (event.type === "search") setSearching(true);
    else if (event.type === "query") setQuery(event.value);
    else if (event.type === "cancel-search") closeSearch();
    else if (event.type === "new") onOpen({ kind: event.kind });
  });
  return (
    // The header's buttons float over the list, which scrolls under them, as a conversation's do.
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      {native ? <ChatsChrome searching={searching} name={me.name} avatar={me.avatar} canNewRoom={bots.length > 0} onEvent={onEvent} /> : null}
      <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[calc(56px+max(12px,var(--safe-top)))] items-center gap-2 px-4 pt-[max(12px,var(--safe-top))] pb-2">
        <h1 className="sr-only">Chats</h1>
        {searching ? (
          <>

            {/* In the iPhone app the field is the app's own; this one keeps its place, unseen. */}
            <BotSearchInput query={query} setQuery={setQuery} autoFocus={!native} className={cn("pointer-events-auto h-11", native && "invisible")} />
            <Button variant="ghost" size="lg" onClick={closeSearch} className={cn("pointer-events-auto -mr-2", native && "invisible")}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {/* Your picture opens your profiles, and Settings from there. With more than one it wears the open one's mark, and a dot when another has something waiting. */}
            <button
              type="button"
              onClick={() => onOpen({ kind: "profiles" })}
              aria-label={othersWaiting ? "Profiles and settings, another profile has something new" : "Profiles and settings"}
              data-native-me=""
              className={cn("pointer-events-auto relative rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50", native && "invisible")}
            >
              <PersonAvatar name={me.name} avatar={me.avatar} size={44} />
              {profiles.length > 1 && current ? <ProfileMark profile={current} size={20} className="absolute -right-1 -bottom-1 ring-2 ring-background" /> : null}
              {othersWaiting ? <span aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-3 rounded-full bg-foreground ring-2 ring-background" /> : null}
            </button>
            <span className="flex-1" />
            <span className={cn("pointer-events-auto flex items-center gap-2", native && "invisible")}>
              <Button size="icon-xl" aria-label="Search" onClick={() => setSearching(true)}>
                <Search aria-hidden="true" className="size-5" />
              </Button>
              <NewMenu onOpen={onOpen} size="icon-xl" />
            </span>
          </>
        )}
      </header>
      <div data-chats-list="" className="min-h-0 flex-1 overflow-y-auto px-3 pt-[calc(56px+max(12px,var(--safe-top))+var(--call-pill-space))] pb-[calc(16px+var(--safe-bottom))]">
        <BotRows rows={rows} hits={hits} query={query} setQuery={setQuery} lookAs="sheet" onOpen={onOpen} onAsk={setAsk} />
      </div>
      <MessageScrollerEdges viewport="[data-chats-list]" top="calc(56px + max(12px, var(--safe-top)) + var(--call-pill-space) + 16px)" bottom="0px" />
      <ThreadConfirms ask={ask} onClose={() => setAsk(null)} />
    </div>
  );
}

/** Hands the header to the iPhone app: your picture, Search and New, or the search field while searching. */
function ChatsChrome({ searching, name, avatar, canNewRoom, onEvent }: { searching: boolean; name: string; avatar: string | null; canNewRoom: boolean; onEvent: (event: ChromeEvent) => void }) {
  const covered = useCovered();
  const [face, setFace] = useState<string | null>(null);
  useEffect(() => {
    if (!avatar) {
      void Promise.resolve().then(() => setFace(null));
      return;
    }
    // The page's (unseen) picture goes in once it has loaded, so this looks for it a few times.
    let stale = false;
    let tries = 0;
    const look = () => {
      const picture = document.querySelector("[data-native-me] img");
      if (picture) void avatarPng(picture.parentElement!).then((png) => !stale && setFace(png));
      else if ((tries += 1) < 20) timer = window.setTimeout(look, 250);
    };
    let timer = window.setTimeout(look, 0);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [avatar]);
  useNativeChrome({ screen: "chats", searching, face, initial: name.trim().charAt(0).toUpperCase() || "?", canNewRoom, covered }, onEvent);
  return null;
}
