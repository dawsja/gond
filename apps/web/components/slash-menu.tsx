"use client";

import { handleOf, type Bot, type Skill } from "@gond/shared";
import { BotAvatar, PersonAvatar } from "@/components/bot-avatar";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { api } from "@/lib/api";
import { singleFlight } from "@/lib/single-flight";

// One skills list for every composer, so opening another chat fetches nothing. `skills` events keep it
// current while a composer listens, and a reconnect (`open`) loads it again. Once no composer has
// listened for longer than a chat switch takes, an event could have gone by, so the next one loads it.
const NO_SKILLS: Skill[] = [];
let library = NO_SKILLS;
let current = false;
let composers = 0;
let handled: unknown = null;
const libraryWatchers = new Set<() => void>();
const loadLibrary = singleFlight(async () => {
  const data = await api<{ skills: Skill[] }>("/api/skills");
  library = data.skills;
  for (const notify of libraryWatchers) notify();
});

function watchLibrary(notify: () => void) {
  libraryWatchers.add(notify);
  return () => libraryWatchers.delete(notify);
}

export function useSkillsLibrary(): Skill[] {
  useEffect(() => {
    composers += 1;
    if (!current) {
      current = true;
      void loadLibrary().catch(() => {
        current = false;
      });
    }
    return () => {
      composers -= 1;
      setTimeout(() => {
        if (composers === 0) current = false;
      }, 0);
    };
  }, []);
  useLiveEvents((event) => {
    // Every composer hears the same event; the first to see it loads for all of them.
    if (event === handled || (event.topic !== "skills" && event.topic !== "open") || (event.topic === "open" && event.first)) return;
    handled = event;
    void loadLibrary().catch(() => undefined);
  });
  return useSyncExternalStore(watchLibrary, () => library, () => NO_SKILLS);
}

export function slashQuery(text: string, caret: number): { kind: "skill" | "bot"; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)([/@])([a-z0-9_-]*)$/i.exec(before);
  if (!match) return null;
  return { kind: match[1] === "/" ? "skill" : "bot", query: match[2]!.toLowerCase(), start: caret - match[2]!.length - 1 };
}

export type Mentionable = { id: string; name: string; handle: string; detail: string | null; face: Parameters<typeof BotAvatar>[0]["bot"] | null };

export function mentionOfBot(bot: Bot): Mentionable {
  return { id: bot.id, name: bot.name, handle: handleOf(bot.name), detail: bot.title || null, face: bot };
}

export function matchMentions(people: Mentionable[], query: string): Mentionable[] {
  const q = query.toLowerCase();
  return people.filter((m) => m.handle.includes(q) || m.name.toLowerCase().includes(q)).slice(0, 8);
}

export function MentionFace({ who, size }: { who: Mentionable; size: number }) {
  return who.face ? <BotAvatar bot={who.face} size={size} /> : <PersonAvatar name={who.name} avatar={null} size={size} />;
}

export function matchSkills(skills: Skill[], query: string): Skill[] {
  const q = query.toLowerCase();
  return skills.filter((s) => s.slug.includes(q) || s.name.toLowerCase().includes(q)).slice(0, 8);
}

export function SlashMenu({ kind, skills, people, query, selected, onPickSkill, onPickPerson }: { kind: "skill" | "bot"; skills: Skill[]; people: Mentionable[]; query: string; selected: number; onPickSkill: (skill: Skill) => void; onPickPerson: (who: Mentionable) => void }) {
  const skillMatches = useMemo(() => (kind === "skill" ? matchSkills(skills, query) : []), [kind, skills, query]);
  const botMatches = useMemo(() => (kind === "bot" ? matchMentions(people, query) : []), [kind, people, query]);
  const current = kind === "skill" ? (skillMatches[selected]?.id ?? "") : (botMatches[selected]?.id ?? "");
  const everyone = people.some((m) => !m.face);
  const empty = kind === "skill" ? (skills.length ? "No skill matches." : "No skills yet. Add one under Settings → Skills.") : everyone ? "Nobody matches." : "No bot matches.";
  return (
    <div className="absolute inset-x-0 bottom-full z-10 mb-2 overflow-hidden rounded-2xl border border-primary-edge bg-popover p-1.5 shadow-subtle-3 pointer-coarse:rounded-3xl" aria-label={kind === "skill" ? "Skills" : everyone ? "People and bots" : "Bots"}>
      <Command value={current} shouldFilter={false} loop>
        <CommandList className="max-h-64">
          {skillMatches.length === 0 && botMatches.length === 0 ? <CommandEmpty>{empty}</CommandEmpty> : null}
          {kind === "skill" ? (
            <CommandGroup heading="Skills">
              {skillMatches.map((skill) => (
                <CommandItem key={skill.id} value={skill.id} onSelect={() => onPickSkill(skill)} onMouseDown={(e) => e.preventDefault()}>
                  <span className="font-mono text-[12.5px]">/{skill.slug}</span>
                  <span className="truncate text-muted-foreground">{skill.description || skill.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : (
            <CommandGroup heading={everyone ? "People and bots" : "Bots"}>
              {botMatches.map((who) => (
                <CommandItem key={who.id} value={who.id} onSelect={() => onPickPerson(who)} onMouseDown={(e) => e.preventDefault()}>
                  <MentionFace who={who} size={18} />
                  <span className="font-medium">{who.name}</span>
                  <span className="truncate font-mono text-[12px] text-muted-foreground">@{who.handle}</span>
                  {who.detail ? <span className="truncate text-muted-foreground">· {who.detail}</span> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
        </CommandList>
        <div className="flex items-center gap-2 border-t px-2.5 pt-1.5 text-[11px] text-muted-foreground pointer-coarse:hidden">
          <Kbd>↑↓</Kbd> choose <Kbd>Tab</Kbd> insert <Kbd>Esc</Kbd> close
        </div>
      </Command>
    </div>
  );
}
