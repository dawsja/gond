"use client";

import { Camera } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PersonAvatar } from "@/components/bot-avatar";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, del } from "@/lib/api";
import { usePicturePicker } from "@/components/picture-crop-dialog";
import { authClient } from "@/lib/auth/client";
import type { SessionUser } from "@/lib/session";

export function AccountSection({ user }: { user: SessionUser }) {
  const { me, setMe } = useStore();
  const local = me.provider === "local";
  void user;

  const picture = usePicturePicker("Your picture", async (blob) => {
    const form = new FormData();
    form.append("file", blob, blob.type === "image/gif" ? "avatar.gif" : "avatar.png");
    const data = await api<{ avatar: string }>("/api/me/avatar", { method: "PUT", body: form });
    setMe({ ...me, avatar: data.avatar });
    toast.add({ type: "success", title: "Picture updated." });
  });

  async function removePicture() {
    await del("/api/me/avatar").catch(() => undefined);
    setMe({ ...me, avatar: null });
  }
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changePassword(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (next.length < 12) return setError("Use a new password of at least 12 characters.");
    if (next !== confirm) return setError("The new passwords don't match.");
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.changePassword({ currentPassword: current, newPassword: next, revokeOtherSessions: true });
    setBusy(false);
    if (failure) {
      setError(failure.status === 429 ? "Too many attempts. Wait a minute and try again." : failure.message || "That current password doesn't match.");
      return;
    }
    setCurrent("");
    setNext("");
    setConfirm("");
    toast.add({ type: "success", title: "Password changed.", description: "Other sessions were signed out." });
  }

  return (
    <Card>
      <CardHeader className="grid-cols-[auto_1fr_auto] items-center gap-x-3">

        <Tooltip>
          <TooltipTrigger
            render={<button type="button" onClick={picture.choose} disabled={picture.busy} aria-label={me.avatar ? "Change your picture" : "Add a picture"} className="group relative rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60" />}
          >
            <PersonAvatar name={me.name} avatar={me.avatar} size={56} />
            <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
              {picture.busy ? <Spinner className="text-white" /> : <Camera className="size-5" aria-hidden="true" />}
            </span>
          </TooltipTrigger>
          <TooltipContent>{me.avatar ? "Change your picture" : "Add a picture"}</TooltipContent>
        </Tooltip>
        {picture.elements}
        <div className="min-w-0">
          <CardTitle className="truncate">{me.name}</CardTitle>
          {me.avatar ? (
            <CardDescription>
              <button type="button" onClick={() => void removePicture()} className="underline underline-offset-3 hover:text-foreground">
                Remove the picture
              </button>
            </CardDescription>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!local ? <p className="text-[13.5px] text-muted-foreground">You sign in through your organisation&apos;s provider, so there is no password to change here.</p> : null}
        {local ? (
        <form onSubmit={changePassword}>
          <FieldGroup className="gap-3 sm:grid sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="current-password">Current password</FieldLabel>
              <Input id="current-password" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
            </Field>
            <Field>
              <FieldLabel htmlFor="new-password">New password</FieldLabel>
              <Input id="new-password" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={12} required />
            </Field>
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="confirm-password">Confirm</FieldLabel>
              <Input id="confirm-password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={12} required aria-invalid={error ? true : undefined} />
            </Field>
            <div className="flex items-center gap-3 sm:col-span-3">
              <Button type="submit" disabled={busy}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy ? "Changing…" : "Change password"}
              </Button>
              {error ? <FieldError>{error}</FieldError> : null}
            </div>
          </FieldGroup>
        </form>
        ) : null}
      </CardContent>
    </Card>
  );
}

