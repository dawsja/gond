"use client";

import { ACCENTS, MAX_PROFILES, PROFILE_ICONS, type Accent, type Profile } from "@gond/shared";
import { Check, Ellipsis, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Confirm } from "@/components/confirm-dialog";
import { failed } from "@/components/failed";
import { useStore } from "@/components/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { del, patch, post } from "@/lib/api";
import { cn } from "@/lib/utils";

/** "Aa" stands for the first letter of the name, before there is one. */
const LETTER = "Aa";

/** A profile's mark: its emoji, or the first letter of its name, in the middle of its own colour. */
export function ProfileMark({ profile, size = 40, className }: { profile: Pick<Profile, "label" | "accent" | "icon">; size?: number; className?: string }) {
  const letter = profile.label.trim().charAt(0).toUpperCase() || LETTER;
  return (
    <span
      aria-hidden="true"
      data-mark={profile.accent}
      className={cn("inline-flex shrink-0 items-center justify-center rounded-full bg-(--mark) leading-none font-semibold text-tint-foreground", className)}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * (profile.icon ? 0.52 : letter === LETTER ? 0.36 : 0.42))) }}
    >
      {/* Emoji fonts set their glyphs about 0.06em low in the line, so the icon is lifted to the circle's middle. */}
      {profile.icon ? <span className="-translate-y-[0.06em]">{profile.icon}</span> : letter}
    </span>
  );
}

