"use client";

import { roomAnswerer, roomNameFor, type Bot, type Thread } from "@gond/shared";
import { Check, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { BotAvatar, RoomAvatar } from "@/components/bot-avatar";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { patch, post } from "@/lib/api";

// Past this many bots, a field narrows the faces by name or job.
const SEARCH_FROM = 12;

function matches(bot: Bot, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || bot.name.toLowerCase().includes(q) || bot.title.toLowerCase().includes(q);
}

function BotTile({ bot, on, onChange }: { bot: Bot; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <Toggle variant="tile" size="tile" pressed={on} onPressedChange={onChange} aria-label={bot.title ? `${bot.name}, ${bot.title}` : bot.name}>
      <span data-slot="tile-face">
        <BotAvatar bot={bot} size={56} />
        <span data-slot="tile-check" aria-hidden="true" className="absolute -top-0.5 -right-0.5 size-5 items-center justify-center rounded-full bg-tint-solid text-tint-foreground ring-2 ring-(--surface)">
          <Check className="size-3" strokeWidth={3} />
        </span>
      </span>
      <span className="w-full truncate text-[13px] leading-4">{bot.name}</span>
      <span className="-mt-1 w-full truncate text-[11px] leading-3.5 font-normal text-muted-foreground">{bot.title || " "}</span>
    </Toggle>
  );
}

/** A new room, or an existing one (`threadId`) renamed and its bots changed. */
export function RoomDialog({ threadId = null, onClose }: { threadId?: string | null; onClose: () => void }) {
  const { bots, threads, refresh } = useStore();
  const router = useRouter();
  const existing = threadId ? (threads.find((t) => t.id === threadId && t.kind === "room") ?? null) : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [members, setMembers] = useState<string[]>(existing ? existing.members : bots.filter((b) => b.primary).map((b) => b.id));
  const [query, setQuery] = useState("");
  // The bots already in it come first, in the order they had when it opened, so a tap never moves a face.
  const [first] = useState(() => new Set(existing ? existing.members : []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // In the room's own order, as the API reads it: with no primary among them, the first one answers when nobody is named.
  const picked = members.flatMap((id) => bots.find((b) => b.id === id) ?? []);
  const answerer = picked.length > 1 ? roomAnswerer(picked) : null;
  const many = bots.length > SEARCH_FROM;
  const shown = [...bots.filter((b) => first.has(b.id)), ...bots.filter((b) => !first.has(b.id))].filter((b) => matches(b, query));
  const summary = picked.length === 0 ? "Pick at least one bot." : `${picked.length} ${picked.length === 1 ? "bot" : "bots"}${answerer ? ` · ${answerer.name} answers when nobody is named` : ""}`;
  const search = (
    <InputGroup>
      <InputGroupAddon>
        <Search aria-hidden="true" />
      </InputGroupAddon>
      <InputGroupInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a bot" aria-label="Find a bot" />
      {query ? (
        <InputGroupAddon align="inline-end">
          <InputGroupButton size="icon-xs" aria-label="Clear" onClick={() => setQuery("")}>
            <X />
          </InputGroupButton>
        </InputGroupAddon>
      ) : null}
    </InputGroup>
  );
  const toggle = (id: string, on: boolean) => setMembers((current) => (on ? [...current.filter((m) => m !== id), id] : current.filter((m) => m !== id)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await patch<{ thread: Thread }>(`/api/rooms/${existing.id}`, { name: name.trim(), members });
        await refresh();
      } else {
        const { thread } = await post<{ thread: Thread }>("/api/rooms", { name: name.trim(), members });
        await refresh();
        router.push(`/app/t/${thread.id}`);
      }
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : existing ? "Couldn't save the room." : "Couldn't create the room.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.name}` : "New room"}</DialogTitle>
          <DialogDescription>{existing ? "Rename it, or change which bots are in it. The conversation stays as it is." : "Tap the bots to put in it. They hand work to each other and bring you in when they need a decision."}</DialogDescription>
          {/* With many bots the header, which stays put, holds the search and the count, so neither scrolls away. */}
          {many ? (
            <div className="mt-2 -mr-12 flex flex-col gap-2">
              {search}
              <p className="text-center text-[12.5px] text-muted-foreground" aria-live="polite">
                {summary}
              </p>
            </div>
          ) : null}
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup className="gap-5">
            <Field className="items-center">
              <RoomAvatar bots={picked} size={72} />
              <FieldLabel htmlFor="room-name" className="sr-only">
                Name
              </FieldLabel>
              <Input id="room-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder={picked.length ? roomNameFor(picked) : "Name"} className="text-center" />
              <FieldDescription className="text-center">Leave it empty to name it after its bots.</FieldDescription>
            </Field>
            <FieldSet>
              <FieldLegend variant="label" className="sr-only">
                Bots
              </FieldLegend>
              {shown.length ? (
                <div role="group" aria-label="Bots" className="grid grid-cols-3 gap-x-1 gap-y-1 min-[360px]:grid-cols-4">
                  {shown.map((b) => (
                    <BotTile key={b.id} bot={b} on={members.includes(b.id)} onChange={(on) => toggle(b.id, on)} />
                  ))}
                </div>
              ) : (
                <Empty className="py-6">
                  <EmptyHeader>
                    <EmptyTitle>No bots match</EmptyTitle>
                    <EmptyDescription>Try a name or a job, like &quot;servers&quot;.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {many ? null : (
                <p className="text-center text-[12.5px] text-muted-foreground" aria-live="polite">
                  {summary}
                </p>
              )}
            </FieldSet>
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" variant="tint" disabled={busy || members.length === 0}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {existing ? (busy ? "Saving…" : "Save") : busy ? "Creating…" : "Create room"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
