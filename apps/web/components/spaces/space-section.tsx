"use client";

import { SPACE_LEVEL_LABELS, SPACE_LEVELS, type Bot, type Space, type SpaceLevel, type SpaceRule, type Thread } from "@gond/shared";
import { Lock, UserPlus } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { BotAvatar, PersonAvatar } from "@/components/bot-avatar";
import { Confirm } from "@/components/confirm-dialog";
import { failed } from "@/components/failed";
import { useLiveEvents } from "@/components/hq/live-events";
import { LoadFailed } from "@/components/load-failed";
import { openShellDialog } from "@/components/shell";
import { Words } from "@/components/spaces/space-dialogs";
import { useFederation } from "@/components/spaces/use-federation";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, post } from "@/lib/api";
import { spaceSubtitle } from "@/lib/spaces";

const LEVEL_ITEMS = SPACE_LEVELS.map((value) => ({ value, label: SPACE_LEVEL_LABELS[value].label }));

const heading = "text-[12px] font-medium uppercase tracking-wide text-muted-foreground";

/** A room's place among other Gonds, in its details: an invite for a room, everything about a space. */
export function SpaceSection({ thread }: { thread: Thread }) {
  const { federation } = useFederation();
  if (!thread.space) {
    if (!federation?.canInvite || thread.kind !== "room") return null;
    return (
      <section>
        <h2 className={heading}>Other Gonds</h2>
        <p className="mt-2 text-[12.5px] text-muted-foreground">Invite someone on another Gond, with their bots, and this room becomes a space. Only what&apos;s said from then on is shared.</p>
        <Button variant="outline" size="sm" onClick={() => openShellDialog({ kind: "invite-space", threadId: thread.id })} className="mt-3 w-full">
          <UserPlus data-icon="inline-start" aria-hidden="true" />
          Invite someone
        </Button>
      </section>
    );
  }
  return <SpaceDetails thread={thread} canInvite={Boolean(federation?.canInvite)} />;
}

