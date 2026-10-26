"use client";

import { screenOf, type Bot, type DesktopState, type Message } from "@gond/shared";
import { Hand } from "lucide-react";
import { useEffect, useState } from "react";
import { ActionCard, ActionCardDone } from "@/components/action-card";
import { changeDesktopControl } from "@/components/computer-panel";
import { openShellDialog } from "@/components/shell";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";

/**
 * A hand-off is open while it is the conversation's newest and the person still holds that bot's
 * screen, or the screen went to sleep before they gave it back: the bot still waits on them then.
 */
export function handOffOpen(message: Pick<Message, "author"> | null, desktop: DesktopState | null): boolean {
  if (!message) return false;
  if (!desktop) return true;
  const screen = screenOf(desktop, message.author);
  return !screen.running || screen.control === "person";
}

/**
 * A bot handed its screen over for something only a person can do. The API already gave the person
 * the mouse and keyboard, so the button only opens the screen; the bot carries on once it's handed back.
 */
export function ControlCard({ message, bot, latest }: { message: Message; bot: Bot | undefined; latest: boolean }) {
  const { desktop } = useStore();
  const name = bot?.name ?? "The bot";
  // Cards from before the site was kept say only "Take Control".
  const site = message.body && message.body !== "Take Control" ? message.body : null;
  const icon = <Hand aria-hidden="true" />;

  // A screen that went to sleep wakes free once opened: take it again then, so giving it back wakes the bot.
  const [retake, setRetake] = useState(false);
  const screen = bot ? screenOf(desktop, bot.id) : null;
  useEffect(() => {
    if (!retake || !bot || !screen?.running) return;
    if (screen.control !== "person") changeDesktopControl(bot.id, "person");
    void Promise.resolve().then(() => setRetake(false));
  }, [retake, bot, screen?.running, screen?.control]);
  const open = (to: Bot) => {
    if (screenOf(desktop, to.id).control !== "person") setRetake(true);
    openShellDialog({ kind: "computer", botId: to.id });
  };

  if (!latest || !handOffOpen(message, desktop)) {
    return <ActionCardDone id={message.id} bot={bot} icon={icon} title={site ? `Your turn on ${site}` : "Your turn on its screen"} by={name} status="Handed back" tone="ok" />;
  }

  return (
    <ActionCard
      icon={icon}
      title={`${name} needs you on its screen`}
      by={site ?? "Something there only a person can do"}
      actions={
        <Button size="xl" variant="tint" className="w-full" onClick={() => bot && open(bot)} disabled={!bot}>
          Open the screen
        </Button>
      }
      note={`Give control back when you're done, and ${name} carries on.`}
    />
  );
}
