"use client";

import { HOUSEHOLD_NAME_MAX, PROVIDER_LABELS, SPACE_LEVEL_LABELS, type Household, type HouseholdSetup, type KeyProviderKind, type MembersAi, type SharedBot, type SpaceLevel } from "@gond/shared";
import { Check, Ellipsis, House, Plus, Trash2, UserMinus } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { BotAvatar, PersonAvatar } from "@/components/bot-avatar";
import { Confirm } from "@/components/confirm-dialog";
import { failed } from "@/components/failed";
import { useLiveEvents } from "@/components/hq/live-events";
import { LevelSelect } from "@/components/level-select";
import { LoadFailed } from "@/components/load-failed";
import { useStore } from "@/components/store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { api, del, patch, post } from "@/lib/api";
import { settingsHref } from "@/lib/settings-sections";
import { cn } from "@/lib/utils";

type Candidate = { id: string; name: string; email: string; image: string | null };
type BotRef = SharedBot["bot"];
type Loaded = { household: Household | null; setup?: HouseholdSetup | null; candidates?: Candidate[]; bots?: BotRef[]; keys?: KeyProviderKind[] };

function useHousehold() {
  const [data, setData] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const load = useCallback(async () => {
    try {
      setData(await api<Loaded>("/api/household"));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "household" || event.topic === "ai") void load();
  });
  return { data, loadFailed, load, setData };
}

/** Settings → Household: turning it on for the admin, the household for its head, and joining or leaving it for everyone else. */
export function HouseholdSection() {
  const { data, loadFailed, load, setData } = useHousehold();
  if (!data) return loadFailed ? <LoadFailed what="your household" onRetry={() => void load()} /> : <Skeleton className="h-64 rounded-xl" />;
  const { household } = data;
  if (!household) return data.setup ? <TurnOnCard setup={data.setup} onDone={(next) => setData({ ...data, household: next })} /> : <NoHousehold />;
  if (household.role === "asked") return <JoinCard household={household} />;
  if (household.role === "member") return <MemberView household={household} />;
  return <HeadView data={data} household={household} onChange={(next) => setData({ ...data, household: next })} />;
}

function NoHousehold() {
  return (
    <Card>
      <CardContent>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>You aren&apos;t in a household</EmptyTitle>
            <EmptyDescription>Your admin can ask you to join theirs. You&apos;ll see the ask here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  );
}

function Step({ done, title, detail, href, action }: { done: boolean; title: string; detail: string; href: string; action: string }) {
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <span className={cn("grid size-7 shrink-0 place-items-center rounded-full border", done ? "border-control bg-control text-control-foreground" : "border-muted-foreground/50 text-muted-foreground")}>{done ? <Check className="size-3.5" aria-hidden="true" /> : null}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14.5px] font-medium">{title}</span>
        <span className="block text-[13px] text-muted-foreground">{detail}</span>
      </span>
      {done ? null : <Button variant="outline" size="sm" render={<Link href={href} />}>{action}</Button>}
    </li>
  );
}

