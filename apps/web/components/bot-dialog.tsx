"use client";

import { APPROVAL_LEVELS, APPROVAL_LEVEL_LABELS, BOT_COLORS, BOT_EXPRESSIONS, BOT_LIMITS, BOT_SHAPES, BOT_SHAPE_LABELS, type Bot, type BotExpression, type BotShape } from "@gond/shared";
import { useRouter } from "next/navigation";
import { Bell, BellOff, ImagePlus, Upload } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { CheckInsFields, useCheckIns } from "@/components/check-ins-fields";
import { useDiscardChanges } from "@/components/discard-changes";
import { GondBot } from "@/components/hq/gond-bot";
import { usePicturePicker } from "@/components/picture-crop-dialog";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useDeviceNotices } from "@/hooks/use-device-notices";
import { cn } from "@/lib/utils";
import { api, del, patch, post } from "@/lib/api";

type Form = {
  name: string;
  title: string;
  description: string;
  color: string;
  expression: BotExpression;
  shape: BotShape;
  approval: (typeof APPROVAL_LEVELS)[number];
  notify: boolean;
};

const APPROVAL_ITEMS = APPROVAL_LEVELS.map((level) => ({ value: level, label: APPROVAL_LEVEL_LABELS[level].title }));

const EMPTY: Form = { name: "", title: "", description: "", color: BOT_COLORS[0], expression: "happy", shape: "cog", approval: "auto", notify: true };