function SpaceDetails({ thread, canInvite }: { thread: Thread; canInvite: boolean }) {
  const { bots, admin } = useStore();
  const [space, setSpace] = useState<Space | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [blocking, setBlocking] = useState<{ key: string; name: string } | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ space: Space }>(`/api/spaces/threads/${thread.id}`).catch(() => null);
    setLoadFailed(!data);
    if (data) setSpace(data.space);
  }, [thread.id]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "spaces" || (event.topic === "thread" && event.threadId === thread.id)) void load();
  });

  if (!space) return loadFailed ? <LoadFailed what="the space" onRetry={() => void load()} /> : <Skeleton className="h-40 rounded-xl" />;

  const open = space.status === "active";
  const verify = (key: string, verified: boolean) => post(`/api/spaces/gonds/${encodeURIComponent(key)}/verify`, { verified }).then(load).catch(failed("Couldn't save that."));
  const changeRule = (rule: SpaceRule) =>
    api<{ space: Space }>(`/api/spaces/threads/${thread.id}/rules/${rule.botId}`, { method: "PUT", body: JSON.stringify(rule) })
      .then((data) => setSpace(data.space))
      .catch(failed("Couldn't change that rule."));

  return (
    <>
      <section>
        <h2 className={heading}>Space</h2>
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
          {open ? <Lock className="size-3 text-tone-ok" aria-hidden="true" /> : null}
          {open ? `End-to-end encrypted. ${spaceSubtitle(space)}.` : `${spaceSubtitle(space)}.`}
        </p>
        <ul className="mt-3 flex flex-col gap-3">
          {space.gonds.map((gond) => {
            const people = space.members.filter((m) => m.gond === gond.key);
            return (
              <li key={gond.key} className="flex flex-col gap-1.5 rounded-xl border border-primary-edge p-2.5">
                <span className="flex items-center gap-1.5 text-[13px] font-medium">
                  <span className="truncate">{gond.name}</span>
                  {gond.verified ? <Lock className="size-3.5 shrink-0 text-tone-ok" aria-label="Words checked" /> : null}
                  {gond.host ? <span className="ml-auto shrink-0 text-[11px] font-normal text-muted-foreground">Keeps the space</span> : null}
                </span>
                {people.length ? (
                  <span className="flex flex-wrap gap-x-2.5 gap-y-1">
                    {people.map((m) => (
                      <span key={m.id} className="flex items-center gap-1 text-[12.5px]">
                        {m.kind === "bot" ? <BotAvatar bot={{ name: m.name, title: "", color: m.color ?? "#8f8b84", expression: "happy", primary: false }} size={18} /> : <PersonAvatar name={m.name} avatar={null} size={18} />}
                        {m.name}
                      </span>
                    ))}
                  </span>
                ) : null}
                <Words words={gond.words} />
                <span className="flex flex-wrap gap-1.5">
                  <Button variant="outline" size="xs" onClick={() => void verify(gond.key, !gond.verified)}>
                    {gond.verified ? "Words checked" : "We checked the words"}
                  </Button>
                  {admin ? (
                    <Button variant="ghost" size="xs" className="text-destructive" onClick={() => setBlocking({ key: gond.key, name: gond.name })}>
                      Block
                    </Button>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
        {open && space.host && canInvite ? (
          <Button variant="outline" size="sm" onClick={() => openShellDialog({ kind: "invite-space", threadId: thread.id })} className="mt-3 w-full">
            <UserPlus data-icon="inline-start" aria-hidden="true" />
            Invite someone
          </Button>
        ) : null}
      </section>

      {space.rules.length ? (
        <section>
          <h2 className={heading}>What they may do</h2>
          <p className="mt-2 text-[12.5px] text-muted-foreground">What each may do when someone on another Gond asks, and whether you can send it here from your own chat with it. Only you see and set this.</p>
          <ul className="mt-3 flex flex-col gap-4">
            {space.rules.map((rule) => {
              const b = bots.find((x) => x.id === rule.botId);
              return b ? <RuleRow key={rule.botId} bot={b} rule={rule} onChange={changeRule} /> : null;
            })}
          </ul>
        </section>
      ) : null}

      {open || space.status === "joining" ? (
        <section>
          <Button variant="outline" size="sm" className="w-full text-destructive" onClick={() => setLeaving(true)}>
            {space.host ? "Close the space" : "Leave the space"}
          </Button>
        </section>
      ) : null}

      <Confirm
        open={leaving}
        onOpenChange={setLeaving}
        title={space.host ? "Close this space for everyone?" : "Leave this space?"}
        description={space.host ? "Nobody can write in it any more. What was said stays here and on their Gonds." : "You stop getting what's said there. What was said stays here."}
        action={space.host ? "Close it" : "Leave"}
        onConfirm={() => post(`/api/spaces/threads/${thread.id}/leave`).then(load).catch(failed("Couldn't leave the space."))}
      />
      <Confirm
        open={Boolean(blocking)}
        onOpenChange={(next) => !next && setBlocking(null)}
        title={`Block ${blocking?.name ?? "this Gond"}?`}
        description="It's taken out of every space on this Gond, and nothing it sends gets through. Unblock it from Settings → Other Gonds."
        action="Block"
        onConfirm={() =>
          blocking
            ? post(`/api/spaces/gonds/${encodeURIComponent(blocking.key)}/block`, { blocked: true })
                .then(load)
                .catch(failed("Couldn't block it."))
            : undefined
        }
      />
    </>
  );
}

function RuleRow({ bot, rule, onChange }: { bot: Bot; rule: SpaceRule; onChange: (rule: SpaceRule) => Promise<void> }) {
  const id = `space-rule-${bot.id}`;
  return (
    <li className="flex flex-col gap-2">
      <span id={id} className="flex items-center gap-2 text-[13px] font-medium">
        <BotAvatar bot={bot} size={22} />
        {bot.name}
      </span>
      <Select items={LEVEL_ITEMS} value={rule.level} onValueChange={(value) => value && void onChange({ ...rule, level: value as SpaceLevel })}>
        <SelectTrigger aria-labelledby={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            {SPACE_LEVELS.map((level) => (
              <SelectItem key={level} value={level}>
                <span className="flex flex-col">
                  <span>{SPACE_LEVEL_LABELS[level].label}</span>
                  <span className="text-[12px] text-muted-foreground">{SPACE_LEVEL_LABELS[level].blurb}</span>
                </span>
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <label className="flex items-center justify-between gap-3 text-[12.5px]">
        <span>Use what {bot.name} remembers</span>
        <Switch size="sm" checked={rule.memory} onCheckedChange={(on) => void onChange({ ...rule, memory: on })} />
      </label>
      <label className="flex items-center justify-between gap-3 text-[12.5px]">
        <span>Let their people wake {bot.name}</span>
        <Switch size="sm" checked={rule.peopleWake} onCheckedChange={(on) => void onChange({ ...rule, peopleWake: on })} />
      </label>
      <label className="flex items-center justify-between gap-3 text-[12.5px]">
        <span>Let their bots wake {bot.name}</span>
        <Switch size="sm" checked={rule.botsWake} onCheckedChange={(on) => void onChange({ ...rule, botsWake: on })} />
      </label>
      <label className="flex items-center justify-between gap-3 text-[12.5px]">
        <span>Speak here when you ask in {bot.name}&apos;s chat</span>
        <Switch size="sm" checked={rule.relay} onCheckedChange={(on) => void onChange({ ...rule, relay: on })} />
      </label>
    </li>
  );
}