/** The admin turns Household on once everyone it serves can sign in the same way and the members have a key to run on. */
function TurnOnCard({ setup, onDone }: { setup: HouseholdSetup; onDone: (household: Household) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = Boolean(setup.oidc) && setup.linked && setup.keys.length > 0;

  async function turnOn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone((await post<{ household: Household }>("/api/household", { name: name.trim() || undefined })).household);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't turn on Household.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Turn on Household</CardTitle>
        <CardDescription>Share an AI with the people you live with, who sign in through {setup.oidc ?? "your sign-in provider"}, and let their bots ask yours for help. Each of them keeps their own bots, chats and notifications.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ul className="flex flex-col divide-y">
          <Step done={Boolean(setup.oidc)} title="A sign-in provider" detail={setup.oidc ? `${setup.oidc} is set up` : "Members sign in through it, like Authentik or Google."} href={settingsHref("auth")} action="Set up" />
          <Step done={setup.linked} title={`Link your account to ${setup.oidc ?? "it"}`} detail="You'll sign in the same way as everyone in your household." href={settingsHref("account")} action="Link" />
          <Step done={setup.keys.length > 0} title="A key for members" detail="Members run on an API key, never your plan." href={settingsHref("ai")} action="Add" />
        </ul>
        <form onSubmit={turnOn}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="household-name">Name</FieldLabel>
              <Input id="household-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Hall household" maxLength={HOUSEHOLD_NAME_MAX} disabled={!ready} />
              <FieldDescription>You&apos;ll be head of household. Only you add people, share bots and change the household&apos;s AI.</FieldDescription>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button type="submit" variant="tint" size="lg" disabled={!ready || busy}>
              Turn on Household
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

/** An ask to join: joining moves this person's AI to the household's keys and lets the head see their usage, so it is theirs to accept. */
function JoinCard({ household }: { household: Household }) {
  const [busy, setBusy] = useState(false);
  const head = household.head.name;
  async function answer(join: boolean) {
    setBusy(true);
    try {
      await post(join ? "/api/household/join" : "/api/household/leave");
    } catch (failure) {
      failed(join ? "Couldn't join the household." : "Couldn't turn it down.")(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {head} asked you to join {household.name}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y text-[14px]">
          <li className="py-2.5 first:pt-0">
            <span className="block font-medium">Your bots run on the household&apos;s AI</span>
            <span className="block text-[13px] text-muted-foreground">{head} sees how much you use, never what you say.</span>
          </li>
          <li className="py-2.5">
            <span className="block font-medium">Your bots can ask {head}&apos;s shared bots for help</span>
            <span className="block text-[13px] text-muted-foreground">{head} sees what your bots ask them, since they&apos;re {head}&apos;s bots.</span>
          </li>
          <li className="py-2.5 last:pb-0">
            <span className="block font-medium">Your chats and notifications stay yours</span>
          </li>
        </ul>
      </CardContent>
      <CardFooter className="gap-2">
        <Button variant="outline" size="lg" className="flex-1" disabled={busy} onClick={() => void answer(false)}>
          Not now
        </Button>
        <Button variant="tint" size="lg" className="flex-1" disabled={busy} onClick={() => void answer(true)}>
          Join
        </Button>
      </CardFooter>
    </Card>
  );
}

/** What a shared bot does for a member's bots, said from the member's side. */
function memberSees(level: SpaceLevel, head: string): string {
  if (level === "talk") return "Answers questions";
  if (level === "look") return "Answers and looks things up";
  if (level === "act") return `Does things once ${head} says yes`;
  return "Does things straight away";
}

/** The members' AI in words, by the names Settings → AI uses, like "openai/gpt-5, on the household's OpenAI-compatible API". */
function aiLine(ai: MembersAi): string {
  const key = `the household's ${PROVIDER_LABELS[ai.provider].name}`;
  if (ai.engine === "claude") return ai.model ? `Claude Code with ${ai.model}, on ${key}` : `Claude Code, on ${key}`;
  return ai.model ? `${ai.model}, on ${key}` : key;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K tokens`;
  return `${n} tokens`;
}

function MemberView({ household }: { household: Household }) {
  const [leaving, setLeaving] = useState(false);
  const head = household.head.name;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{household.name}</CardTitle>
          <CardDescription>
            {head} is head of household. They choose the AI your bots run on and which of their bots yours can ask. They see how much you use, never what you say.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            <li className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] font-medium">Your bots run on</span>
                <span className="block text-[13px] text-muted-foreground">{aiLine(household.ai)}</span>
              </span>
              <Badge tone={household.aiReady ? "ok" : "warn"}>{household.aiReady ? "Working" : "Not ready"}</Badge>
            </li>
            <li className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1">
                <span className="block text-[14.5px] font-medium">This month</span>
                <span className="block text-[13px] text-muted-foreground">{tokens(household.members[0]?.tokens ?? 0)}</span>
              </span>
            </li>
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{head}&apos;s shared bots</CardTitle>
          <CardDescription>Your bots can ask these for help. You talk to your own bots; they ask, and tell you what came of it.</CardDescription>
        </CardHeader>
        <CardContent>
          {household.shared.length ? (
            <ul className="flex flex-col divide-y">
              {household.shared.map(({ bot, levels }) => (
                <li key={bot.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <BotAvatar bot={{ ...bot, primary: false }} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium">{bot.name}</span>
                    <span className="block text-[13px] text-muted-foreground">{memberSees(levels[0]?.level ?? "talk", head)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">None yet. {head} can share bots from Settings → Household.</p>
          )}
        </CardContent>
        <CardFooter>
          <Button variant="outline" onClick={() => setLeaving(true)}>
            Leave {household.name}
          </Button>
        </CardFooter>
      </Card>
      <Confirm
        open={leaving}
        onOpenChange={setLeaving}
        title={`Leave ${household.name}?`}
        description="Your bots and chats stay yours, but they'll need an AI of your own, set up under Settings → AI."
        action="Leave"
        onConfirm={() => post("/api/household/leave")}
      />
    </>
  );
}

/** On Chats, for someone the head asked to join: the ask, until they answer it in Settings → Household. */
export function HouseholdAsk({ className }: { className?: string }) {
  const { me } = useStore();
  if (me.household?.role !== "asked") return null;
  return (
    <Link href={settingsHref("household")} className={cn("mb-2 flex items-center gap-3 rounded-2xl border border-[var(--primary-edge)] bg-card px-3 py-3 outline-none focus-visible:ring-3 focus-visible:ring-ring/50", className)}>
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-control text-control-foreground">
        <House className="size-4" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium">{me.household.headName} asked you to join {me.household.name}</span>
        <span className="block text-[12.5px] text-muted-foreground">See what it means, then join or say not now.</span>
      </span>
      <Badge tone="warn">Needs you</Badge>
    </Link>
  );
}

/** Settings → AI for a household member: the household's AI, which only the head changes. */
export function HouseholdAiCard() {
  const { data, loadFailed, load } = useHousehold();
  if (!data) return loadFailed ? <LoadFailed what="your household's AI" onRetry={() => void load()} /> : <Skeleton className="h-40 rounded-xl" />;
  const household = data.household;
  if (!household) return null;
  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <Alert>
          <House aria-hidden="true" />
          <AlertTitle>{household.head.name} runs the AI for {household.name}</AlertTitle>
          <AlertDescription>Your bots run on {aiLine(household.ai)}. {household.head.name} sees how much you use, never what you say.</AlertDescription>
        </Alert>
        <Button variant="outline" className="self-start" render={<Link href={settingsHref("household")} />}>
          Your household
        </Button>
      </CardContent>
    </Card>
  );
}

function HeadView({ data, household, onChange }: { data: Loaded; household: Household; onChange: (household: Household) => void }) {
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState<BotRef | null>(null);
  const [picking, setPicking] = useState(false);
  const [ending, setEnding] = useState(false);
  const [removing, setRemoving] = useState<Household["members"][number] | null>(null);
  const joined = household.members.filter((m) => m.status === "joined");
  const sharedIds = new Set(household.shared.map((s) => s.bot.id));
  const shareable = (data.bots ?? []).filter((bot) => !sharedIds.has(bot.id));
  const nameOf = (id: string) => household.members.find((m) => m.id === id)?.name ?? "someone";

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{household.name}</CardTitle>
          <CardDescription>
            {joined.length + 1} {joined.length === 0 ? "person" : "people"}
            {household.members.length > joined.length ? `, ${household.members.length - joined.length} asked` : ""} · you&apos;re head of household
          </CardDescription>
        </CardHeader>
      </Card>

      <MembersAiCard household={household} keys={data.keys ?? []} onChange={onChange} />

      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <CardDescription>Everyone runs on the members&apos; AI and keeps their own bots, chats and notifications. You see how much they use, never what they say.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col divide-y">
            {household.members.map((member) => (
              <li key={member.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <PersonAvatar name={member.name} avatar={member.image} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14.5px] font-medium">{member.name}</span>
                  <span className="block text-[13px] text-muted-foreground">{member.status === "joined" ? `Member · ${tokens(member.tokens)} this month` : "Asked, waiting for them to join"}</span>
                </span>
                {member.status === "asked" ? <Badge tone="neutral">Waiting</Badge> : null}
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`${member.name}'s options`} />}>
                    <Ellipsis aria-hidden="true" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuGroup>
                      <DropdownMenuItem variant="destructive" onClick={() => setRemoving(member)}>
                        <UserMinus aria-hidden="true" />
                        {member.status === "asked" ? "Take back the ask" : "Remove from household"}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            ))}
            {household.members.length === 0 ? <li className="text-[13px] text-muted-foreground">Nobody yet. Add someone who signs in to Gond through your sign-in provider.</li> : null}
          </ul>
        </CardContent>
        <CardFooter>
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Add someone
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Shared bots</CardTitle>
          <CardDescription>Members&apos; bots can ask these for help. Members never chat with them; each errand shows up in your Chats, like &quot;Steve · for Jaimee&quot;.</CardDescription>
        </CardHeader>
        <CardContent>
          {household.shared.length ? (
            <ul className="flex flex-col divide-y">
              {household.shared.map(({ bot, levels }) => {
                const always = levels.some((l) => l.level === "full");
                return (
                  <li key={bot.id}>
                    <button type="button" onClick={() => setSharing(bot)} className="flex w-full items-center gap-3 rounded-xl py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                      <BotAvatar bot={{ ...bot, primary: false }} size={32} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14.5px] font-medium">{bot.name}</span>
                        <span className="block truncate text-[13px] text-muted-foreground">{levels.map((l) => `${nameOf(l.memberId)}: ${SPACE_LEVEL_LABELS[l.level].label}`).join(" · ")}</span>
                      </span>
                      {always ? <Badge tone="warn">Always allow</Badge> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[13px] text-muted-foreground">{joined.length ? "None yet." : "Once someone has joined, you can share bots with them."}</p>
          )}
        </CardContent>
        <CardFooter>
          <Button variant="outline" disabled={!joined.length || !shareable.length} onClick={() => setPicking(true)}>
            <Plus data-icon="inline-start" aria-hidden="true" />
            Share a bot
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>End the household</CardTitle>
          <CardDescription>Everyone keeps their bots and chats, and goes back to needing an AI of their own.</CardDescription>
        </CardHeader>
        <CardFooter>
          <Button variant="destructive" onClick={() => setEnding(true)}>
            <Trash2 data-icon="inline-start" aria-hidden="true" />
            End {household.name}
          </Button>
        </CardFooter>
      </Card>

      {adding ? <AddPersonDialog candidates={data.candidates ?? []} onClose={() => setAdding(false)} onChange={onChange} /> : null}
      {picking ? (
        <PickBotDialog
          bots={shareable}
          onClose={() => setPicking(false)}
          onPick={(bot) => {
            setPicking(false);
            setSharing(bot);
          }}
        />
      ) : null}
      {sharing ? <ShareDialog bot={sharing} household={household} onClose={() => setSharing(null)} onChange={onChange} /> : null}
      <Confirm
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing?.status === "asked" ? `Take back the ask to ${removing?.name ?? "them"}?` : `Remove ${removing?.name ?? "them"} from ${household.name}?`}
        description="Their bots and chats stay theirs. They stop running on the household's AI, and their bots can't ask yours any more."
        action={removing?.status === "asked" ? "Take it back" : "Remove"}
        onConfirm={() => removing && del<{ household: Household }>(`/api/household/members/${encodeURIComponent(removing.id)}`).then((d) => onChange(d.household))}
      />
      <Confirm
        open={ending}
        onOpenChange={setEnding}
        title={`End ${household.name}?`}
        description="Everyone in it keeps their bots and chats, and needs an AI of their own again. Shared bots stop being shared."
        action="End it"
        onConfirm={() => del("/api/household")}
      />
    </>
  );
}

/** The AI every member runs on: one of the head's API keys and a model, never a plan. */
function MembersAiCard({ household, keys, onChange }: { household: Household; keys: KeyProviderKind[]; onChange: (household: Household) => void }) {
  const [ai, setAi] = useState(household.ai);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changed = ai.engine !== household.ai.engine || ai.provider !== household.ai.provider || ai.model !== household.ai.model;
  const choices = [
    ...keys.map((kind) => ({ value: `api:${kind}`, label: PROVIDER_LABELS[kind].name })),
    // Claude Code speaks only Anthropic's API, so it is offered on the Anthropic-compatible one alone.
    ...(keys.includes("anthropic") ? [{ value: "claude:anthropic", label: `Claude Code on the ${PROVIDER_LABELS.anthropic.name}` }] : []),
  ];
  const current = `${ai.engine}:${ai.provider}`;

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onChange((await patch<{ household: Household }>("/api/household", { ai })).household);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the household's AI.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Members&apos; AI</CardTitle>
        <CardDescription>What everyone else&apos;s bots run on, and your shared bots when they do errands for them. It uses your keys, never your plan; your own bots keep running on what you chose under Settings → AI.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={save}>
          <FieldGroup>
            <Field>
              <FieldTitle id="household-ai-key">Runs on</FieldTitle>
              <Select
                items={choices}
                value={current}
                onValueChange={(value) => {
                  if (!value) return;
                  const [engine, provider] = value.split(":") as ["api" | "claude", KeyProviderKind];
                  setAi({ ...ai, engine, provider });
                }}
              >
                <SelectTrigger aria-labelledby="household-ai-key" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {choices.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {choice.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Pick from the APIs you added under <Link href={settingsHref("ai")} className="underline underline-offset-2">Settings → AI</Link>. Claude Code works only with the Anthropic-compatible API.
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="household-ai-model">Model</FieldLabel>
              <Input id="household-ai-model" value={ai.model} onChange={(e) => setAi({ ...ai, model: e.target.value.trim() })} placeholder={ai.provider === "anthropic" ? "claude-sonnet-5-5" : ai.provider === "openai" ? "gpt-5" : "grok-4"} autoComplete="off" spellCheck={false} />
              <FieldDescription>{household.aiReady ? "Working." : "Members' bots can't answer until a model is picked."}</FieldDescription>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <Button type="submit" variant="tint" className="self-start" disabled={!changed || !ai.model || busy}>
              Save
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

function AddPersonDialog({ candidates, onClose, onChange }: { candidates: Candidate[]; onClose: () => void; onChange: (household: Household) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function ask(person: Candidate) {
    setBusy(person.id);
    try {
      onChange((await post<{ household: Household }>("/api/household/members", { personId: person.id })).household);
      onClose();
    } catch (failure) {
      failed(`Couldn't ask ${person.name}.`)(failure);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add someone</DialogTitle>
          <DialogDescription>People who&apos;ve signed in to this Gond through your sign-in provider. They&apos;re asked before they join.</DialogDescription>
        </DialogHeader>
        <div className="dialog-body">
          {candidates.length ? (
            <ul className="flex flex-col divide-y">
              {candidates.map((person) => (
                <li key={person.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <PersonAvatar name={person.name} avatar={person.image} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium">{person.name}</span>
                    <span className="block truncate text-[13px] text-muted-foreground">{person.email}</span>
                  </span>
                  <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void ask(person)}>
                    Ask
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nobody to add yet</EmptyTitle>
                <EmptyDescription>Someone needs to sign in to Gond once through your sign-in provider first. Add them there if they aren&apos;t in it.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PickBotDialog({ bots, onClose, onPick }: { bots: BotRef[]; onClose: () => void; onPick: (bot: BotRef) => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share a bot</DialogTitle>
          <DialogDescription>Pick one of your bots. Next you choose what each member&apos;s bots may have it do.</DialogDescription>
        </DialogHeader>
        <div className="dialog-body">
          <ul className="flex flex-col divide-y">
            {bots.map((bot) => (
              <li key={bot.id}>
                <button type="button" onClick={() => onPick(bot)} className="flex w-full items-center gap-3 rounded-xl py-2.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  <BotAvatar bot={{ ...bot, primary: false }} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium">{bot.name}</span>
                    {bot.title ? <span className="block truncate text-[13px] text-muted-foreground">{bot.title}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What each level lets a member's bots have a shared bot do, said for a household rather than a space. */
const SHARE_BLURBS: Record<SpaceLevel, string> = {
  talk: "Answers from what their bots tell it. No web, no tools.",
  look: "Can also search the web and read pages. Never your accounts, files or the computer.",
  act: "Each request comes to you as a card first. On a yes, it does it with its tools.",
  full: "Does what they ask with its tools and your sign-ins, with no card to you first. An email that goes out and a card payment still ask.",
};

/** One shared bot, and what each member's bots may have it do: the four levels, Always allow confirmed. */
function ShareDialog({ bot, household, onClose, onChange }: { bot: BotRef; household: Household; onClose: () => void; onChange: (household: Household) => void }) {
  const joined = household.members.filter((m) => m.status === "joined");
  const levels = household.shared.find((s) => s.bot.id === bot.id)?.levels ?? [];
  const put = (memberId: string, level: SpaceLevel | null, memory: boolean, confirmed = false) =>
    api<{ household: Household }>(`/api/household/shares/${encodeURIComponent(bot.id)}`, { method: "PUT", body: JSON.stringify({ memberId, level, memory, confirmed }) })
      .then((data) => onChange(data.household))
      .catch(failed("Couldn't change that."));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BotAvatar bot={{ ...bot, primary: false }} size={28} />
            {bot.name}
          </DialogTitle>
          <DialogDescription>Members&apos; bots can ask {bot.name}; members can&apos;t chat with it. Errands show up in your Chats as &quot;{bot.name} · for …&quot;.</DialogDescription>
        </DialogHeader>
        <div className="dialog-body">
          <FieldGroup>
            {joined.map((member) => {
              const share = levels.find((l) => l.memberId === member.id) ?? null;
              const id = `share-${bot.id}-${member.id}`;
              return (
                <Field key={member.id}>
                  <div className="flex items-center gap-3">
                    <PersonAvatar name={member.name} avatar={member.image} size={28} />
                    <FieldTitle id={id} className="min-w-0 flex-1">
                      {member.name}&apos;s bots
                    </FieldTitle>
                    <Switch checked={Boolean(share)} onCheckedChange={(on) => void put(member.id, on ? "act" : null, false)} aria-label={`Share ${bot.name} with ${member.name}`} />
                  </div>
                  {share ? (
                    <>
                      <LevelSelect
                        value={share.level}
                        labelledBy={id}
                        onChange={(level, confirmed) => put(member.id, level, share.memory, confirmed)}
                        blurbs={SHARE_BLURBS}
                        confirm={{
                          title: `Always allow ${bot.name} for ${member.name}'s bots?`,
                          description: `${bot.name} will do whatever ${member.name}'s bots ask, with your sign-ins and on your computer account, including things that change or delete, with no card to you first. You'll only see it afterwards, in "${bot.name} · for ${member.name}". An email that goes out and a card payment still ask you.`,
                        }}
                      />
                      {share.level === "talk" || share.level === "look" ? (
                        <label className="flex items-center justify-between gap-3 text-[13px]">
                          <span>Use what {bot.name} remembers</span>
                          <Switch size="sm" checked={share.memory} onCheckedChange={(on) => void put(member.id, share.level, on)} />
                        </label>
                      ) : null}
                    </>
                  ) : null}
                </Field>
              );
            })}
          </FieldGroup>
        </div>
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