export function BotDialog({ botId, onClose }: { botId: string | null; onClose: () => void }) {
  const { bots, refresh } = useStore();
  const router = useRouter();
  const existing = botId ? bots.find((b) => b.id === botId) ?? null : null;
  const [form, setForm] = useState<Form>(existing ? pick(existing) : EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
  // A new picture waits for Save, like every other change here; null means back to the mascot.
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null | undefined>(undefined);
  const shown = photo === undefined ? (existing?.avatar ?? null) : (photo?.url ?? null);
  const picture = usePicturePicker("The bot's picture", async (blob) => setPhoto({ blob, url: URL.createObjectURL(blob) }));
  useEffect(() => () => void (photo && URL.revokeObjectURL(photo.url)), [photo]);
  // Whether this device hears the bot is the device's, kept apart from the bot and saved with it.
  const device = useDeviceNotices();
  const mutedHere = Boolean(existing && device.notices?.mutedBots.includes(existing.id));
  const [here, setHere] = useState<boolean | null>(null);
  const hereOn = here ?? !mutedHere;
  const hereChanged = here !== null && here === mutedHere;
  // Check-ins are the primary bot's, kept for the profile and saved with the dialog.
  const checkIns = useCheckIns(Boolean(existing?.primary));
  const dirty = photo !== undefined || hereChanged || checkIns.changed || (existing ? JSON.stringify(form) !== JSON.stringify(pick(existing)) : Boolean(form.title.trim() || form.description.trim()));
  const discard = useDiscardChanges(dirty && !busy, onClose);

  useEffect(() => {
    if (!existing) api<{ name: string }>("/api/bots/name").then((d) => setForm((f) => (f.name ? f : { ...f, name: d.name, color: BOT_COLORS[bots.length % BOT_COLORS.length]! }))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const bot = existing ? (await patch<{ bot: Bot }>(`/api/bots/${existing.id}`, form)).bot : (await post<{ bot: Bot }>("/api/bots", form)).bot;
      if (photo) {
        const upload = new FormData();
        upload.append("file", photo.blob, photo.blob.type === "image/gif" ? "picture.gif" : "picture.png");
        await api(`/api/bots/${bot.id}/avatar`, { method: "PUT", body: upload });
      } else if (photo === null && existing?.avatar) {
        await del(`/api/bots/${bot.id}/avatar`);
      }
      if (hereChanged && device.notices) {
        const others = device.notices.mutedBots.filter((id) => id !== bot.id);
        await device.save({ ...device.notices, mutedBots: hereOn ? others : [...others, bot.id] }).catch(() => {
          throw new Error(`Couldn't change ${bot.name}'s notices on ${device.here}. Try again.`);
        });
      }
      if (checkIns.changed) {
        await checkIns.save().catch(() => {
          throw new Error(`Couldn't change ${bot.name}'s check-ins. Try again.`);
        });
      }
      await refresh();
      if (!existing) router.push(`/app/t/${bot.threadId}`);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save.");
      setBusy(false);
    }
  }

  /** A bot someone shared as a .bot file: made as it is, then opened. */
  async function importBot(file: File) {
    setBusy(true);
    setError(null);
    try {
      const upload = new FormData();
      upload.append("file", file, file.name);
      const { bot } = await api<{ bot: Bot }>("/api/bots/import", { method: "POST", body: upload });
      await refresh();
      router.push(`/app/t/${bot.threadId}`);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't import it.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && discard.requestClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.name}` : "Create a bot"}</DialogTitle>
          <DialogDescription>{existing ? "Its look, its job and how much it asks before acting." : "A name, a job, and a way of working. A focused bot beats a catch-all one."}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup className="gap-5">

            <div className="flex flex-col items-center gap-4">
              {shown ? (
                // eslint-disable-next-line @next/next/no-img-element -- a stored or local picture, already square
                <img src={shown} alt="" className="size-26 rounded-full border border-primary-edge object-cover" />
              ) : (
                <GondBot color={form.color} size={104} expression={form.expression} shape={form.shape} />
              )}
              <div className="flex flex-wrap justify-center gap-2">
                <Button type="button" variant="outline" size="lg" onClick={picture.choose} disabled={picture.busy}>
                  <ImagePlus data-icon="inline-start" aria-hidden="true" />
                  {shown ? "Change the picture" : "Upload a picture"}
                </Button>
                {shown ? (
                  <Button type="button" variant="ghost" size="lg" onClick={() => setPhoto(null)}>
                    Use the mascot
                  </Button>
                ) : null}
              </div>
              {picture.elements}
              {shown ? null : (
                <>

                  <RadioGroup aria-label="Color" value={form.color} onValueChange={(value) => typeof value === "string" && set("color", value)} className="flex w-auto flex-wrap justify-center gap-2.5">
                    {BOT_COLORS.map((c) => (
                      <RadioGroupItem key={c} value={c} aria-label={c} className="size-8 border-2 border-transparent bg-(--swatch) ring-control ring-offset-2 ring-offset-card data-checked:border-transparent data-checked:bg-(--swatch) data-checked:ring-2 dark:bg-(--swatch) dark:data-checked:bg-(--swatch) [&>span]:hidden" style={{ "--swatch": c } as React.CSSProperties} />
                    ))}
                  </RadioGroup>
                  <ToggleGroup aria-label="Shape" variant="pill" value={[form.shape]} onValueChange={(v) => v[0] && set("shape", v[0] as BotShape)} spacing={1.5} className="flex-wrap justify-center">
                    {BOT_SHAPES.map((shape) => (
                      <ToggleGroupItem key={shape} value={shape} aria-label={BOT_SHAPE_LABELS[shape]} title={BOT_SHAPE_LABELS[shape]} className="size-12 p-0">
                        <GondBot color={form.color} size={30} expression="happy" shape={shape} greet={false} label={BOT_SHAPE_LABELS[shape]} />
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <ToggleGroup aria-label="Expression" variant="pill" value={[form.expression]} onValueChange={(v) => v[0] && set("expression", v[0] as BotExpression)} spacing={1.5} className="flex-wrap justify-center">
                    {BOT_EXPRESSIONS.map((e) => (
                      <ToggleGroupItem key={e} value={e} className="px-3.5">
                        {e}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </>
              )}
            </div>

            <FieldGroup className="gap-3">
              <Field>
                <FieldLabel htmlFor="bot-name">Name</FieldLabel>
                <Input id="bot-name" value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={BOT_LIMITS.name} />
              </Field>
              <Field>
                <FieldLabel htmlFor="bot-title">Job</FieldLabel>
                <Input id="bot-title" value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={BOT_LIMITS.title} placeholder="Sales Outbound, Inbox Manager, Assistant…" />
              </Field>
            </FieldGroup>

            <Field>
              <FieldLabel htmlFor="bot-description">Instructions</FieldLabel>
              <div className="relative">
                <Textarea id="bot-description" value={form.description} onChange={(e) => set("description", e.target.value)} rows={5} maxLength={BOT_LIMITS.description} aria-describedby="bot-description-count" placeholder="What it owns, what it must ask before doing, and what it returns." className="max-h-72 pb-7" />
                <span id="bot-description-count" className={cn("pointer-events-none absolute right-3 bottom-2 text-[11.5px] text-muted-foreground tabular-nums", form.description.length >= BOT_LIMITS.description * 0.9 && "text-tone-warn")}>
                  {form.description.length.toLocaleString()} / {BOT_LIMITS.description.toLocaleString()}
                </span>
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="bot-approval">Approvals</FieldLabel>
              <Select items={APPROVAL_ITEMS} value={form.approval} onValueChange={(value) => value && set("approval", value as Form["approval"])}>
                <SelectTrigger id="bot-approval" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {APPROVAL_LEVELS.map((level) => (
                      <SelectItem key={level} value={level}>
                        {APPROVAL_LEVEL_LABELS[level].title}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>{APPROVAL_LEVEL_LABELS[form.approval].detail} Every bot runs on the model chosen under Settings. Any bot can add teammates and hand work to them; your primary bot is the one that coordinates.</FieldDescription>
            </Field>

            <div className="flex flex-col divide-y border-y">
              <BellField title="Notify me" label={`Notify me about ${form.name.trim() || "this bot"}`} pressed={form.notify} onPressedChange={(on) => set("notify", on)} />
              {existing && device.notices ? (
                <BellField title={`On ${device.here}`} label={`${existing.name}'s notices on ${device.here}`} pressed={form.notify && hereOn} disabled={!form.notify} onPressedChange={setHere} />
              ) : null}
            </div>

            {existing?.primary ? <CheckInsFields name={form.name.trim() || existing.name} state={checkIns} /> : null}

            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              {existing ? null : (
                <Button type="button" variant="ghost" disabled={busy} render={<label />} nativeButton={false} className="cursor-pointer sm:mr-auto">
                  <Upload data-icon="inline-start" aria-hidden="true" />
                  Import a .bot file
                  <input type="file" accept=".bot,application/zip" className="sr-only" onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void importBot(file);
                  }} />
                </Button>
              )}
              <Button type="button" variant="outline" onClick={discard.requestClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy ? "Saving…" : existing ? "Save" : "Create bot"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
      {discard.prompt}
    </Dialog>
  );
}

function pick(bot: Bot): Form {
  return { name: bot.name, title: bot.title, description: bot.description, color: bot.color, expression: bot.expression, shape: bot.shape, approval: bot.approval, notify: bot.notify };
}

/** A notice setting as a bell: rung when on, struck through when off. */
function BellField({ title, label, pressed, disabled = false, onPressedChange }: { title: string; label: string; pressed: boolean; disabled?: boolean; onPressedChange: (pressed: boolean) => void }) {
  return (
    <Field orientation="horizontal" data-disabled={disabled || undefined} className="min-h-15">
      <FieldTitle className="flex-1">{title}</FieldTitle>
      <Toggle variant="bell" size="icon" pressed={pressed} disabled={disabled} onPressedChange={onPressedChange} aria-label={label}>
        {pressed ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />}
      </Toggle>
    </Field>
  );
}
