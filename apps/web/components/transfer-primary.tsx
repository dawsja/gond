"use client";

import type { Bot } from "@gond/shared";
import { useState } from "react";
import { useStore } from "@/components/store";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { post } from "@/lib/api";

export function TransferPrimaryDialog({ bot, open, onOpenChange }: { bot: Bot | undefined; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { bots, refresh } = useStore();
  const others = bots.filter((b) => b.id !== bot?.id && !b.hidden);
  const [to, setTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items = others.map((b) => ({ value: b.id, label: b.name }));

  async function transfer() {
    if (!to || busy) return;
    setBusy(true);
    try {
      await post(`/api/bots/${to}/primary`);
      await refresh();
      onOpenChange(false);
      setTo(null);
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't transfer it." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Transfer primary bot</AlertDialogTitle>
          <AlertDialogDescription>The bot you pick answers in rooms when nobody is named and hears first when a teammate&apos;s run breaks. {bot?.name ?? "This bot"} stays on the team.</AlertDialogDescription>
        </AlertDialogHeader>
        <Select items={items} value={to} onValueChange={(value) => setTo(typeof value === "string" ? value : null)}>
          <SelectTrigger aria-label="New primary bot" className="w-full">
            <SelectValue placeholder="Pick a bot" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {others.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction disabled={!to || busy} onClick={() => void transfer()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Make it primary
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
