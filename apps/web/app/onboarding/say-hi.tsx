"use client";

import type { Bot, Message } from "@gond/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { AiSetupCard } from "@/components/ai-setup-card";
import { BotAvatar } from "@/components/bot-avatar";
import { failed } from "@/components/failed";
import { useLiveEvents } from "@/components/hq/live-events";
import { Markdown } from "@/components/markdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { WorkLine } from "@/components/work-log";
import { api, post } from "@/lib/api";
import { HELLO, helloOutcome } from "@/lib/hello";

/**
 * Onboarding's last step: one real message to the primary bot, so the person sees their AI answer
 * before they leave. `sent` lives with the steps, so going back to fix the AI and returning retries the
 * same message rather than sending another.
 */
export function SayHi({ bot, sent, onSent, onBack, onDone }: { bot: Bot; sent: Message | null; onSent: (message: Message) => void; onBack: () => void; onDone: () => void }) {
  const threadId = bot.threadId;
  const [messages, setMessages] = useState<Message[]>([]);
  const [writing, setWriting] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [sendFailed, setSendFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const sending = useRef(false);

  const load = useCallback(
    () =>
      api<{ messages: Message[] }>(`/api/threads/${threadId}/messages?limit=50`)
        .then((d) => setMessages(d.messages))
        .catch(() => undefined),
    [threadId],
  );

  const send = useCallback(() => {
    if (sending.current) return;
    sending.current = true;
    setSendFailed(false);
    post<{ message: Message }>(`/api/threads/${threadId}/messages`, { body: HELLO })
      .then((d) => {
        onSent(d.message);
        return load();
      })
      .catch((failure: unknown) => {
        setSendFailed(true);
        failed("Couldn't send your message. Try again.")(failure);
      })
      .finally(() => {
        sending.current = false;
      });
  }, [threadId, onSent, load]);

  const retry = useCallback(
    (message: Message) => {
      setRetrying(true);
      setLine(null);
      post(`/api/threads/${threadId}/messages/${message.id}/retry`)
        .then(load)
        .catch(failed("Couldn't try again. Check your connection, then try once more."))
        .finally(() => setRetrying(false));
    },
    [threadId, load],
  );

  const outcome = sent ? helloOutcome(messages, sent, bot.id) : { replies: [], failure: null };

  // Entering the step sends the hello; coming back to it after the AI step tries the same one again if it couldn't be answered.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void Promise.resolve().then(async () => {
      if (!sent) return send();
      const d = await api<{ messages: Message[] }>(`/api/threads/${threadId}/messages?limit=50`).catch(() => null);
      if (!d) return;
      setMessages(d.messages);
      if (helloOutcome(d.messages, sent, bot.id).failure) retry(sent);
    });
  }, [sent, send, retry, threadId, bot.id]);

  useLiveEvents((event) => {
    if (event.topic === "open") void load();
    else if (event.topic === "writing" && event.threadId === threadId && event.botId === bot.id) {
      if (event.text !== null) setWriting(event.text);
      else void load().finally(() => setWriting(null));
    } else if (event.topic === "activity" && event.threadId === threadId && event.botId === bot.id) setLine(event.line);
    else if (event.topic === "thread" && event.threadId === threadId) void load();
  });

  const answered = outcome.replies.length > 0;
  const stuck = Boolean(outcome.failure) || sendFailed;
  // A safety net while the answer is on its way, in case a live event went missing.
  useEffect(() => {
    if (!sent || answered || stuck) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [sent, answered, stuck, load]);

  return (
    <div className="flex w-full flex-col items-center">
      <h1 className="text-center text-[26px] font-semibold tracking-[-0.5px]">Say hi to {bot.name}</h1>
      <p className="mt-2 text-center text-[14px] text-muted-foreground">One message, to check everything works.</p>
      <div className="mt-6 flex w-full flex-col gap-3 rounded-3xl border border-primary-edge bg-card p-4">
        <Bubble align="end" className="max-w-[86%]">
          <BubbleContent className="rounded-2xl px-3.5 py-2 text-[14px] leading-6">{HELLO}</BubbleContent>
        </Bubble>
        {answered ? (
          outcome.replies.map((reply) => <Reply key={reply.id} bot={bot} text={reply.body} />)
        ) : writing ? (
          <Reply bot={bot} text={writing} />
        ) : outcome.failure ? (
          <AiSetupCard bot={bot} reason={outcome.failure.body} onRetry={() => sent && retry(sent)} retrying={retrying} />
        ) : sendFailed ? null : (
          <WorkLine bot={bot} line={line ?? "Reading your message"} />
        )}
      </div>
      <div className="mt-8 flex w-full max-w-xs flex-col gap-2">
        {sendFailed ? (
          <Button size="xl" variant="outline" onClick={send}>
            Try again
          </Button>
        ) : null}
        {answered ? (
          <Button size="xl" variant="tint" onClick={onDone}>
            Go to Gond
          </Button>
        ) : (
          <Button size="xl" variant="outline" onClick={onDone}>
            Go to Gond anyway
          </Button>
        )}
        {stuck ? (
          <Button size="xl" variant="secondary" onClick={onBack}>
            Back to AI
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function Reply({ bot, text }: { bot: Bot; text: string }) {
  return (
    <div className="flex items-end gap-2">
      <BotAvatar bot={bot} size={28} />
      <Bubble variant="outline" className="max-w-[86%]">
        <BubbleContent className="rounded-2xl px-3.5 py-2">
          <Markdown text={text} className="flex flex-col gap-2 text-[14px] leading-6" />
        </BubbleContent>
      </Bubble>
    </div>
  );
}
