"use client";

import { handleOf, plainMarkdown, REACTIONS, roomTargets, type Approval, type ApprovalAnswer, type Bot, type ChatAttachment, type ImageAspect, type LiveEvent, type Message, type ReactionEmoji, type Thread } from "@gond/shared";
import { ArrowUp, ChevronLeft, Copy, CornerUpLeft, Download, ListEnd, EllipsisVertical, FileText, Monitor, PanelRight, Paperclip, Pencil, Plus, TextSelect, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ApprovalCard } from "@/components/approval-card";
import { QuoteInBubble, ReplyingTo } from "@/components/reply-quote";
import { BotAvatar, RoomAvatar, roomMembers } from "@/components/bot-avatar";
import { ConversationChrome } from "@/components/conversation-chrome";
import { copyToClipboard } from "@/components/hq/clipboard";
import { copyText } from "@/lib/markdown";
import { canReact, react, ReactionBadges, ReactionPicker } from "@/components/reactions";
import { pollInterval, useLiveEvents } from "@/components/hq/live-events";
import { ChoicesContext } from "@/components/chat-blocks";
import { ImageViewer } from "@/components/image-viewer";
import { Markdown } from "@/components/markdown";
import { PictureFall, PictureMaking, type PictureReveal } from "@/components/picture-making";
import { NoticedLinks, noticedRuns, RunMarker, useWatches, WatchesContext, type Noticed } from "@/components/noticed";
import { DetailsSheet, RightPanel } from "@/components/right-panel";
import { ScreenPanel, useScreenDrivers } from "@/components/screen-panel";
import { SecretCard } from "@/components/secret-card";
import { openShellDialog } from "@/components/shell";
import { SignInCard } from "@/components/signin-card";
import { matchBots, matchSkills, SlashMenu, slashQuery, useSkillsLibrary } from "@/components/slash-menu";
import { shortTime } from "@/lib/time";
import { useActivity, useSingleFlight, useStore, type ThreadRow } from "@/components/store";
import { threadActions, ThreadConfirms, type Ask } from "@/components/thread-actions";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/components/ui/attachment";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message as MessageRow, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerEdges, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller } from "@/components/ui/message-scroller";
import { toast } from "@/components/ui/toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVoiceInput, VoiceButton } from "@/components/voice-button";
import { WorkLine, WorkLines } from "@/components/work-log";
import { useCoarsePointer } from "@/hooks/use-mobile";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { REPLY_DISTANCE, useSwipeToReply } from "@/hooks/use-swipe-to-reply";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { api, ApiError, post } from "@/lib/api";
import { readDraft, saveDraft } from "@/lib/drafts";
import { historyStep, sentHistory } from "@/lib/sent-history";
import { askNative, filesFrom, useNativeUi, type NativeMenuItem } from "@/lib/native-ui";
import { cn } from "@/lib/utils";

const ExchangeDialog = dynamic(() => import("@/components/exchange-dialog").then((m) => m.ExchangeDialog));

const POLL_MS = 4_000;
// Long enough for the last square of a landed picture to fall away.
const REVEAL_MS = 1_500;

const PAGE = 200;
const MAX_FILES = 6;
const COMPOSER_HEIGHT = 68;

type ThreadInfo = { thread: Thread; bot: Bot | null; busy: string[]; answering?: string[] };

function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Handoff({ message, threadId, bots, threads, onOpen }: { message: Message; threadId: string; bots: Bot[]; threads: ThreadRow[]; onOpen: (withThreadId: string) => void }) {
  const incoming = message.threadId === threadId;
  const otherId = incoming ? message.fromThreadId! : message.threadId;
  const other = threads.find((t) => t.id === otherId);
  const party = incoming ? bots.find((b) => b.id === message.author) : other?.botId ? bots.find((b) => b.id === other.botId) : undefined;
  return (
    <Marker className="justify-center">
      <button
        type="button"
        onClick={() => onOpen(otherId)}
        title={message.body.replace(/\s+/g, " ").slice(0, 200)}
        className="flex max-w-full items-center gap-1.5 rounded-full px-2 py-1 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span>{incoming ? "Message from" : "Messaged"}</span>
        {party ? <BotAvatar bot={party} size={16} /> : <RoomAvatar bots={other ? roomMembers(other, bots) : []} size={16} />}
        <span className="truncate font-medium">{party?.name ?? other?.name ?? "a teammate"}</span>
      </button>
    </Marker>
  );
}

function selectionIn(node: HTMLElement | null): string {
  const selection = typeof window === "undefined" ? null : window.getSelection();
  if (!node || !selection || selection.isCollapsed || !selection.rangeCount) return "";
  const range = selection.getRangeAt(0);
  return node.contains(range.commonAncestorContainer) ? selection.toString() : "";
}

function EditBubble({ message, touch, stops, onCancel, onSend }: { message: Message; touch: boolean; stops: boolean; onCancel: () => void; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState(message.body);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  const changed = text.trim() && text.trim() !== message.body.trim();
  async function submit() {
    if (!changed || sending) return;
    setSending(true);
    const ok = await onSend(text.trim());
    if (!ok) setSending(false);
  }
  return (
    <form
      className="flex w-full max-w-[86%] flex-col items-end gap-2 self-end sm:max-w-[78%]"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <InputGroup variant="pill" className="w-full rounded-2xl">
        <InputGroupTextarea
          ref={field}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            } else if (e.key === "Enter" && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          aria-label="Edit your message"
          enterKeyHint={touch ? "enter" : "send"}
          className="max-h-60 min-h-11 px-3.5 py-2.5 text-[16px] leading-6 sm:text-[14px]"
        />
      </InputGroup>

      <p className="px-1 text-right text-[11.5px] text-muted-foreground">{stops ? "Sending stops the work here, then starts again with your fix." : "Sent again as a new message."}</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={sending} className="pointer-coarse:h-11 pointer-coarse:px-4">
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!changed || sending} className="pointer-coarse:h-11 pointer-coarse:px-4">
          {sending ? "Sending…" : stops ? "Stop and send" : "Send"}
        </Button>
      </div>
    </form>
  );
}

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