/** The first letter, or one of the five icons: tap the picked icon again to go back to the letter. */
function IconField({ icon, onChange, preview }: { icon: string | null; onChange: (icon: string | null) => void; preview: Pick<Profile, "label" | "accent"> }) {
  return (
    <Field>
      <FieldLabel>Icon</FieldLabel>
      <div className="flex items-center gap-4">
        <ProfileMark profile={{ ...preview, icon }} size={56} />
        <ToggleGroup variant="pill" size="sm" value={[icon ?? LETTER]} onValueChange={(value) => onChange(value[0] && value[0] !== LETTER ? value[0] : null)} aria-label="Icon" className="flex-wrap">
          <ToggleGroupItem value={LETTER} aria-label="First letter" className="text-[13px] font-semibold">
            {LETTER}
          </ToggleGroupItem>
          {PROFILE_ICONS.map((emoji) => (
            <ToggleGroupItem key={emoji} value={emoji} aria-label={emoji} className="text-[17px]">
              {emoji}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <FieldDescription>Aa shows the first letter of its name. Or pick an icon for the middle of its circle.</FieldDescription>
    </Field>
  );
}

/** The colour the server gives a new profile: the first none of the others wears. */
function nextAccent(profiles: Profile[]): Accent {
  return ACCENTS.find((accent) => !profiles.some((p) => p.accent === accent)) ?? ACCENTS[0];
}

/** Opens a profile on this device. Everything on the page belongs to the one it leaves, so the app starts over. */
export async function openProfile(id: string) {
  await post(`/api/profiles/${encodeURIComponent(id)}/open`);
  // A full load on purpose: nothing of the old profile may stay in memory, the store's or the router's.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign("/app");
}

/** What another profile has waiting, said short; nothing when there's nothing. */
export function waitingLine(profile: Profile): string {
  if (profile.needsYou > 0) return "Needs you";
  if (profile.unread > 0) return profile.unread === 1 ? "1 chat with something new" : `${profile.unread} chats with something new`;
  return "";
}

/** Whether a profile other than the open one has something waiting, for the dot on your picture. */
export function useOthersWaiting(): boolean {
  const { me, profiles } = useStore();
  return profiles.some((p) => p.id !== me.profile.id && (p.unread > 0 || p.needsYou > 0));
}

/** The person's profiles from their picture: open one, add one, or go to Settings. */
export function ProfilesDialog({ onClose }: { onClose: () => void }) {
  const { me, profiles } = useStore();
  const [opening, setOpening] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (adding) return <AddProfileDialog onClose={() => setAdding(false)} />;

  function open(profile: Profile) {
    if (profile.id === me.profile.id) return onClose();
    setOpening(profile.id);
    void openProfile(profile.id).catch((failure: unknown) => {
      setOpening(null);
      failed(`Couldn't open ${profile.label}.`)(failure);
    });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Profiles</DialogTitle>
          <DialogDescription>Each one has its own bots, chats, keys and computer.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {profiles.length === 0 ? <Skeleton className="h-16 rounded-2xl" /> : null}
          {profiles.map((profile) => {
            const here = profile.id === me.profile.id;
            const waiting = here ? "" : waitingLine(profile);
            return (
              <Button key={profile.id} variant="ghost" onClick={() => open(profile)} disabled={opening !== null} aria-current={here ? "true" : undefined} className={cn("h-16 w-full justify-start gap-3 rounded-2xl px-3 text-left", here && "bg-muted")}>
                <ProfileMark profile={profile} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[16px] font-semibold">{profile.label}</span>
                  {here || waiting || profile.muted ? <span className="truncate text-[13px] font-normal text-muted-foreground">{here ? "Current" : waiting || "Notifications off"}</span> : null}
                </span>
                {opening === profile.id ? <Spinner /> : here ? <Check aria-label="Current" className="size-5" /> : profile.unread + profile.needsYou > 0 ? <span className="min-w-6 rounded-full bg-control px-2 text-center text-[12px] leading-6 font-semibold text-control-foreground tabular-nums">{profile.unread + profile.needsYou}</span> : null}
              </Button>
            );
          })}
        </div>
        <div className="flex flex-col gap-1 border-t pt-3">
          {profiles.length > 0 && profiles.length < MAX_PROFILES ? (
            <Button variant="ghost" onClick={() => setAdding(true)} className="h-12 w-full justify-start gap-3 rounded-2xl px-3">
              <Plus data-icon="inline-start" aria-hidden="true" />
              Add a profile
            </Button>
          ) : null}
          <Button variant="ghost" render={<Link href="/app/settings" onClick={onClose} />} nativeButton={false} className="h-12 w-full justify-start gap-3 rounded-2xl px-3">
            <Settings data-icon="inline-start" aria-hidden="true" />
            Settings
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A new profile starts empty, as a new person does, and opens here once it's made. */
export function AddProfileDialog({ onClose }: { onClose: () => void }) {
  const { profiles } = useStore();
  const [label, setLabel] = useState("");
  const [icon, setIcon] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { profile } = await post<{ profile: Profile }>("/api/profiles", { label, icon });
      await openProfile(profile.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't add the profile.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a profile</DialogTitle>
          <DialogDescription>It starts empty: no bots, chats, keys or apps, and a computer account of its own. You set up its AI the first time you use it.</DialogDescription>
        </DialogHeader>
        <form id="add-profile" onSubmit={submit}>
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="profile-label">Name</FieldLabel>
              <Input id="profile-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work" maxLength={24} aria-invalid={error ? true : undefined} />
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <IconField icon={icon} onChange={setIcon} preview={{ label, accent: nextAccent(profiles) }} />
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button size="lg" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="lg" variant="tint" type="submit" form="add-profile" disabled={busy || !label.trim()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Add and open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditProfileDialog({ profile, onClose }: { profile: Profile; onClose: () => void }) {
  const [label, setLabel] = useState(profile.label);
  const [icon, setIcon] = useState<string | null>(profile.icon);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await patch(`/api/profiles/${encodeURIComponent(profile.id)}`, { label, icon });
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the profile.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {profile.label}</DialogTitle>
        </DialogHeader>
        <form id="edit-profile" onSubmit={submit}>
          <FieldGroup>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="profile-rename">Name</FieldLabel>
              <Input id="profile-rename" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={24} aria-invalid={error ? true : undefined} />
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
            <IconField icon={icon} onChange={setIcon} preview={{ label: label.trim() || profile.label, accent: profile.accent }} />
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button size="lg" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="lg" variant="tint" type="submit" form="edit-profile" disabled={busy || !label.trim() || (label.trim() === profile.label && icon === profile.icon)}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Settings → Profiles: each profile's notifications, renaming and deleting, and adding one. */
export function ProfilesCard() {
  const { me, profiles } = useStore();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);

  async function setNotify(profile: Profile, on: boolean) {
    await patch(`/api/profiles/${encodeURIComponent(profile.id)}`, { muted: !on }).catch(failed(on ? "Couldn't turn notifications on." : "Couldn't turn notifications off."));
  }

  async function remove(profile: Profile) {
    await del(`/api/profiles/${encodeURIComponent(profile.id)}`);
    setDeleting(null);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profiles</CardTitle>
        <CardDescription>Each profile is a world of its own: its bots, chats, memories, skills, secrets, apps, AI and its own account on the computer. Your name, time zone and the devices you get notifications on are shared. Switch from your picture.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        {profiles.length === 0 ? <Skeleton className="h-14 rounded-xl" /> : null}
        {profiles.map((profile) => (
          <div key={profile.id} className="flex min-h-14 items-center gap-3 rounded-xl py-1.5">
            <ProfileMark profile={profile} size={36} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex items-center gap-2">
                <span className="truncate text-[15px] font-medium">{profile.label}</span>
                {profile.id === me.profile.id ? <Badge variant="secondary">Current</Badge> : null}
              </span>
              <span className="text-[12.5px] text-muted-foreground">{profile.muted ? "Notifications off" : "Notifications on"}</span>
            </span>
            <Switch checked={!profile.muted} onCheckedChange={(on) => void setNotify(profile, on)} aria-label={`Notifications from ${profile.label}`} />
            {/* The default goes only with the person, so it can be edited but never deleted. */}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`${profile.label}'s options`} />}>
                <Ellipsis aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => setEditing(profile)}>
                    <Pencil aria-hidden="true" />
                    Edit
                  </DropdownMenuItem>
                  {profile.isDefault ? null : (
                    <DropdownMenuItem variant="destructive" onClick={() => setDeleting(profile)}>
                      <Trash2 aria-hidden="true" />
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </CardContent>
      <CardFooter>
        <Button variant="outline" onClick={() => setAdding(true)} disabled={profiles.length === 0 || profiles.length >= MAX_PROFILES}>
          <Plus data-icon="inline-start" aria-hidden="true" />
          {profiles.length >= MAX_PROFILES ? `Up to ${MAX_PROFILES} profiles` : "Add a profile"}
        </Button>
      </CardFooter>

      {adding ? <AddProfileDialog onClose={() => setAdding(false)} /> : null}
      {editing ? <EditProfileDialog profile={editing} onClose={() => setEditing(null)} /> : null}
      <Confirm
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.label ?? "this profile"}?`}
        description={`This deletes everything in ${deleting?.label ?? "it"}: its bots, chats, rooms, routines, memories, skills, secrets, cards, sign-ins, connected apps, MCP servers, AI sign-ins and keys, usage, and its computer account with every file on it. Rooms it shares with other Gonds are left. This can't be undone.`}
        action={`Delete ${deleting?.label ?? "it"}`}
        onConfirm={() => deleting && remove(deleting)}
      />
    </Card>
  );
}
