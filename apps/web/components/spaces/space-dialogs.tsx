"use client";

import type { Bot, SpaceInvitePreview, Thread } from "@gond/shared";
import { Check, ChevronDown, Copy, Lock } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { BotAvatar, PersonAvatar } from "@/components/bot-avatar";
import { copyToClipboard } from "@/components/hq/clipboard";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { openShellDialog } from "@/components/shell";
import { post } from "@/lib/api";
import { settingsHref } from "@/lib/settings-sections";

const EXPIRY_ITEMS = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
];

/** The six words both people read out, so neither key was swapped on the way. */
export function Words({ words }: { words: string[] }) {
  return (
    <span className="flex flex-wrap gap-1.5 font-mono text-[13px]">
      {words.map((word, i) => (
        <span key={`${word}-${i}`} className="rounded-lg bg-muted px-2 py-0.5">
          {word}
        </span>
      ))}
    </span>
  );
}

/** A link that brings someone on another Gond into this room, which becomes a space. */
export function InviteSpaceDialog({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const { refresh } = useStore();
  const [days, setDays] = useState("7");
  const [invite, setInvite] = useState<{ link: string; words: string[]; expires: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function make() {
    setBusy(true);
    setError(null);
    try {
      const { invite: made } = await post<{ invite: { link: string; words: string[]; expires: string } }>("/api/spaces/invites", { threadId, days: Number(days) });
      setInvite(made);
      void refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't make the invite.");
    } finally {
      setBusy(false);
    }
  }

  const copy = () => invite && void copyToClipboard(invite.link).then((ok) => toast.add(ok ? { title: "Copied." } : { type: "error", title: "Couldn't copy it. Select the link and copy it yourself." }));

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite someone to this space</DialogTitle>
          <DialogDescription>They paste the link into their own Gond. It works once, and their bots join on Talk only until you change it.</DialogDescription>
        </DialogHeader>
        <FieldGroup className="gap-5">
          {invite ? (
            <>
              <Field>
                <FieldLabel htmlFor="space-invite-link">The link</FieldLabel>
                <div className="flex gap-2">
                  <Input id="space-invite-link" readOnly value={invite.link} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12.5px]" />
                  <Button variant="outline" onClick={copy} className="h-auto self-stretch">
                    <Copy data-icon="inline-start" aria-hidden="true" />
                    Copy
                  </Button>
                </div>
                <FieldDescription>Stops working {new Date(invite.expires).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, or once it&apos;s used.</FieldDescription>
              </Field>
              <Field>
                <FieldTitle>Check these words with them</FieldTitle>
                <Words words={invite.words} />
                <FieldDescription>If their screen shows the same six words, you&apos;re talking to each other and nobody in between.</FieldDescription>
              </Field>
            </>
          ) : (
            <Field orientation="horizontal">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <FieldTitle id="space-invite-days">Expires</FieldTitle>
                <FieldDescription>Unused, the link stops working after this.</FieldDescription>
              </div>
              <Select items={EXPIRY_ITEMS} value={days} onValueChange={(value) => value && setDays(value)}>
                <SelectTrigger aria-labelledby="space-invite-days" className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {EXPIRY_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          )}
          {error ? <FieldError>{error}</FieldError> : null}
          <DialogFooter>
            {invite ? (
              <Button variant="tint" onClick={onClose}>
                Done
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="tint" disabled={busy} onClick={() => void make()}>
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  Make the link
                </Button>
              </>
            )}
          </DialogFooter>
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
}

/** Picks several of the person's bots from a dropdown, ticking each. */
export function BotPicker({ bots, picked, onChange, labelledBy, empty = "No bots" }: { bots: Bot[]; picked: string[]; onChange: (ids: string[]) => void; labelledBy?: string; empty?: string }) {
  const chosen = bots.filter((b) => picked.includes(b.id));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" aria-labelledby={labelledBy} className="w-full justify-between font-normal" />}>
        <span className="flex min-w-0 items-center gap-2">
          {chosen.slice(0, 3).map((b) => (
            <BotAvatar key={b.id} bot={b} size={20} />
          ))}
          <span className="truncate">{chosen.length ? chosen.map((b) => b.name).join(", ") : empty}</span>
        </span>
        <ChevronDown className="text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      {/* Eight rows, then it scrolls: a row and the padding as `ui/dropdown-menu.tsx` draws them on each pointer. */}
      <DropdownMenuContent align="start" className="max-h-[min(var(--available-height),calc(8*2.25rem_+_0.75rem_+_2px))] min-w-(--anchor-width) pointer-coarse:max-h-[min(var(--available-height),calc(8*3rem_+_1.25rem_+_2px))]">
        <DropdownMenuGroup>
          {bots.map((b) => (
            <DropdownMenuCheckboxItem key={b.id} checked={picked.includes(b.id)} closeOnClick={false} onCheckedChange={(on) => onChange(on ? [...picked, b.id] : picked.filter((id) => id !== b.id))}>
              <BotAvatar bot={b} size={20} />
              {b.name}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** None of the person's bots may join a space until they pick which in Settings → Spaces. */
function NoBotsYet() {
  return (
    <>
      None of your bots may join spaces yet, so it&apos;s just you.{" "}
      <Link href={settingsHref("spaces")} className="underline underline-offset-2">
        Pick which may
      </Link>
      .
    </>
  );
}

/** Starts a space here, with the bots picked, and offers its first invite. */
export function NewSpaceDialog({ allowed, onClose }: { allowed: string[] | null; onClose: () => void }) {
  const { bots, refresh } = useStore();
  const router = useRouter();
  const mine = bots.filter((b) => !b.hidden && (!allowed || allowed.includes(b.id)));
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { thread } = await post<{ thread: Thread }>("/api/spaces", { name, botIds: picked });
      await refresh();
      router.push(`/app/t/${thread.id}`);
      onClose();
      openShellDialog({ kind: "invite-space", threadId: thread.id });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't start the space.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>A room you share with people on other Gonds, and their bots. You invite them next.</DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void create(e)}>
          <FieldGroup className="gap-5">
            <Field>
              <FieldLabel htmlFor="space-name">Name</FieldLabel>
              <Input id="space-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Trip planning" />
            </Field>
            <Field>
              <FieldTitle id="space-new-bots">Your bots in it</FieldTitle>
              {mine.length ? <BotPicker bots={mine} picked={picked} onChange={setPicked} labelledBy="space-new-bots" empty="Just you" /> : null}
              <FieldDescription>{mine.length ? "They answer only when someone names them." : <NoBotsYet />}</FieldDescription>
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="tint" disabled={busy}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                Start the space
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Pastes an invite from another Gond, shows whose it is and who's there, and joins with the bots picked. */
export function JoinSpaceDialog({ link: given = "", allowed, onClose }: { link?: string; allowed: string[] | null; onClose: () => void }) {
  const { bots, refresh } = useStore();
  const router = useRouter();
  const [link, setLink] = useState(given);
  const [preview, setPreview] = useState<SpaceInvitePreview | null>(null);
  const mine = bots.filter((b) => !b.hidden && (!allowed || allowed.includes(b.id)));
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { preview: seen } = await post<{ preview: SpaceInvitePreview }>("/api/spaces/preview", { link });
      setPreview(seen);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't read that invite.");
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const { thread } = await post<{ thread: Thread }>("/api/spaces/join", { link, botIds: picked });
      await refresh();
      router.push(`/app/t/${thread.id}`);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't join the space.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{preview ? `Join ${preview.name}?` : "Join a space"}</DialogTitle>
          <DialogDescription>{preview ? `${preview.host.name} invites you.` : "Paste the invite someone on another Gond sent you."}</DialogDescription>
        </DialogHeader>
        {preview ? (
          <FieldGroup className="gap-5">
            {preview.members.length ? (
              <Field>
                <FieldTitle>Already there</FieldTitle>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  {preview.members.map((m, i) => (
                    <span key={`${m.name}-${i}`} className="flex items-center gap-1.5 text-[13.5px]">
                      {m.kind === "bot" ? <BotAvatar bot={{ name: m.name, title: "", color: m.color ?? "#8f8b84", expression: "happy", primary: false }} size={22} /> : <PersonAvatar name={m.name} avatar={null} size={22} />}
                      {m.name}
                    </span>
                  ))}
                </div>
              </Field>
            ) : null}
            <Field>
              <FieldTitle id="space-join-bots">Which of your bots join?</FieldTitle>
              {mine.length ? <BotPicker bots={mine} picked={picked} onChange={setPicked} labelledBy="space-join-bots" empty="Just you" /> : null}
              <FieldDescription>{mine.length ? "They join on your default for spaces. Change it in the space's details." : <NoBotsYet />}</FieldDescription>
            </Field>
            <Field>
              <FieldTitle>
                <Lock className="size-3.5" aria-hidden="true" /> {preview.host.name} should see the same words
              </FieldTitle>
              <Words words={preview.host.words} />
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Not now
              </Button>
              <Button variant="tint" disabled={busy} onClick={() => void join()}>
                {busy ? <Spinner data-icon="inline-start" /> : <Check data-icon="inline-start" aria-hidden="true" />}
                Join
              </Button>
            </DialogFooter>
          </FieldGroup>
        ) : (
          <form onSubmit={(e) => void check(e)}>
            <FieldGroup className="gap-5">
              <Field>
                <FieldLabel htmlFor="space-join-link">Invite</FieldLabel>
                <Textarea id="space-join-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://their-gond.example/join#…" rows={3} className="max-h-32 font-mono text-[12.5px]" />
              </Field>
              {error ? <FieldError>{error}</FieldError> : null}
              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" variant="tint" disabled={busy || !link.trim()}>
                  {busy ? <Spinner data-icon="inline-start" /> : null}
                  Check it
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