function SelectTextDialog({ text, onClose }: { text: string | null; onClose: () => void }) {
  return (
    <Dialog open={text !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Select text</DialogTitle>
          <DialogDescription>Press and hold a word, then drag to pick the part you want.</DialogDescription>
        </DialogHeader>
        <div data-select-all className="max-h-[55dvh] overflow-y-auto rounded-2xl bg-muted px-3.5 py-3 select-text">
          <Markdown text={text ?? ""} className="flex flex-col gap-2 text-[15px] leading-6 wrap-break-word" />
        </div>
        <DialogFooter>
          <Button
            onClick={() =>
              void copyToClipboard(text ?? "").then((ok) => {
                toast.add(ok ? { title: "Copied." } : { type: "error", title: "Couldn't copy it." });
                if (ok) onClose();
              })
            }
          >
            <Copy data-icon="inline-start" aria-hidden="true" />
            Copy all
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// A tap on a link, button or picture inside a bubble, or the end of a selection, isn't asking for the time.
function showsTime(event: ReactMouseEvent): boolean {
  if (event.target instanceof Element && event.target.closest("a, button, img, input, textarea")) return false;
  return !window.getSelection()?.toString();
}

/** "Net", "Net and Patch", "Ada, Bo and Cy". */
function names(list: string[]): string {
  return list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;
}

function nameOf(author: string, bots: Bot[]): string {
  return author === "you" ? "You" : (bots.find((b) => b.id === author)?.name ?? "A bot");
}

function colorOf(author: string, bots: Bot[]): string | null {
  return author === "you" ? null : (bots.find((b) => b.id === author)?.color ?? null);
}

/** A file shown as a picture, on its own outside the bubble: anything an image but an SVG, which could run script. */
function isPicture(file: ChatAttachment): boolean {
  return file.mediaType.startsWith("image/") && file.mediaType !== "image/svg+xml";
}

function revealIn(message: Message, reveals: Record<string, PictureReveal>): PictureReveal | undefined {
  for (const file of message.attachments) if (reveals[file.id]) return reveals[file.id];
  return undefined;
}

/** What a reply quotes from a message still being written: its words, or its first file. */
function quoteText(message: Message): string {
  return plainMarkdown(message.body).slice(0, 280) || message.attachments[0]?.name || "";
}

const Line = memo(function Line({ message, threadId, bots, threads, bot, approvals, isRoom, editing, stops, touch, answer, sentTo, noticed, reveal, onPick, onView, onDecide, onOpenExchange, onEdit, onSelectText, onReacted, onReply, onJump }: { message: Message; threadId: string; bots: Bot[]; threads: ThreadRow[]; bot: Bot | null; approvals: Map<string, Approval>; isRoom: boolean; editing: boolean; stops: boolean; touch: boolean; answer: string | undefined; sentTo: string | undefined; noticed: Noticed | undefined; reveal: PictureReveal | undefined; onPick: (option: string, from: string) => Promise<void>; onView: (attachmentId: string) => void; onDecide: (id: string, answer: ApprovalAnswer) => Promise<void>; onOpenExchange: (withThreadId: string) => void; onEdit: (message: Message | null, text?: string) => Promise<boolean>; onSelectText: (text: string) => void; onReacted: (message: Message) => void; onReply: (message: Message) => void; onJump: (id: string) => void }) {
  const mine = message.author === "you";
  const bubble = useRef<HTMLDivElement>(null);
  const native = useNativeUi();

  const [selected, setSelected] = useState("");
  const [timed, setTimed] = useState(false);
  const [swipe, setSwipe] = useState(0);
  const replyable = message.kind === "message" && !message.fromThreadId && message.author !== "routine" && message.author !== "system";
  useSwipeToReply(bubble, touch && replyable, setSwipe, () => onReply(message));
  const choices = useMemo(() => (mine ? {} : { pick: (option: string) => onPick(option, message.author), picked: answer }), [mine, onPick, message.author, answer]);

  const author = mine ? null : bots.find((b) => b.id === message.author) ?? null;
  if (message.kind === "prompt") return null;
  if (message.kind === "message" && message.fromThreadId && author) return <Handoff message={message} threadId={threadId} bots={bots} threads={threads} onOpen={onOpenExchange} />;
  if (message.author === "routine") return <RunMarker message={message} bot={bot} />;
  if (message.kind === "event") {
    return (
      <Marker className="justify-center">
        <MarkerContent className="max-w-[80%] text-center text-xs">{message.body}</MarkerContent>
      </Marker>
    );
  }
  if (message.kind === "approval" || message.kind === "secret" || message.kind === "signin") {
    return (
      <MessageRow align="start">
        <MessageContent>
          {message.kind === "signin" ? <SignInCard message={message} bot={author ?? bot ?? undefined} /> : message.kind === "secret" ? <SecretCard message={message} bot={author ?? bot ?? undefined} /> : <ApprovalCard message={message} approval={message.approvalId ? approvals.get(message.approvalId) ?? null : null} bot={author ?? bot ?? undefined} noticed={Boolean(noticed)} onDecide={onDecide} />}
        </MessageContent>
      </MessageRow>
    );
  }
  const showName = !mine && (isRoom || message.author === "routine" || message.author === "system");
  const pictures = message.attachments.filter(isPicture);
  const files = message.attachments.filter((file) => !isPicture(file));
  const editable = mine && Boolean(message.body.trim()) && message.attachments.length === 0;
  const reactable = canReact(message);
  const reactWith = (emoji: ReactionEmoji) => void react(message, emoji, onReacted);
  // On the iPhone a long press lifts the bubble into the app's own menu, with the reactions above it.
  const openNativeMenu = async () => {
    const node = bubble.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    const items: NativeMenuItem[] = [];
    if (replyable) items.push({ id: "reply", label: "Reply", symbol: "arrowshape.turn.up.left" });
    if (message.body) items.push({ id: "copy", label: "Copy text", symbol: "doc.on.doc" });
    if (message.body) items.push({ id: "select", label: "Select text", symbol: "character.cursor.ibeam" });
    if (editable) items.push({ id: "edit", label: "Edit and resend", symbol: "pencil" });
    const picked = await askNative({
      kind: "message",
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      mine,
      reactions: reactable ? { options: REACTIONS, mine: message.reactions.find((r) => r.author === "you")?.emoji ?? null } : null,
      items,
    });
    if (picked?.react && (REACTIONS as readonly string[]).includes(picked.react)) reactWith(picked.react as ReactionEmoji);
    else if (picked?.action === "reply") onReply(message);
    else if (picked?.action === "copy") void copyToClipboard(copyText(message.body)).then((ok) => toast.add(ok ? { title: "Copied." } : { type: "error", title: "Couldn't copy it." }));
    else if (picked?.action === "select") onSelectText(copyText(message.body));
    else if (picked?.action === "edit") void onEdit(message);
  };
  if (editing) {
    return (
      <MessageRow align="end">
        <MessageContent className="gap-1">
          <EditBubble
            message={message}
            touch={touch}
            stops={stops}
            onCancel={() => void onEdit(null)}
            onSend={(text) => onEdit(message, text)}
          />
        </MessageContent>
      </MessageRow>
    );
  }
  return (
    <MessageRow align={mine ? "end" : "start"}>
      <MessageContent className="gap-1">
        {showName ? <MessageHeader>{author?.name ?? (message.author === "routine" ? "Routine" : "Gond")}</MessageHeader> : null}

        <ContextMenu onOpenChange={(open) => setSelected(open ? selectionIn(bubble.current) : "")}>
        <ContextMenuTrigger
          ref={bubble}
          onClick={(event) => showsTime(event) && setTimed((on) => !on)}
          onContextMenu={(event) => {
            if (native && touch) {
              event.preventDefault();
              event.preventBaseUIHandler();
              if (message.body || editable || reactable || replyable) void openNativeMenu();
              return;
            }
            // A right click on a link gets the browser's own menu (open in a new tab, copy the address).
            if (!touch && event.target instanceof Element && event.target.closest("a[href]")) event.preventBaseUIHandler();
          }}
          className={cn("touch-pan-y select-text pointer-coarse:select-none", !swipe && "transition-transform duration-200")}
          style={swipe ? { transform: `translateX(${swipe}px)` } : undefined}
          render={<Bubble variant={mine ? "default" : "outline"} align={mine ? "end" : "start"} className={cn("max-w-[86%] sm:max-w-[78%]", message.reactions.length > 0 && "mb-2.5")} />}
        >
          {swipe ? (
            <span aria-hidden="true" className="absolute top-1/2 -left-9 grid size-7 -translate-y-1/2 place-items-center rounded-full bg-primary text-foreground" style={{ opacity: Math.min(1, swipe / REPLY_DISTANCE), scale: swipe >= REPLY_DISTANCE ? "1.1" : "1" }}>
              <CornerUpLeft className="size-4" />
            </span>
          ) : null}
          {pictures.length ? (
            <div className="flex max-w-80 flex-wrap gap-1.5 group-data-[align=end]/bubble:self-end">
              {pictures.map((file) => (
                <button key={file.id} type="button" onClick={() => onView(file.id)} aria-label={`View ${file.name}`} className="relative block max-w-full cursor-zoom-in overflow-hidden rounded-3xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/attachments/${file.id}`} alt={file.name} className="block max-h-90 w-auto max-w-full" />
                  {reveal?.file === file.id ? <PictureFall reveal={reveal} /> : null}
                </button>
              ))}
            </div>
          ) : null}
          {message.replyTo || message.body || files.length ? (
          <BubbleContent className="rounded-2xl px-3.5 py-2">
            {message.replyTo ? <QuoteInBubble quote={message.replyTo} name={nameOf(message.replyTo.author, bots)} color={colorOf(message.replyTo.author, bots)} onJump={onJump} /> : null}
            {message.body ? (
              <ChoicesContext.Provider value={choices}>
                <Markdown text={message.body} className="flex flex-col gap-2 text-[14px] leading-6" />
              </ChoicesContext.Provider>
            ) : null}
            {files.length ? (
              <AttachmentGroup className={cn(message.body && "mt-2")}>
                {files.map((file) => (
                  <Attachment key={file.id} size="sm">
                    <AttachmentTrigger render={<a href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer" aria-label={`Open ${file.name}`} />} />
                    <AttachmentMedia variant="icon">
                      <FileText />
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle>{file.name}</AttachmentTitle>
                      <AttachmentDescription>{formatBytes(file.size)}</AttachmentDescription>
                    </AttachmentContent>
                    <AttachmentActions>
                      <AttachmentAction aria-label={`Download ${file.name}`} render={<a href={`/api/attachments/${file.id}?download`} download={file.name} />} nativeButton={false}>
                        <Download />
                      </AttachmentAction>
                    </AttachmentActions>
                  </Attachment>
                ))}
              </AttachmentGroup>
            ) : null}
          </BubbleContent>
          ) : null}
          <ReactionBadges message={message} bots={bots} mine={mine} onReact={reactWith} />
        </ContextMenuTrigger>
          {message.body || editable || reactable || replyable ? (
            <ContextMenuContent className="w-60 pointer-coarse:w-76">
              {reactable ? <ReactionPicker message={message} onReact={reactWith} /> : null}
              {reactable ? <ContextMenuSeparator /> : null}
              <ContextMenuGroup>
                {replyable ? (
                  <ContextMenuItem onClick={() => onReply(message)}>
                    <CornerUpLeft aria-hidden="true" />
                    Reply
                  </ContextMenuItem>
                ) : null}
                {selected ? (
                  <ContextMenuItem onClick={() => void copyToClipboard(selected).then((ok) => toast.add(ok ? { title: "Copied." } : { type: "error", title: "Couldn't copy it." }))}>
                    <TextSelect aria-hidden="true" />
                    Copy selection
                  </ContextMenuItem>
                ) : null}
                {message.body ? (
                  <ContextMenuItem
                    onClick={() =>
                      void copyToClipboard(copyText(message.body)).then((ok) => toast.add(ok ? { title: "Copied." } : { type: "error", title: "Couldn't copy it." }))
                    }
                  >
                    <Copy aria-hidden="true" />
                    Copy text
                  </ContextMenuItem>
                ) : null}
                {message.body && touch ? (
                  <ContextMenuItem onClick={() => onSelectText(copyText(message.body))}>
                    <TextSelect aria-hidden="true" />
                    Select text
                  </ContextMenuItem>
                ) : null}
                {editable ? (
                  <ContextMenuItem onClick={() => void onEdit(message)}>
                    <Pencil aria-hidden="true" />
                    Edit and resend
                  </ContextMenuItem>
                ) : null}
              </ContextMenuGroup>
            </ContextMenuContent>
          ) : null}
        </ContextMenu>
        {noticed?.lead ? <NoticedLinks message={message} watch={noticed.watch} bot={bot} /> : null}
        {timed || message.steered || (message.sentTo && sentTo) ? (
          <MessageFooter className="text-[10.5px] font-normal text-ash">
            {[timed ? shortTime(message.createdAt) : null, message.steered ? (sentTo ? `Sent to ${sentTo} while working` : "Sent while working") : sentTo ? `Sent to ${sentTo}` : null].filter(Boolean).join(" · ")}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </MessageRow>
  );
});

function JumpToMessage({ id, ready, loaded, earlier }: { id: string | null; ready: boolean; loaded: boolean; earlier: () => Promise<boolean> }) {
  const { scrollToMessage } = useMessageScroller();
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !ready || done === id) return;
    const timer = window.setTimeout(() => {
      if (scrollToMessage(id, { align: "center" })) return setDone(id);
      if (loaded) return;
      void earlier().then((more) => {
        if (more) return;
        setDone(id);
        toast.add({ title: "That message isn't in this conversation any more." });
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [id, ready, loaded, done, scrollToMessage, earlier]);
  return null;
}

function FollowSent({ id }: { id: string | null }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (id) scrollToEnd();
  }, [id, scrollToEnd]);
  return null;
}

function LoadEarlier({ onLoad }: { onLoad: () => Promise<boolean> }) {
  const ref = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(() => {
    if (loading) return;
    setLoading(true);
    void onLoad().finally(() => setLoading(false));
  }, [loading, onLoad]);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) load();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [load]);
  return (
    <div ref={ref} className="flex justify-center">
      <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
        {loading ? "Loading…" : "Load earlier messages"}
      </Button>
    </div>
  );
}

export function Conversation({ threadId }: { threadId: string }) {
  const { bots, threads, approvals, refresh, boxUpdating, desktop } = useStore();
  const activity = useActivity();
  const router = useRouter();
  // In the iPhone app the header and the composer are the app's own, in Liquid Glass (`ConversationChrome`).
  const nativeChrome = useNativeUi();
  const [focusRev, setFocusRev] = useState(0);
  const focusField = () => {
    if (nativeChrome) setFocusRev((n) => n + 1);
    else textarea.current?.focus();
  };
  const [info, setInfo] = useState<ThreadInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [infoFailed, setInfoFailed] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);

  const [earlier, setEarlier] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState("");
  // Which of the person's sent lines Up and Down put in the field (`sentHistory`), while it still shows that line.
  const [recall, setRecall] = useState<number | null>(null);
  const restored = useRef(false);
  useEffect(() => {
    const saved = readDraft(threadId);
    void Promise.resolve().then(() => {
      if (saved) setDraft((d) => d || saved);
      setRecall(null);
      restored.current = true;
    });
  }, [threadId]);
  useEffect(() => {
    if (restored.current) saveDraft(threadId, draft);
  }, [threadId, draft]);
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [panel, setPanel] = useState(true);
  const [details, setDetails] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);

  const touch = useCoarsePointer();
  const params = useSearchParams();
  const jumpTo = params.get("m");
  const skills = useSkillsLibrary();
  const [slash, setSlash] = useState<{ kind: "skill" | "bot"; query: string; start: number; selected: number } | null>(null);
  const [exchange, setExchange] = useState<string | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [replying, setReplying] = useState<Message | null>(null);
  // A tap on a reply's quote; the count makes a second tap on the same quote go again.
  const [jump, setJump] = useState<{ id: string; n: number } | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!jump) return;
    void Promise.resolve().then(() => setFlash(jump.id));
    const timer = window.setTimeout(() => setFlash(null), 1600);
    return () => window.clearTimeout(timer);
  }, [jump]);
  const [sent, setSent] = useState<string | null>(null);
  const [selectText, setSelectText] = useState<string | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Map<string, Approval>>(new Map());
  const textarea = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_HEIGHT);
  useEffect(() => {
    const node = composer.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setComposerHeight(Math.ceil(node.offsetHeight)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const cursor = useRef<string | null>(null);

  const approvalMap = useMemo(() => {
    const map = new Map(resolved);
    for (const a of approvals) map.set(a.id, a);
    return map;
  }, [approvals, resolved]);

  /** For a bot's message, what the person said next, which closes any choices it offered; none yet leaves them open. */
  const answers = useMemo(() => {
    const map = new Map<string, string>();
    let next: string | undefined;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]!;
      // A pick in a room names the bot it answers ("@patch Run a sweep"); the option is what's left.
      if (m.author === "you" && m.kind === "message") next = m.body.replace(/^(?:\s*@[\w-]+[\s,]*)+/, "");
      else if (next !== undefined) map.set(m.id, next);
    }
    return map;
  }, [messages]);

  const history = useMemo(() => sentHistory(messages), [messages]);

  const pictures = useMemo(() => messages.flatMap((m) => (m.kind === "prompt" ? [] : m.attachments.filter(isPicture).map((file) => ({ id: file.id, name: file.name })))), [messages]);

  const append = useCallback((incoming: Message[]) => {
    if (!incoming.length) return;
    setMessages((current) => {
      const seen = new Set(current.map((m) => m.id));
      const fresh = incoming.filter((m) => !seen.has(m.id));
      const next = fresh.length ? [...current, ...fresh] : current;
      cursor.current = next.at(-1)?.createdAt ?? cursor.current;
      return next;
    });
  }, []);

  const replaceMessage = useCallback((changed: Pick<Message, "id" | "reactions">) => {
    setMessages((current) => current.map((m) => (m.id === changed.id ? { ...m, reactions: changed.reactions } : m)));
  }, []);

  const loadInfo = useCallback(async () => {
    try {
      setInfo(await api<ThreadInfo>(`/api/threads/${threadId}`));
      setInfoFailed(false);
    } catch (failure) {
      // Only a 404 means it's gone; a dropped connection is worth another try.
      if (failure instanceof ApiError && failure.status === 404) setMissing(true);
      else setInfoFailed(true);
    }
  }, [threadId]);

  const loadMessages = useCallback(
    async (after: string | null) => {
      const data = await api<{ messages: Message[] }>(`/api/threads/${threadId}/messages${after ? `?after=${encodeURIComponent(after)}` : `?limit=${PAGE}`}`).catch(() => null);
      if (!data) {
        if (!after) setLoadFailed(true);
        return;
      }
      if (!after) {
        setLoadFailed(false);
        setMessages(data.messages);
        setEarlier(data.messages.length >= PAGE);
        cursor.current = data.messages.at(-1)?.createdAt ?? null;
      } else append(data.messages);

      const ids = data.messages.filter((m) => m.kind === "approval" && m.approvalId).map((m) => m.approvalId!);
      for (const id of ids) {
        if (approvalMap.has(id)) continue;
        void api<{ approval: Approval }>(`/api/approvals/${id}`)
          .then((d) => setResolved((current) => new Map(current).set(id, d.approval)))
          .catch(() => undefined);
      }
    },

    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threadId, append],
  );

  // A reply sends several events at once; each of these runs once for all of them.
  const refreshInfo = useSingleFlight(loadInfo);
  const catchUp = useSingleFlight(() => loadMessages(cursor.current));
  const readTimer = useRef<number | null>(null);
  const markRead = useCallback(() => {
    if (readTimer.current !== null) return;
    readTimer.current = window.setTimeout(() => {
      readTimer.current = null;
      void post(`/api/threads/${threadId}/read`).catch(() => undefined);
    }, 250);
  }, [threadId]);
  useEffect(
    () => () => {
      if (readTimer.current !== null) window.clearTimeout(readTimer.current);
      readTimer.current = null;
    },
    [threadId],
  );

  const first = messages[0]?.createdAt ?? null;

  const loadEarlier = useCallback(async () => {
    if (!first) return false;
    const data = await api<{ messages: Message[] }>(`/api/threads/${threadId}/messages?before=${encodeURIComponent(first)}&limit=${PAGE}`).catch(() => null);
    if (!data) {
      toast.add({ type: "error", title: "Couldn't load earlier messages." });
      return false;
    }
    setEarlier(data.messages.length >= PAGE);
    setMessages((current) => {
      const seen = new Set(current.map((m) => m.id));
      return [...data.messages.filter((m) => !seen.has(m.id)), ...current];
    });
    return data.messages.length > 0;
  }, [threadId, first]);

  useSwipeBack("/app");
  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadInfo();
      void loadMessages(null);
      void post(`/api/threads/${threadId}/read`).catch(() => undefined);
    });
  }, [threadId, loadInfo, loadMessages]);

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

  // Pictures bots are making here, by picture id, and those that just landed, by attachment, for their squares to fall away once.
  const [making, setMaking] = useState<Record<string, { botId: string; aspect: ImageAspect; preview: string | null }>>({});
  const [reveals, setReveals] = useState<Record<string, PictureReveal>>({});
  const onPicture = (event: Extract<LiveEvent, { topic: "picture" }>) => {
    const forget = () => setMaking((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== event.id)));
    if (event.state === "making" || event.state === "preview") {
      setMaking((current) => ({ ...current, [event.id]: { botId: event.botId, aspect: event.aspect, preview: event.preview } }));
      return;
    }
    if (event.state === "failed" || !event.file) return forget();
    const file = event.file;
    setReveals((current) => ({ ...current, [file]: { file, aspect: event.aspect, color: bots.find((b) => b.id === event.botId)?.color ?? "var(--muted-foreground)" } }));
    window.setTimeout(() => setReveals((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== file))), REVEAL_MS);
    void catchUp().finally(forget);
  };

  const live = useLiveEvents((event) => {
    if (event.topic === "open") {
      setWriting({});
      setMaking({});
      void catchUp();
      void refreshInfo();
    } else if (event.topic === "writing" && event.threadId === threadId) {
      onWriting(event.botId, event.text);
    } else if (event.topic === "picture" && event.threadId === threadId) {
      onPicture(event);
    } else if (event.topic === "thread" && event.threadId === threadId) {
      void (event.cleared ? loadMessages(null) : catchUp());
      void refreshInfo();
      markRead();
    } else if (event.topic === "reactions" && event.threadId === threadId) {
      replaceMessage({ id: event.messageId, reactions: event.reactions });
    } else if (event.topic === "approvals") {
      void catchUp();
      // A decided approval never changes again; only the ones still waiting can have moved.
      for (const [id, approval] of approvalMap) {
        if (approval.status !== "pending") continue;
        void api<{ approval: Approval }>(`/api/approvals/${id}`)
          .then((d) => setResolved((current) => new Map(current).set(id, d.approval)))
          .catch(() => undefined);
      }
    } else if (event.topic === "bots") void refreshInfo();
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void catchUp();
    }, pollInterval(live, POLL_MS));
    return () => window.clearInterval(timer);
  }, [live, catchUp]);

  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (live) {
      void Promise.resolve().then(() => setPaused(false));
      return;
    }
    const timer = window.setTimeout(() => setPaused(true), 5_000);
    return () => window.clearTimeout(timer);
  }, [live]);

  const working = activity[threadId] ?? {};
  const drawing = new Set(Object.values(making).map((m) => m.botId));
  const workingBots = Object.entries(working)
    .filter(([botId]) => !(botId in writing) && !drawing.has(botId))
    .flatMap(([botId, line]) => {
      const found = bots.find((b) => b.id === botId);
      return found ? [{ bot: found, line }] : [];
    })
    .sort((a, b) => Number(b.bot.primary) - Number(a.bot.primary));
  const isRoom = info?.thread.kind === "room";
  const bot = info?.bot ?? null;
  const watches = useWatches(bot?.id ?? null);
  const runs = useMemo(() => noticedRuns(messages), [messages]);
  // Who a line in a room went to: the router's pick when it made one (`sentTo`), else read the way the API reads it (`roomTargets`).
  const roomBots = useMemo(() => (isRoom && info ? roomMembers(info.thread, bots) : []), [isRoom, info, bots]);
  const roomDrivers = useScreenDrivers(threadId);
  const sentTo = useMemo(() => {
    const map = new Map<string, string>();
    if (!roomBots.length) return map;
    messages.forEach((m, index) => {
      const routed = m.sentTo ? roomBots.filter((b) => m.sentTo!.includes(b.id)) : [];
      if (routed.length) map.set(m.id, names(routed.map((b) => b.name)));
      else if (m.steered) map.set(m.id, names(roomTargets(m.body, roomBots, messages.slice(0, index)).map((b) => b.name)));
    });
    return map;
  }, [messages, roomBots]);
  // A line that names nobody is placed by the router after it is sent, so only a line steered into running answers is named ahead.
  const roomWorking = [...new Set([...Object.keys(working), ...(info?.busy ?? [])])];
  const answersNext = roomBots.length && roomWorking.length ? roomTargets("", roomBots, messages, roomWorking).map((b) => b.name) : [];
  const waitingOnYou = approvals.some((a) => a.threadId === threadId && a.status === "pending");

  async function send(event?: FormEvent, after = false) {
    event?.preventDefault();
    const text = draft.trim();
    if ((!text && !files.length) || sending) return;
    setSending(true);
    setNotice(null);
    try {
      const replyTo = replying?.id;
      let body: BodyInit = JSON.stringify({ body: text, ...(after ? { after: true } : {}), ...(replyTo ? { replyTo } : {}) });
      if (files.length) {
        const form = new FormData();
        form.set("body", text);
        if (after) form.set("after", "1");
        if (replyTo) form.set("replyTo", replyTo);
        for (const file of files) form.append("files", file, file.name);
        body = form;
      }
      const data = await api<{ message: Message }>(`/api/threads/${threadId}/messages`, { method: "POST", body });
      append([data.message]);
      setSent(data.message.id);
      setDraft("");
      setRecall(null);
      setFiles([]);
      setReplying(null);
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : "Couldn't send.");
    } finally {
      setSending(false);

      if (!touch) textarea.current?.focus();
    }
  }

  function replyTo(message: Message) {
    setReplying(message);
    setEditing(null);
    window.requestAnimationFrame(focusField);
  }

  async function pick(option: string, from: string) {
    // In a room the option goes to the bot that offered it, as the person would say it.
    const offeredBy = isRoom ? bots.find((b) => b.id === from) : undefined;
    const body = offeredBy ? `@${handleOf(offeredBy.name)} ${option}` : option;
    try {
      const data = await api<{ message: Message }>(`/api/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ body }) });
      append([data.message]);
      setSent(data.message.id);
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't send it." });
    }
  }

  async function resendEdited(message: Message, text: string): Promise<boolean> {
    const working = Object.keys(activity[threadId] ?? {}).length > 0 || Boolean(info?.busy.length);
    const stops = Boolean(info?.answering?.includes(message.id));
    try {
      if (stops) await post(`/api/threads/${threadId}/interrupt`);
      const data = await api<{ message: Message }>(`/api/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ body: text, ...(working && !stops ? { after: true } : {}) }) });
      append([data.message]);
      setSent(data.message.id);
      setEditing(null);
      void loadInfo();
      return true;
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't send it." });
      return false;
    }
  }

  async function edit(message: Message | null, text?: string): Promise<boolean> {
    if (!message) {
      setEditing(null);
      return true;
    }
    if (text === undefined) {
      setEditing(message.id);
      return true;
    }
    return resendEdited(message, text);
  }

  async function decide(id: string, answer: ApprovalAnswer) {
    try {
      const data = await post<{ approval: Approval }>(`/api/approvals/${id}`, answer);
      setResolved((current) => new Map(current).set(id, data.approval));
      await refresh();
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't send your answer." });
    }
  }

  function attach(added: File[]) {
    if (!added.length) return;
    const room = MAX_FILES - files.length;
    if (added.length > room) setNotice(`At most ${MAX_FILES} files per message.`);
    if (room > 0) setFiles([...files, ...added.slice(0, room)]);
  }

  function insertToken(token: string) {
    if (!slash) return;
    const el = textarea.current;
    // The app's field keeps its caret to itself; what's typed there is at the end.
    const caret = nativeChrome ? draft.length : (el?.selectionStart ?? draft.length);
    const next = `${draft.slice(0, slash.start)}${token} ${draft.slice(caret)}`;
    setDraft(next);
    setSlash(null);
    if (nativeChrome) return focusField();
    window.requestAnimationFrame(() => {
      const at = slash.start + token.length + 1;
      el?.setSelectionRange(at, at);
      el?.focus();
    });
  }
  const insertSkill = (slug: string) => insertToken(`/${slug}`);
  const insertBot = (b: Bot) => insertToken(`@${handleOf(b.name)}`);

  function trackSlash(text: string, caret: number) {
    const found = slashQuery(text, caret);
    setSlash(found ? { ...found, selected: 0 } : null);
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slash) {
      const count = slash.kind === "skill" ? matchSkills(skills, slash.query).length : matchBots(mentionable, slash.query).length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (count) setSlash({ ...slash, selected: (slash.selected + (event.key === "ArrowDown" ? 1 : count - 1)) % count });
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && count && !event.shiftKey) {
        event.preventDefault();
        if (slash.kind === "skill") insertSkill(matchSkills(skills, slash.query)[slash.selected]!.slug);
        else insertBot(matchBots(mentionable, slash.query)[slash.selected]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlash(null);
        return;
      }
    }
    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) {
      const el = event.currentTarget;
      const at = recall !== null && history[recall] === draft ? recall : null;
      const step = historyStep({ key: event.key, text: draft, start: el.selectionStart, end: el.selectionEnd, at, count: history.length });
      if (step !== null) {
        event.preventDefault();
        const next = step < 0 ? "" : history[step]!;
        setRecall(step < 0 ? null : step);
        setDraft(next);
        // Up leaves the caret at the start and Down at the end, so pressing the same key again keeps going.
        const caret = event.key === "ArrowUp" ? 0 : next.length;
        window.requestAnimationFrame(() => el.setSelectionRange(caret, caret));
        return;
      }
    }
    if (event.key === "Escape" && replying) {
      event.preventDefault();
      setReplying(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }
  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = [...event.clipboardData.files];
    if (pasted.length) {
      event.preventDefault();
      attach(pasted);
    }
  }
  const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  function onDragOver(event: DragEvent<HTMLElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropping(true);
  }
  function onDragLeave(event: DragEvent<HTMLElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false);
  }
  function onDrop(event: DragEvent<HTMLElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setDropping(false);
    attach([...event.dataTransfer.files]);
  }

  const dictated = useCallback(
    (text: string) => {
      setDraft((d) => `${d}${d && !/\s$/.test(d) ? " " : ""}${text}`);
      if (!touch) textarea.current?.focus();
    },
    [touch],
  );
  const voice = useVoiceInput(threadId, dictated);

  const mention = (b: Bot) => {
    setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@${handleOf(b.name)} `);
    focusField();
  };

  const onPick = useStableCallback(pick);
  const onDecide = useStableCallback(decide);
  const onEdit = useStableCallback(edit);
  const onReply = useStableCallback(replyTo);
  const onJump = useCallback((id: string) => setJump((j) => ({ id, n: (j?.n ?? 0) + 1 })), []);

  if (missing || (infoFailed && !info)) {
    return (
      <Empty className="flex-1 pt-[var(--safe-top)] pb-[var(--safe-bottom)]">
        <EmptyHeader>
          <EmptyTitle>{missing ? "That conversation is gone." : "Couldn't load this conversation."}</EmptyTitle>
          <EmptyDescription>{missing ? "It may have been deleted. Pick another one from your chats." : "Check your connection, then try again."}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button variant="outline" render={<Link href="/app" />} nativeButton={false}>
            <ChevronLeft data-icon="inline-start" aria-hidden="true" />
            Back to chats
          </Button>
          {missing ? null : <Button onClick={() => void loadInfo()}>Try again</Button>}
        </EmptyContent>
      </Empty>
    );
  }

  const busy = Object.keys(working).length > 0 || Boolean(info?.busy.length);
  const members = isRoom && info ? info.thread.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)) : [];
  // In a room, @ offers only the bots in it.
  const mentionable = isRoom ? members : bots;
  const row = threads.find((t) => t.id === threadId);
  const driving = (bot ? [bot] : roomDrivers).filter((b) => desktop?.drivers.some((driver) => driver.threadId === threadId && driver.botId === b.id));
  const screenProps = { open: screen, onExpand: setScreen, onCollapse: () => setScreen(null) };
  // A wide screen already shows the details beside the chat, so there the bot's pill opens its profile.
  const openPill = () => {
    if (!window.matchMedia("(width >= 64rem)").matches || document.documentElement.dataset.shell === "phone") setDetails(true);
    else if (bot) openShellDialog({ kind: "edit-bot", botId: bot.id });
    else openShellDialog({ kind: "edit-room", threadId });
  };
  // A bot's chat names its bot before the conversation's details load, so the menu is never a room's.
  const rowBot = bot ?? (row?.botId ? bots.find((b) => b.id === row.botId) : undefined);
  const actions = row && (row.kind === "room" || rowBot) ? threadActions({ thread: row, bot: rowBot, bots, onOpen: openShellDialog, onAsk: setAsk, refresh }) : [];

  return (
    <div className="flex min-h-0 flex-1">
      <section className="relative flex min-w-0 flex-1 flex-col" style={{ "--composer-h": `${composerHeight}px` } as CSSProperties} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {dropping ? (
          <div className="pointer-events-none absolute inset-0 z-30 flex bg-background/92 p-3 pt-[calc(12px+var(--safe-top))] pb-[max(12px,var(--safe-bottom))]">
            <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-3xl border-2 border-dashed border-primary-edge-focus text-center">
              <span className="flex size-14 items-center justify-center rounded-full border border-primary-edge bg-primary text-primary-foreground">
                <Paperclip className="size-6" aria-hidden="true" />
              </span>
              <p className="text-lg font-semibold">Drop to attach</p>
              <p className="text-sm text-muted-foreground">Pictures, PDFs and text files, up to {MAX_FILES} at a time</p>
            </div>
          </div>
        ) : null}

        <header className={cn("pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[calc(64px+var(--safe-top))] items-center gap-2 px-3 pt-[var(--safe-top)] sm:px-4", nativeChrome && "invisible")}>
          <Button size="icon-xl" aria-label="Back to chats" render={<Link href="/app" />} nativeButton={false} className="pointer-events-auto wide:hidden">
            <ChevronLeft aria-hidden="true" />
          </Button>
          <h1 className="sr-only">{info?.thread.name ?? "Conversation"}</h1>
          <Button size="xl" onClick={openPill} aria-label={bot ? `${bot.name}'s details` : "Room details"} data-native-avatar="" className="pointer-events-auto min-w-0 shrink gap-2 pl-1.5 text-left">
            {bot ? <BotAvatar bot={bot} size={32} /> : <RoomAvatar bots={roomBots} size={32} />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] leading-5 font-semibold">{info?.thread.name ?? "…"}</span>
              <span className={cn("truncate text-[11px] leading-3.5 font-normal opacity-70", (busy || boxUpdating) && "shimmer")}>
                {bot ? bot.title || "Teammate" : info ? `${info.thread.members.length} bots` : ""}
                {boxUpdating ? " · the computer is updating, replies wait" : busy ? " · working" : waitingOnYou ? " · waiting on you" : watches.length ? ` · watching ${watches.length === 1 ? "1 thing" : `${watches.length} things`}` : ""}
              </span>
            </span>
          </Button>
          <span className="flex-1" />

          <Tooltip>
            <TooltipTrigger render={<Button size="icon-xl" aria-label="Toggle details" aria-pressed={panel} onClick={() => setPanel((p) => !p)} className={cn("pointer-events-auto hidden xwide:inline-flex", panel && "bg-primary-hover")} />}>
              <PanelRight aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>Details</TooltipContent>
          </Tooltip>
          {actions.length ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-xl" aria-label="More" className="pointer-events-auto" />}>
                <EllipsisVertical aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                {actions.map((group, i) => (
                  <Fragment key={i}>
                    {i > 0 ? <DropdownMenuSeparator /> : null}
                    <DropdownMenuGroup>
                      {group.map((action) => (
                        <DropdownMenuItem key={action.id} variant={action.destructive ? "destructive" : "default"} onClick={action.run}>
                          <action.icon aria-hidden="true" />
                          {action.label}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </header>
        {driving.length && !screen ? (
          <div className="pointer-events-none absolute inset-x-0 top-[calc(64px+var(--safe-top))] z-20 flex flex-wrap justify-center gap-2 px-3 wide:hidden">
            {driving.map((b) => (
              <Button key={b.id} size="lg" onClick={() => setScreen(b.id)} className="pointer-events-auto">
                {driving.length > 1 ? <BotAvatar bot={b} size={20} /> : <Monitor data-icon="inline-start" aria-hidden="true" />}
                {driving.length > 1 ? `${b.name}'s screen` : "Watching the screen"}
              </Button>
            ))}
          </div>
        ) : null}

        <MessageScrollerProvider autoScroll>
          <JumpToMessage id={jumpTo} ready={messages.length > 0} loaded={earlier === false} earlier={loadEarlier} />
          {jump ? <JumpToMessage key={jump.n} id={jump.id} ready={messages.length > 0} loaded={earlier === false} earlier={loadEarlier} /> : null}
          <FollowSent id={sent} />
          <MessageScroller className="flex-1">
            <MessageScrollerViewport preserveScrollOnPrepend className="px-3 pt-[calc(64px+var(--safe-top))] pb-(--composer-h) sm:px-4">
              <MessageScrollerContent className="gap-3 py-4">
                {earlier && messages.length > 0 ? (
                  <MessageScrollerItem>
                    <LoadEarlier onLoad={loadEarlier} />
                  </MessageScrollerItem>
                ) : null}
                {earlier === null && !loadFailed ? (
                  <MessageScrollerItem className="flex flex-col gap-3" aria-label="Loading the conversation">
                    <Skeleton className="h-10 w-2/3 self-end rounded-2xl" />
                    <Skeleton className="h-24 w-3/4 rounded-2xl" />
                    <Skeleton className="h-10 w-1/2 self-end rounded-2xl" />
                  </MessageScrollerItem>
                ) : null}
                {loadFailed && messages.length === 0 ? (
                  <MessageScrollerItem className="m-auto">
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>Couldn&apos;t load this conversation.</EmptyTitle>
                        <EmptyDescription>Nothing is lost. Check the connection and try again.</EmptyDescription>
                      </EmptyHeader>
                      <EmptyContent>
                        <Button variant="outline" onClick={() => void loadMessages(null)}>
                          Try again
                        </Button>
                      </EmptyContent>
                    </Empty>
                  </MessageScrollerItem>
                ) : null}
                {messages.length === 0 && info && !loadFailed && earlier !== null ? (
                  <MessageScrollerItem className="m-auto">
                    <Empty>
                      <EmptyHeader>
                        <EmptyMedia>{bot ? <BotAvatar bot={bot} size={56} greet /> : <RoomAvatar bots={members} size={64} />}</EmptyMedia>
                        <EmptyTitle>{bot ? `${bot.name} is ready.` : "Say what needs doing."}</EmptyTitle>
                        <EmptyDescription>{bot ? "Give it a task with the outcome, the sources, what it must avoid, and what to return." : "Mention a bot with @ to address it. With nobody named, your primary bot answers."}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </MessageScrollerItem>
                ) : null}
                <WatchesContext.Provider value={watches}>
                {messages.map((m) => (
                  <MessageScrollerItem key={m.id} messageId={m.id} className={cn((m.id === jumpTo || m.id === flash) && "rounded-2xl ring-2 ring-ring/40")}>
                    <Line message={m} threadId={threadId} bots={bots} threads={threads} bot={bot} approvals={approvalMap} isRoom={Boolean(isRoom)} editing={editing === m.id} stops={Boolean(info?.answering?.includes(m.id))} touch={touch} answer={answers.get(m.id)} sentTo={sentTo.get(m.id)} noticed={runs.get(m.id)} reveal={revealIn(m, reveals)} onPick={onPick} onView={setViewing} onDecide={onDecide} onOpenExchange={setExchange} onEdit={onEdit} onSelectText={setSelectText} onReacted={replaceMessage} onReply={onReply} onJump={onJump} />
                  </MessageScrollerItem>
                ))}
                </WatchesContext.Provider>
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
                    <WorkLines working={workingBots} label={names(workingBots.map((w) => w.bot.name))} />
                  </MessageScrollerItem>
                ) : (
                  Object.entries(working)
                    .filter(([botId]) => !(botId in writing) && !drawing.has(botId))
                    .map(([botId, line]) => (
                      <MessageScrollerItem key={`working-${botId}`}>
                        <WorkLine bot={bots.find((x) => x.id === botId)} line={line} />
                      </MessageScrollerItem>
                    ))
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerEdges top="calc(64px + var(--safe-top) + 24px)" bottom="calc(var(--composer-h) + 24px)" />
            <MessageScrollerButton className="data-[direction=end]:bottom-[calc(var(--composer-h)+8px)]" />
          </MessageScroller>
        </MessageScrollerProvider>

        <form
          onSubmit={send}
          ref={composer}
          data-native-composer={nativeChrome ? "" : undefined}
          // Under the app's composer the page keeps its own in place, unseen, so what sits above it (the
          // bots to mention, files, a quote, the / list) and the messages' padding stay where they were.
          style={nativeChrome ? { paddingBottom: "var(--native-composer-bottom, max(12px, var(--safe-bottom)))" } : undefined}
          className={cn("pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pt-2.5 pb-[max(12px,var(--safe-bottom))] sm:px-4 sm:pt-3 [&>*]:pointer-events-auto", nativeChrome && "transition-[padding] duration-250 ease-out")}
        >
          {members.length ? (
            // One row a thumb swipes along on a phone, however many bots; on a wide screen they wrap.
            <div className="-mx-3 mb-2 flex max-w-[calc(100%+1.5rem)] gap-1.5 overflow-x-auto overscroll-x-contain px-3 py-1 sm:-mx-4 sm:max-w-[calc(100%+2rem)] sm:px-4 wide:mx-0 wide:max-w-full wide:flex-wrap wide:overflow-visible wide:px-0">
              {members.map((b) => (
                <Button key={b.id} type="button" size="sm" onClick={() => mention(b)} className="shrink-0 gap-1.5 pl-1 text-[13px]">
                  <BotAvatar bot={b} size={20} />@{handleOf(b.name)}
                </Button>
              ))}
            </div>
          ) : null}
          {files.length ? (
            <AttachmentGroup className="mb-2">
              {files.map((file, i) => (
                <Attachment key={`${file.name}-${i}`} size="sm" state="idle">
                  <AttachmentMedia variant="icon">
                    <Paperclip />
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle>{file.name}</AttachmentTitle>
                    <AttachmentDescription>{formatBytes(file.size)}</AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, at) => at !== i))}>
                      <X />
                    </AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              ))}
            </AttachmentGroup>
          ) : null}
          {notice ? (
            <Alert variant="destructive" className="mb-2">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : paused ? (
            <Marker className="mx-auto mb-2 w-fit justify-center rounded-full bg-background px-3" role="status">
              <MarkerContent className="text-xs">Live updates paused. Checking for replies every few seconds.</MarkerContent>
            </Marker>
          ) : null}
          {replying ? <ReplyingTo name={nameOf(replying.author, bots)} color={colorOf(replying.author, bots)} text={quoteText(replying)} onCancel={() => setReplying(null)} /> : null}
          <div className="relative flex items-end gap-2.5">
          {slash ? <SlashMenu kind={slash.kind} skills={skills} bots={mentionable} query={slash.query} selected={slash.selected} onPickSkill={(skill) => insertSkill(skill.slug)} onPickBot={insertBot} /> : null}
          <Tooltip>
            <TooltipTrigger render={<Button size="icon-xl" aria-label="Attach files" render={<label />} nativeButton={false} className={cn("cursor-pointer", nativeChrome && "invisible")} />}>
              <Plus aria-hidden="true" />
              <input type="file" multiple className="sr-only" accept="image/*,.pdf,.txt,.md,.csv,.json" onChange={(e) => {
                attach([...(e.target.files ?? [])]);
                e.target.value = "";
              }} />
            </TooltipTrigger>
            <TooltipContent>Attach files</TooltipContent>
          </Tooltip>

          <InputGroup variant="pill" className={cn("min-h-11 rounded-[22px] pr-1.5", nativeChrome && "invisible overflow-hidden")} style={nativeChrome ? { height: "var(--native-composer-height, 44px)" } : undefined}>
            <InputGroupTextarea
              ref={textarea}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setRecall(null);

                if (notice) setNotice(null);
                trackSlash(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={onKey}
              onBlur={() => window.setTimeout(() => setSlash(null), 120)}
              onPaste={onPaste}
              rows={1}
              placeholder={replying ? `Reply to ${nameOf(replying.author, bots)}` : busy && !isRoom ? "Add to it, or say stop" : bot ? `Message ${bot.name}` : answersNext.length ? `${names(answersNext)} ${answersNext.length > 1 ? "answer" : "answers"} next` : "Message the room"}
              aria-label={bot ? `Message ${bot.name}` : "Message the room"}
              enterKeyHint={touch ? "enter" : "send"}
              // An empty field is one row whatever its hint, so a long one never makes the pill taller.
              className="max-h-40 min-h-[42px] px-4 py-2.5 text-[16px] leading-5 placeholder-shown:h-[42px] placeholder-shown:overflow-hidden placeholder-shown:[field-sizing:fixed] placeholder:truncate sm:text-[14px]"
            />
            <InputGroupAddon align="inline-end" className="mr-0 gap-1 self-end pt-0 pr-0 pb-[5px] has-[>button]:mr-0">

              {busy && draft.trim() && !files.length ? (
                <Tooltip>
                  <TooltipTrigger render={<InputGroupButton type="button" variant="ghost" size="sm" aria-label="Send after it finishes" disabled={sending} onClick={() => void send(undefined, true)} className="rounded-full" />}>
                    <ListEnd aria-hidden="true" />
                    <span className="hidden pointer-coarse:inline">Later</span>
                  </TooltipTrigger>
                  <TooltipContent>Send after it finishes</TooltipContent>
                </Tooltip>
              ) : null}
              <VoiceButton input={voice} />
              <Tooltip>
                <TooltipTrigger render={<InputGroupButton type="submit" variant="tint" size="icon-sm" aria-label="Send" disabled={sending || (!draft.trim() && !files.length)} className="rounded-full" />}>
                  <ArrowUp aria-hidden="true" />
                </TooltipTrigger>
                <TooltipContent>{touch ? "Send" : "Send (Enter)"}</TooltipContent>
              </Tooltip>
            </InputGroupAddon>
          </InputGroup>
          </div>
        </form>
      </section>
      {panel && info ? <RightPanel thread={info.thread} bot={bot} working={busy} screen={screenProps} /> : null}
      {info ? <DetailsSheet open={details} onOpenChange={setDetails} thread={info.thread} bot={bot} working={busy} screen={screenProps} /> : null}
      {screen ? <ScreenPanel threadId={threadId} botId={screen} expanded onExpand={() => setScreen(screen)} onCollapse={() => setScreen(null)} /> : null}
      {nativeChrome ? (
        <ConversationChrome
          thread={threadId}
          avatarKey={JSON.stringify((bot ? [bot] : roomBots).map((b) => [b.id, b.color, b.shape, b.avatar, b.expression]))}
          title={info?.thread.name ?? "…"}
          subtitle={`${bot ? bot.title || "Teammate" : info ? `${info.thread.members.length} bots` : ""}${boxUpdating ? " · the computer is updating, replies wait" : busy ? " · working" : waitingOnYou ? " · waiting on you" : watches.length ? ` · watching ${watches.length === 1 ? "1 thing" : `${watches.length} things`}` : ""}`}
          working={busy || boxUpdating}
          more={bot ? 0 : Math.max(0, roomBots.length - 2)}
          primary={Boolean(bot?.primary)}
          menu={actions}
          composer={{
            text: draft,
            focusRev,
            placeholder: replying ? `Reply to ${nameOf(replying.author, bots)}` : busy && !isRoom ? "Add to it, or say stop" : bot ? `Message ${bot.name}` : answersNext.length ? `${names(answersNext)} ${answersNext.length > 1 ? "answer" : "answers"} next` : "Message the room",
            canSend: !sending && Boolean(draft.trim() || files.length),
            sending,
            later: busy && Boolean(draft.trim()) && !files.length,
            voice: voice.transcribing ? "working" : voice.recording ? "recording" : voice.ready ? "idle" : "off",
            seconds: voice.seconds,
          }}
          onEvent={(event) => {
            if (event.type === "back") router.push("/app");
            else if (event.type === "details") openPill();
            else if (event.type === "menu") actions.flat().find((action) => action.id === event.id)?.run();
            else if (event.type === "text") {
              setDraft(event.value);
              setRecall(null);
              if (notice) setNotice(null);
              trackSlash(event.value, event.value.length);
            } else if (event.type === "send") void send(undefined, Boolean(event.later));
            else if (event.type === "voice") void voice.toggle();
            else if (event.type === "attach") void filesFrom(event.files).then(attach, () => setNotice("Couldn't attach that file."));
            else if (event.type === "notice") setNotice(event.text);
          }}
        />
      ) : null}
      <ThreadConfirms ask={ask} onClose={() => setAsk(null)} />
      <SelectTextDialog text={selectText} onClose={() => setSelectText(null)} />
      <ImageViewer images={pictures} openId={viewing} onOpenId={setViewing} />

      {exchange ? <ExchangeDialog threadId={threadId} withThreadId={exchange} onClose={() => setExchange(null)} /> : null}
    </div>
  );
}
