"use client";

import { joinNames, type ImageAspect, type LiveEvent } from "@gond/shared";
import { useMemo, useRef, useState } from "react";
import { useLiveEvents } from "@/components/hq/live-events";
import { Markdown } from "@/components/markdown";
import { PictureMaking, type PictureReveal } from "@/components/picture-making";
import { useActivity, useStore } from "@/components/store";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message as MessageRow, MessageContent, MessageHeader } from "@/components/ui/message";
import { MessageScrollerItem } from "@/components/ui/message-scroller";
import { WorkLine, WorkLines } from "@/components/work-log";
import { botsWaitingOnYou, WAITING_FOR_YOU } from "@/lib/message-state";

/** A bot's reply as it is written, drawn like the message it becomes; its choices only work once it is posted. */
function Writing({ name, text }: { name: string | null; text: string }) {
  return (
    <MessageRow align="start">
      <MessageContent className="gap-1">
        {name ? <MessageHeader>{name}</MessageHeader> : null}
        <Bubble variant="outline" align="start" className="max-w-[86%] sm:max-w-[78%]">
          <BubbleContent className="rounded-2xl px-3.5 py-2">
            <Markdown text={text} className="flex flex-col gap-2 text-[14px] leading-6" />
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </MessageRow>
  );
}

/**
 * Below the lines: replies being written, pictures being made and what each bot is doing. These change
 * many times a second, so they live here and never redraw the history above.
 */
export function LiveTail({ threadId, isRoom, catchUp, onLanded }: { threadId: string; isRoom: boolean; catchUp: () => Promise<void>; onLanded: (reveal: PictureReveal) => void }) {
  const { bots, approvals } = useStore();
  const activity = useActivity();

  // What each bot is writing right now. One that stopped stays until the messages it ended in are loaded, so the bubble never blinks.
  const [writing, setWriting] = useState<Record<string, string>>({});
  const writingRound = useRef(new Map<string, number>());
  const onWriting = (botId: string, text: string | null) => {
    const round = (writingRound.current.get(botId) ?? 0) + 1;
    writingRound.current.set(botId, round);
    if (text !== null) {
      setWriting((current) => ({ ...current, [botId]: text }));
      return;
    }
    void catchUp().finally(() => {
      if (writingRound.current.get(botId) !== round) return;
      setWriting((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== botId)));
    });
  };

  const [making, setMaking] = useState<Record<string, { botId: string; aspect: ImageAspect; preview: string | null }>>({});
  const onPicture = (event: Extract<LiveEvent, { topic: "picture" }>) => {
    const forget = () => setMaking((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== event.id)));
    if (event.state === "making" || event.state === "preview") {
      setMaking((current) => ({ ...current, [event.id]: { botId: event.botId, aspect: event.aspect, preview: event.preview } }));
      return;
    }
    if (event.state === "failed" || !event.file) return forget();
    onLanded({ file: event.file, aspect: event.aspect, color: bots.find((b) => b.id === event.botId)?.color ?? "var(--muted-foreground)" });
    void catchUp().finally(forget);
  };

  useLiveEvents((event) => {
    if (event.topic === "open") {
      setWriting({});
      setMaking({});
    } else if (event.topic === "writing" && event.threadId === threadId) onWriting(event.botId, event.text);
    else if (event.topic === "picture" && event.threadId === threadId) onPicture(event);
  });

  const working = activity[threadId] ?? {};
  const drawing = new Set(Object.values(making).map((m) => m.botId));
  const heldOnYou = useMemo(() => botsWaitingOnYou(approvals, threadId), [approvals, threadId]);
  const workLines = Object.entries(working)
    .filter(([botId]) => !(botId in writing) && !drawing.has(botId))
    .map(([botId, line]) => ({ botId, bot: bots.find((b) => b.id === botId), line: heldOnYou.has(botId) ? WAITING_FOR_YOU : line, waiting: heldOnYou.has(botId) }));
  const workingBots = workLines.flatMap(({ bot: found, line, waiting }) => (found ? [{ bot: found, line, waiting }] : [])).sort((a, b) => Number(b.bot.primary) - Number(a.bot.primary));

  return (
    <>
      {Object.entries(writing).map(([botId, text]) => (
        <MessageScrollerItem key={`writing-${botId}`}>
          <Writing name={isRoom ? (bots.find((x) => x.id === botId)?.name ?? null) : null} text={text} />
        </MessageScrollerItem>
      ))}
      {Object.entries(making).map(([id, picture]) => (
        <MessageScrollerItem key={`picture-${id}`}>
          <PictureMaking bot={bots.find((x) => x.id === picture.botId)} aspect={picture.aspect} preview={picture.preview} />
        </MessageScrollerItem>
      ))}
      {workingBots.length > 1 ? (
        <MessageScrollerItem key="working">
          <WorkLines working={workingBots} label={joinNames(workingBots.map((w) => w.bot.name))} />
        </MessageScrollerItem>
      ) : (
        workLines.map(({ botId, bot: found, line, waiting }) => (
          <MessageScrollerItem key={`working-${botId}`}>
            <WorkLine bot={found} line={line} waiting={waiting} />
          </MessageScrollerItem>
        ))
      )}
    </>
  );
}
