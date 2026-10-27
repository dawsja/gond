"use client";

import { handleOf, plainMarkdown, REACTIONS, roomTargets, type Approval, type ApprovalAnswer, type Bot, type ChatAttachment, type ImageAspect, type LiveEvent, type Message, type ReactionEmoji, type Thread, type ThreadSpace } from "@gond/shared";
import { inertChoices, remoteMember, spaceMentionables, spaceSubtitle } from "@/lib/spaces";
import { ArrowUp, ChevronLeft, Copy, CornerUpLeft, Download, ListEnd, EllipsisVertical, File as FileIcon, FileArchive, FileHeadphone, FilePlay, FileSpreadsheet, FileText, Lock, Monitor, PanelRight, Paperclip, Pencil, Phone, Plus, RotateCcw, TextSelect, Undo2, X } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ApprovalCard } from "@/components/approval-card";
import { ControlCard, handOffOpen } from "@/components/control-card";
import { QuoteInBubble, ReplyingTo } from "@/components/reply-quote";
import { BotAvatar, RoomAvatar, roomMembers } from "@/components/bot-avatar";
import { CallButton, CallComposer, callLabel, useDial } from "@/components/call/call-controls";
import { useCall } from "@/components/call/call-provider";
import { ConversationChrome } from "@/components/conversation-chrome";
import { NoteBadge } from "@/components/note-badge";
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
import { failed } from "@/components/failed";
import { openShellDialog } from "@/components/shell";
import { SignInCard } from "@/components/signin-card";
import { matchMentions, matchSkills, MentionFace, mentionOfBot, SlashMenu, slashQuery, useSkillsLibrary, type Mentionable } from "@/components/slash-menu";
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
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerEdges, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller, useMessageScrollerScrollable } from "@/components/ui/message-scroller";
import { toast } from "@/components/ui/toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVoiceInput, VoiceButton } from "@/components/voice-button";
import { WorkLine, WorkLines } from "@/components/work-log";
import { useCoarsePointer } from "@/hooks/use-mobile";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { REPLY_DISTANCE, useSwipeToReply } from "@/hooks/use-swipe-to-reply";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { api, ApiError, post } from "@/lib/api";
import { readDraft, saveDraft } from "@/lib/drafts";
import { fileKind, type FileKind } from "@/lib/file-kind";
import { editUnread, retryTurn, unsend } from "@/lib/message-actions";
import { botsWaitingOnYou, notReadYet, WAITING_FOR_YOU } from "@/lib/message-state";
import { historyStep, sentHistory } from "@/lib/sent-history";
import { TeachCard } from "@/components/teach/teach-card";
import { TeachPillFor } from "@/components/teach/teach-controls";
import { askNative, filesFrom, useNativeCallBar, useNativeUi, type NativeMenuItem } from "@/lib/native-ui";
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

function FileKindIcon({ kind }: { kind: FileKind }) {
  switch (kind) {
    case "spreadsheet":
      return <FileSpreadsheet />;
    case "document":
      return <FileText />;
    case "audio":
      return <FileHeadphone />;
    case "video":
      return <FilePlay />;
    case "archive":
      return <FileArchive />;
    default:
      return <FileIcon />;
  }
}

// A search hit or a tapped quote's message, ringed for a moment; the ring fades as it goes.
const RING = "transition-shadow duration-500";
const RINGED = "ring-2 ring-ring/40";

/** A turn that failed on the person's message, with a way to go again. */
function FailedTurn({ message, highlighted }: { message: Message & { answering: string }; highlighted: boolean }) {
  const [busy, setBusy] = useState(false);
  const retry = () => {
    setBusy(true);
    // Done, this line goes with the reload; only a failure leaves it here.
    void retryTurn(message.threadId, message.answering)
      .catch(failed("Couldn't try again."))
      .finally(() => setBusy(false));
  };
  return (
    <Marker className="flex-col justify-center gap-2">
      <MarkerContent className={cn("max-w-[80%] rounded-md text-center text-xs", RING, highlighted && RINGED)}>{message.body}</MarkerContent>
      <Button variant="outline" size="sm" disabled={busy} onClick={retry}>
        {busy ? <Spinner data-icon="inline-start" /> : <RotateCcw data-icon="inline-start" aria-hidden="true" />}
        Try again
      </Button>
    </Marker>
  );
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
        <NoteBadge note={message.note} />
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

function EditBubble({ message, touch, stops, inPlace, onCancel, onSend }: { message: Message; touch: boolean; stops: boolean; inPlace: boolean; onCancel: () => void; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState(message.body);
  const [sending, setSending] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = field.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);
  // A line with files may lose its words when it changes in place; one sent again needs some.
  const changed = text.trim() !== message.body.trim() && Boolean(text.trim() || (inPlace && message.attachments.length));
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

      <p className="px-1 text-right text-[11.5px] text-muted-foreground">{inPlace ? "Not read yet, so it changes in place." : stops ? "Sending stops the work here, then starts again with your fix." : "Sent again as a new message."}</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={sending} className="pointer-coarse:h-11 pointer-coarse:px-4">
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!changed || sending} className="pointer-coarse:h-11 pointer-coarse:px-4">
          {inPlace ? (sending ? "Saving…" : "Save") : sending ? "Sending…" : stops ? "Stop and send" : "Send"}
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

/** What a space that isn't open says over the composer. */
function spaceNotice(space: ThreadSpace): string {
  if (space.status === "joining") return `Waiting for ${space.gonds.find((g) => g.host)?.name ?? "the other Gond"} to let you in. What you write meanwhile stays here.`;
  return `This space is ${space.status === "left" ? "one you left" : "closed"}, so what you write here stays here and no bot answers.`;
}

function nameOf(author: string, bots: Bot[], space?: ThreadSpace | null): string {
  if (author === "you") return "You";
  return remoteMember(space, author)?.name ?? bots.find((b) => b.id === author)?.name ?? "A bot";
}

function colorOf(author: string, bots: Bot[], space?: ThreadSpace | null): string | null {
  if (author === "you") return null;
  const remote = remoteMember(space, author);
  return remote ? remote.color : (bots.find((b) => b.id === author)?.color ?? null);
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

/** `unread` is what shows under the person's line no bot has read yet; only such a line edits in place or unsends. */
const Line = memo(function Line({ message, threadId, bots, threads, bot, approvals, isRoom, space, editing, latestHandOff, stops, touch, answer, inert, sentTo, noticed, reveal, highlighted, unread, onPick, onView, onDecide, onOpenExchange, onEdit, onUnsend, onSelectText, onReacted, onReply, onJump }: { message: Message; threadId: string; bots: Bot[]; threads: ThreadRow[]; bot: Bot | null; approvals: Map<string, Approval>; isRoom: boolean; space: ThreadSpace | null; editing: boolean; latestHandOff: boolean; stops: boolean; touch: boolean; answer: string | undefined; inert: boolean; sentTo: string | undefined; noticed: Noticed | undefined; reveal: PictureReveal | undefined; highlighted: boolean; unread: string | undefined; onPick: (option: string, from: string) => Promise<void>; onView: (attachmentId: string) => void; onDecide: (id: string, answer: ApprovalAnswer) => Promise<void>; onOpenExchange: (withThreadId: string) => void; onEdit: (message: Message | null, text?: string) => Promise<boolean>; onUnsend: (message: Message) => void; onSelectText: (text: string) => void; onReacted: (message: Message) => void; onReply: (message: Message) => void; onJump: (id: string) => void }) {
  const mine = message.author === "you";
  const bubble = useRef<HTMLDivElement>(null);
  const native = useNativeUi();
  // The tap that ends a long press still clicks the bubble; it shouldn't also show the time.
  const menuOpenedAt = useRef(0);

  const [selected, setSelected] = useState("");
  const [timed, setTimed] = useState(false);
  const [swipe, setSwipe] = useState(0);
  const replyable = message.kind === "message" && !message.fromThreadId && message.author !== "routine" && message.author !== "system";
  useSwipeToReply(bubble, touch && replyable, setSwipe, () => onReply(message));
  const choices = useMemo(() => (mine || inert ? {} : { pick: (option: string) => onPick(option, message.author), picked: answer }), [mine, inert, onPick, message.author, answer]);

  const author = mine ? null : bots.find((b) => b.id === message.author) ?? null;
  const remote = remoteMember(space, message.author);
  if (message.kind === "prompt") return null;
  if (message.kind === "message" && message.fromThreadId && author) return <Handoff message={message} threadId={threadId} bots={bots} threads={threads} onOpen={onOpenExchange} />;
  if (message.author === "routine") return <RunMarker message={message} bot={bot} />;
  if (message.kind === "event") {
    if (message.author === "system" && message.answering) return <FailedTurn message={{ ...message, answering: message.answering }} highlighted={highlighted} />;
    return (
      <Marker className="justify-center">
        <MarkerContent className={cn("max-w-[80%] rounded-md text-center text-xs", RING, highlighted && RINGED)}>{message.body}</MarkerContent>
      </Marker>
    );
  }
  if (message.kind === "teach") {
    return (
      <MessageRow align="start">
        <MessageContent>
          <div className={cn("w-full max-w-[440px] rounded-3xl", RING, highlighted && RINGED)}>
            <TeachCard message={message} bot={author ?? bot ?? undefined} />
          </div>
        </MessageContent>
      </MessageRow>
    );
  }
  if (message.kind === "control") {
    return (
      <MessageRow align="start">
        <MessageContent>
          <div className={cn("w-full max-w-[440px] rounded-3xl", RING, highlighted && RINGED)}>
            <ControlCard message={message} bot={author ?? bot ?? undefined} latest={latestHandOff} />
          </div>
        </MessageContent>
      </MessageRow>
    );
  }
  if (message.kind === "approval" || message.kind === "secret" || message.kind === "signin") {
    return (
      <MessageRow align="start">
        <MessageContent>
          <div className={cn("w-full max-w-[440px] rounded-3xl", RING, highlighted && RINGED)}>
          {message.kind === "signin" ? <SignInCard message={message} bot={author ?? bot ?? undefined} /> : message.kind === "secret" ? <SecretCard message={message} bot={author ?? bot ?? undefined} /> : <ApprovalCard message={message} approval={message.approvalId ? approvals.get(message.approvalId) ?? null : null} bot={author ?? bot ?? undefined} noticed={Boolean(noticed)} onDecide={onDecide} />}
          </div>
        </MessageContent>
      </MessageRow>
    );
  }
  const showName = !mine && (isRoom || message.author === "routine" || message.author === "system");
  const pictures = message.attachments.filter(isPicture);
  const files = message.attachments.filter((file) => !isPicture(file));
  const hasBubble = Boolean(message.replyTo || message.body || files.length);
  const editable = mine && Boolean(message.body.trim()) && message.attachments.length === 0;
  // Not read yet: it changes in place (attachments stay) and can be taken back; otherwise an edit is sent again.
  const takeBack = Boolean(unread);
  const editsInPlace = takeBack;
  const edits = editsInPlace || editable;
  const reactable = canReact(message);
  const menu = Boolean(message.body) || edits || takeBack || reactable || replyable;
  const reactWith = (emoji: ReactionEmoji) => void react(message, emoji, onReacted);
  // On the iPhone a long press lifts the bubble into the app's own menu, with the reactions above it.
  const openNativeMenu = async () => {
    const node = bubble.current;
    if (!node) return;
    menuOpenedAt.current = Date.now();
    // The badges hang below the bubble, so the lifted copy would cut them; the reactions bar shows them anyway.
    node.dataset.lifting = "";
    const box = node.getBoundingClientRect();
    const items: NativeMenuItem[] = [];
    if (replyable) items.push({ id: "reply", label: "Reply", symbol: "arrowshape.turn.up.left" });
    if (message.body) items.push({ id: "copy", label: "Copy text", symbol: "doc.on.doc" });
    if (message.body) items.push({ id: "select", label: "Select text", symbol: "character.cursor.ibeam" });
    if (edits) items.push({ id: "edit", label: editsInPlace ? "Edit" : "Edit and resend", symbol: "pencil" });
    if (takeBack) items.push({ id: "unsend", label: "Unsend", symbol: "arrow.uturn.backward", destructive: true });
    const picked = await askNative({
      kind: "message",
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      mine,
      reactions: reactable ? { options: REACTIONS, mine: message.reactions.find((r) => r.author === "you")?.emoji ?? null } : null,
      items,
    });
    delete node.dataset.lifting;
    if (picked?.react && (REACTIONS as readonly string[]).includes(picked.react)) reactWith(picked.react as ReactionEmoji);
    else if (picked?.action === "reply") onReply(message);
    else if (picked?.action === "copy") void copyToClipboard(copyText(message.body)).then((ok) => toast.add(ok ? { title: "Copied." } : { type: "error", title: "Couldn't copy it." }));
    else if (picked?.action === "select") onSelectText(copyText(message.body));
    else if (picked?.action === "edit") void onEdit(message);
    else if (picked?.action === "unsend") onUnsend(message);
  };
  if (editing) {
    return (
      <MessageRow align="end">
        <MessageContent className="gap-1">
          <EditBubble
            message={message}
            touch={touch}
            stops={stops}
            inPlace={Boolean(unread)}
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
        {showName ? (
          <MessageHeader>
            {remote ? (
              <>
                {remote.name}
                <span className="ml-1.5 rounded-full border border-primary-edge px-1.5 text-[10.5px] font-semibold text-muted-foreground">{remote.gondName}</span>
              </>
            ) : (
              (author?.name ?? (message.author === "routine" ? "Routine" : "Gond"))
            )}
          </MessageHeader>
        ) : null}

        <ContextMenu onOpenChange={(open) => setSelected(open ? selectionIn(bubble.current) : "")}>
        <ContextMenuTrigger
          ref={bubble}
          onClick={(event) => Date.now() - menuOpenedAt.current > 1500 && showsTime(event) && setTimed((on) => !on)}
          onContextMenu={(event) => {
            if (native && touch) {
              event.preventDefault();
              event.preventBaseUIHandler();
              if (menu) void openNativeMenu();
              return;
            }
            // A right click on a link gets the browser's own menu (open in a new tab, copy the address).
            if (!touch && event.target instanceof Element && event.target.closest("a[href]")) event.preventBaseUIHandler();
          }}
          className={cn("group/lift touch-pan-y select-text pointer-coarse:select-none", !swipe && "transition-transform duration-200")}
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
                <button key={file.id} type="button" onClick={() => onView(file.id)} aria-label={`View ${file.name}`} className={cn("relative block max-w-full cursor-zoom-in overflow-hidden rounded-3xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50", RING, highlighted && !hasBubble && RINGED)}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/attachments/${file.id}`} alt={file.name} className="block max-h-90 w-auto max-w-full" />
                  {reveal?.file === file.id ? <PictureFall reveal={reveal} /> : null}
                </button>
              ))}
            </div>
          ) : null}
          {hasBubble ? (
          <BubbleContent className={cn("rounded-2xl px-3.5 py-2", RING, highlighted && RINGED)}>
            {message.replyTo ? <QuoteInBubble quote={message.replyTo} name={nameOf(message.replyTo.author, bots, space)} color={colorOf(message.replyTo.author, bots, space)} onJump={onJump} /> : null}
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
                      <FileKindIcon kind={fileKind(file)} />
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
          {menu ? (
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
                {edits ? (
                  <ContextMenuItem onClick={() => void onEdit(message)}>
                    <Pencil aria-hidden="true" />
                    {editsInPlace ? "Edit" : "Edit and resend"}
                  </ContextMenuItem>
                ) : null}
                {takeBack ? (
                  <ContextMenuItem variant="destructive" onClick={() => onUnsend(message)}>
                    <Undo2 aria-hidden="true" />
                    Unsend
                  </ContextMenuItem>
                ) : null}
              </ContextMenuGroup>
            </ContextMenuContent>
          ) : null}
        </ContextMenu>
        {unread ? <p className="self-end pr-1 text-[11.5px] text-muted-foreground">{unread}</p> : null}
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

function JumpToMessage({ id, ready, loaded, earlier, onFound }: { id: string | null; ready: boolean; loaded: boolean; earlier: () => Promise<boolean>; onFound: (id: string) => void }) {
  const { scrollToMessage } = useMessageScroller();
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !ready || done === id) return;
    const timer = window.setTimeout(() => {
      if (scrollToMessage(id, { align: "center" })) {
        onFound(id);
        return setDone(id);
      }
      if (loaded) return;
      void earlier().then((more) => {
        if (more) return;
        setDone(id);
        toast.add({ title: "That message isn't in this conversation any more." });
      });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [id, ready, loaded, done, scrollToMessage, earlier, onFound]);
  return null;
}

function FollowSent({ id }: { id: string | null }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (id) scrollToEnd();
  }, [id, scrollToEnd]);
  return null;
}

/** Keeps the newest message in view when the composer grows (the keyboard under the iPhone app's, a longer draft), if it was in view. */
function FollowComposer({ height }: { height: number }) {
  const { scrollToEnd } = useMessageScroller();
  const { end } = useMessageScrollerScrollable();
  const atEnd = useRef(!end);
  const last = useRef(height);
  useEffect(() => {
    if (height === last.current) return;
    const grew = height > last.current;
    last.current = height;
    if (grew && atEnd.current) scrollToEnd({ behavior: "smooth" });
  }, [height, scrollToEnd]);
  useEffect(() => {
    atEnd.current = !end;
  }, [end]);
  return null;
}

/** Under the iPhone app's chrome: says whether there is newer to scroll to, and scrolls there when the app's arrow is tapped. */
function NativeJump({ onCanJump, jumpRev }: { onCanJump: (can: boolean) => void; jumpRev: number }) {
  const { scrollToEnd } = useMessageScroller();
  const { end } = useMessageScrollerScrollable();
  useEffect(() => {
    void Promise.resolve().then(() => onCanJump(end));
  }, [end, onCanJump]);
  useEffect(() => {
    if (jumpRev) scrollToEnd({ behavior: "smooth" });
  }, [jumpRev, scrollToEnd]);
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
  const { call, end: hangUp, toggleMute } = useCall();
  const onCall = call?.info.threadId === threadId ? call : null;
  // In the iPhone app the header and the composer are the app's own, in Liquid Glass (`ConversationChrome`),
  // a call's bar too; an app too old to draw one leaves the chrome to the page for a call.
  const nativeCallBar = useNativeCallBar();
  const nativeChrome = useNativeUi() && (!onCall || nativeCallBar);
  const [focusRev, setFocusRev] = useState(0);
  const [canJump, setCanJump] = useState(false);
  const [jumpRev, setJumpRev] = useState(0);
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
  // The message a jump landed on, ringed until the ring fades.
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  const flashOn = useCallback((id: string) => {
    setFlash(id);
    if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 1600);
  }, []);
  useEffect(
    () => () => {
      if (flashTimer.current !== null) window.clearTimeout(flashTimer.current);
    },
    [],
  );
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
    // The border box: under the iPhone app's composer only the padding changes, with the keyboard.
    observer.observe(node, { box: "border-box" });
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
  // Until the conversation's details load, whether it is a space is unknown, so assume it is.
  const inSpace = info ? Boolean(info.thread.space) : true;
  const inert = useMemo(() => inertChoices(messages, inSpace), [messages, inSpace]);

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
  // A bot holding a card the person hasn't answered is waiting on them, whatever step it last named.
  const heldOnYou = useMemo(() => botsWaitingOnYou(approvals, threadId), [approvals, threadId]);
  const workLines = Object.entries(working)
    .filter(([botId]) => !(botId in writing) && !drawing.has(botId))
    .map(([botId, line]) => ({ botId, bot: bots.find((b) => b.id === botId), line: heldOnYou.has(botId) ? WAITING_FOR_YOU : line, waiting: heldOnYou.has(botId) }));
  const workingBots = workLines
    .flatMap(({ bot: found, line, waiting }) => (found ? [{ bot: found, line, waiting }] : []))
    .sort((a, b) => Number(b.bot.primary) - Number(a.bot.primary));
  // Which bots work here changes as a turn picks up a line, so the details (what each answers) follow.
  const workingKey = Object.keys(working).sort().join(" ");
  useEffect(() => {
    if (workingKey) void Promise.resolve().then(refreshInfo);
  }, [workingKey, refreshInfo]);
  const isRoom = info?.thread.kind === "room";
  const bot = info?.bot ?? null;
  // Only the primary bot takes calls.
  const callable = bot?.primary ? bot : undefined;
  const calling = useDial(threadId, callable);
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
  const handOff = useMemo(() => messages.findLast((m) => m.kind === "control") ?? null, [messages]);
  // The person's lines no bot has read yet: `waiting` as loaded, until a turn takes one up or a bot answers it.
  const botWorking = Boolean(bot && (bot.id in working || info?.busy.includes(bot.id)));
  const unreadNote = useMemo(() => {
    const taken = new Set(info?.answering ?? []);
    for (const m of messages) if (m.answering && m.author !== "you") taken.add(m.answering);
    const note = notReadYet({ isRoom: Boolean(isRoom), botName: bot?.name ?? null, working: botWorking });
    const map = new Map<string, string>();
    if (info?.thread.space) return map;
    for (const m of messages) if (m.author === "you" && m.waiting && !taken.has(m.id)) map.set(m.id, note);
    return map;
  }, [messages, info, isRoom, bot, botWorking]);
  const waitingOnYou = approvals.some((a) => a.threadId === threadId && a.status === "pending") || handOffOpen(handOff, desktop);

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

  async function saveUnread(message: Message, text: string): Promise<boolean> {
    try {
      const data = await editUnread(threadId, message.id, text);
      setMessages((current) => current.map((m) => (m.id === message.id ? (data?.message ?? { ...m, body: text }) : m)));
      setEditing(null);
      return true;
    } catch (failure) {
      failed("Couldn't change it.")(failure);
      return false;
    }
  }

  function takeBack(message: Message) {
    void unsend(threadId, message.id)
      .then(() => {
        setMessages((current) => current.filter((m) => m.id !== message.id));
        setEditing((now) => (now === message.id ? null : now));
        setReplying((now) => (now?.id === message.id ? null : now));
      })
      .catch(failed("Couldn't unsend it."));
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
    return unreadNote.has(message.id) ? saveUnread(message, text) : resendEdited(message, text);
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
  const insertMention = (who: Mentionable) => insertToken(`@${who.handle}`);

  function trackSlash(text: string, caret: number) {
    const found = slashQuery(text, caret);
    setSlash(found ? { ...found, selected: 0 } : null);
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (slash) {
      const count = slash.kind === "skill" ? matchSkills(skills, slash.query).length : matchMentions(mentionable, slash.query).length;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (count) setSlash({ ...slash, selected: (slash.selected + (event.key === "ArrowDown" ? 1 : count - 1)) % count });
        return;
      }
      if ((event.key === "Tab" || event.key === "Enter") && count && !event.shiftKey) {
        event.preventDefault();
        if (slash.kind === "skill") insertSkill(matchSkills(skills, slash.query)[slash.selected]!.slug);
        else insertMention(matchMentions(mentionable, slash.query)[slash.selected]!);
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
        window.requestAnimationFrame(() => el.setSelectionRange(next.length, next.length));
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

  const mention = (who: Mentionable) => {
    setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@${who.handle} `);
    focusField();
  };

  const onPick = useStableCallback(pick);
  const onDecide = useStableCallback(decide);
  const onEdit = useStableCallback(edit);
  const onUnsend = useStableCallback(takeBack);
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
  const space = info?.thread.space ?? null;
  const roomLine = info ? (space ? spaceSubtitle(space) : info.thread.errand ? "Errands" : `${info.thread.members.length} bots`) : "";
  const errandBot = info?.thread.errand ? bots.find((b) => b.id === info.thread.errand?.botId) : undefined;
  const members = isRoom && info ? info.thread.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)) : [];
  // In a room, @ offers only the bots in it, and in a space the people and bots on the other Gonds too.
  const fromAfar = spaceMentionables(space);
  const chips = isRoom ? [...members.map(mentionOfBot), ...fromAfar] : [];
  const mentionable = isRoom ? chips : bots.filter((b) => !b.hidden).map(mentionOfBot);
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
  const botActions = row && (row.kind === "room" || rowBot) ? threadActions({ thread: row, bot: rowBot, bots, onOpen: openShellDialog, onAsk: setAsk, refresh }) : [];
  // The iPhone app's header has no room for the phone circle, so there the call is first in the menu.
  const actions = nativeChrome && callable && !onCall ? [[{ id: "call", label: `Call ${callable.name}`, icon: Phone, symbol: "phone", run: calling.dial }], ...botActions] : botActions;
  const status = boxUpdating ? " · the computer is updating, replies wait" : onCall ? " · on a call" : busy ? " · working" : waitingOnYou ? " · waiting on you" : watches.length ? ` · watching ${watches.length === 1 ? "1 thing" : `${watches.length} things`}` : "";

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
              <p className="text-sm text-muted-foreground">Any file, up to {MAX_FILES} at a time</p>
            </div>
          </div>
        ) : null}

        <header className={cn("pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[calc(64px+var(--safe-top))] items-center gap-2 px-3 pt-[var(--safe-top)] sm:px-4", nativeChrome && "invisible")}>
          <Button size="icon-xl" aria-label="Back to chats" render={<Link href="/app" />} nativeButton={false} className="pointer-events-auto wide:hidden">
            <ChevronLeft aria-hidden="true" />
          </Button>
          <h1 className="sr-only">{info?.thread.name ?? "Conversation"}</h1>
          <Button size="xl" onClick={openPill} aria-label={bot ? `${bot.name}'s details` : "Room details"} data-native-avatar="" className="pointer-events-auto min-w-0 shrink gap-2 pl-1.5 text-left">
            {bot ? <BotAvatar bot={bot} size={32} /> : <RoomAvatar bots={roomBots} size={32} space={Boolean(space)} />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[15px] leading-5 font-semibold">{info?.thread.name ?? "…"}</span>
              <span className={cn("truncate text-[11px] leading-3.5 font-normal opacity-70", (busy || boxUpdating) && "shimmer")}>
                {space?.status === "active" ? <Lock className="mr-1 inline size-2.5 -translate-y-px" aria-label="End-to-end encrypted" /> : null}
                {bot ? bot.title || "Teammate" : roomLine}
                {status}
              </span>
            </span>
          </Button>
          <span className="flex-1" />

          {callable ? <CallButton threadId={threadId} bot={callable} /> : null}
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
        {driving.length && !screen && !nativeChrome ? (
          <div className="pointer-events-none absolute inset-x-0 top-[calc(64px+var(--safe-top)+var(--call-pill-space))] z-20 flex flex-wrap justify-center gap-2 px-3 wide:hidden">
            {driving.map((b) => (
              <Button key={b.id} size="lg" onClick={() => setScreen(b.id)} className="pointer-events-auto">
                {driving.length > 1 ? <BotAvatar bot={b} size={20} /> : <Monitor data-icon="inline-start" aria-hidden="true" />}
                {driving.length > 1 ? `${b.name}'s screen` : "Watching the screen"}
              </Button>
            ))}
          </div>
        ) : null}

        <MessageScrollerProvider autoScroll>
          <JumpToMessage id={jumpTo} ready={messages.length > 0} loaded={earlier === false} earlier={loadEarlier} onFound={flashOn} />
          {jump ? <JumpToMessage key={jump.n} id={jump.id} ready={messages.length > 0} loaded={earlier === false} earlier={loadEarlier} onFound={flashOn} /> : null}
          <FollowSent id={sent} />
          <FollowComposer height={composerHeight} />
          {nativeChrome ? <NativeJump onCanJump={setCanJump} jumpRev={jumpRev} /> : null}
          <MessageScroller className="flex-1">
            <MessageScrollerViewport preserveScrollOnPrepend className="px-3 pt-[calc(64px+var(--safe-top)+var(--call-pill-space))] pb-(--composer-h) sm:px-4">
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
                        <EmptyMedia>{bot ? <BotAvatar bot={bot} size={56} greet /> : <RoomAvatar bots={members} size={64} space={Boolean(space)} />}</EmptyMedia>
                        <EmptyTitle>{bot ? `${bot.name} is ready.` : "Say what needs doing."}</EmptyTitle>
                        <EmptyDescription>{bot ? "Give it a task with the outcome, the sources, what it must avoid, and what to return." : "Mention a bot with @ to address it. With nobody named, your primary bot answers."}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </MessageScrollerItem>
                ) : null}
                <WatchesContext.Provider value={watches}>
                {messages.map((m) => (
                  <MessageScrollerItem key={m.id} messageId={m.id}>
                    <Line message={m} threadId={threadId} bots={bots} threads={threads} bot={bot} approvals={approvalMap} isRoom={Boolean(isRoom)} space={info?.thread.space ?? null} editing={editing === m.id} latestHandOff={m.id === handOff?.id} stops={Boolean(info?.answering?.includes(m.id))} touch={touch} answer={answers.get(m.id)} inert={inert.has(m.id)} sentTo={sentTo.get(m.id)} noticed={runs.get(m.id)} reveal={revealIn(m, reveals)} highlighted={m.id === flash} unread={unreadNote.get(m.id)} onPick={onPick} onView={setViewing} onDecide={onDecide} onOpenExchange={setExchange} onEdit={onEdit} onUnsend={onUnsend} onSelectText={setSelectText} onReacted={replaceMessage} onReply={onReply} onJump={onJump} />
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
                  workLines.map(({ botId, bot: found, line, waiting }) => (
                    <MessageScrollerItem key={`working-${botId}`}>
                      <WorkLine bot={found} line={line} waiting={waiting} />
                    </MessageScrollerItem>
                  ))
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerEdges top="calc(64px + var(--safe-top) + var(--call-pill-space) + 24px)" bottom="calc(var(--composer-h) + 24px)" />
            {nativeChrome ? null : <MessageScrollerButton className="data-[direction=end]:bottom-[calc(var(--composer-h)+8px)]" />}
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
          {chips.length && !nativeChrome ? (
            // One row a thumb swipes along on a phone, however many bots; on a wide screen they wrap.
            <div className="-mx-3 mb-2 flex max-w-[calc(100%+1.5rem)] gap-1.5 overflow-x-auto overscroll-x-contain px-3 py-1 sm:-mx-4 sm:max-w-[calc(100%+2rem)] sm:px-4 wide:mx-0 wide:max-w-full wide:flex-wrap wide:overflow-visible wide:px-0">
              {chips.map((who) => (
                <Button key={who.id} type="button" size="sm" onClick={() => mention(who)} title={who.detail ?? undefined} className="shrink-0 gap-1.5 pl-1 text-[13px]">
                  <MentionFace who={who} size={20} />@{who.handle}
                </Button>
              ))}
            </div>
          ) : null}
          {files.length && !nativeChrome ? (
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
          <TeachPillFor threadId={threadId} />
          {space && space.status !== "active" ? (
            <Marker className="mx-auto mb-2 w-fit max-w-full justify-center rounded-full bg-background px-3" role="status">
              <MarkerContent className="text-center text-xs">{spaceNotice(space)}</MarkerContent>
            </Marker>
          ) : null}
          {replying && !nativeChrome ? <ReplyingTo name={nameOf(replying.author, bots, space)} color={colorOf(replying.author, bots, space)} text={quoteText(replying)} onCancel={() => setReplying(null)} /> : null}
          {onCall ? <CallComposer call={onCall} bot={bot ?? undefined} className={cn(nativeChrome && "invisible")} /> : (
          <div className="relative flex items-end gap-2.5">
          {slash ? <SlashMenu kind={slash.kind} skills={skills} people={mentionable} query={slash.query} selected={slash.selected} onPickSkill={(skill) => insertSkill(skill.slug)} onPickPerson={insertMention} /> : null}
          <Tooltip>
            <TooltipTrigger render={<Button size="icon-xl" aria-label="Attach files" render={<label />} nativeButton={false} className={cn("cursor-pointer", nativeChrome && "invisible")} />}>
              <Plus aria-hidden="true" />
              <input type="file" multiple className="sr-only" onChange={(e) => {
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
              placeholder={replying ? `Reply to ${nameOf(replying.author, bots, space)}` : busy && !isRoom ? "Add to it, or say stop" : bot ? `Message ${bot.name}` : errandBot ? `Message ${errandBot.name}` : space ? "Message the space" : answersNext.length ? `${names(answersNext)} ${answersNext.length > 1 ? "answer" : "answers"} next` : "Message the room"}
              aria-label={bot ? `Message ${bot.name}` : errandBot ? `Message ${errandBot.name}` : "Message the room"}
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
          )}
        </form>
      </section>
      {panel && info ? <RightPanel thread={info.thread} bot={bot} working={busy} screen={screenProps} /> : null}
      {info ? <DetailsSheet open={details} onOpenChange={setDetails} thread={info.thread} bot={bot} working={busy} screen={screenProps} /> : null}
      {screen ? <ScreenPanel threadId={threadId} botId={screen} expanded onExpand={() => setScreen(screen)} onCollapse={() => setScreen(null)} /> : null}
      {nativeChrome && chips.length ? (
        // The room's faces, unseen, for the app's @mention chips.
        <div aria-hidden="true" className="invisible absolute size-0 overflow-hidden">
          {chips.map((who) => (
            <span key={who.id} data-native-mention={who.id}>
              <MentionFace who={who} size={40} />
            </span>
          ))}
        </div>
      ) : null}
      {nativeChrome ? (
        <ConversationChrome
          thread={threadId}
          avatarKey={JSON.stringify((bot ? [bot] : roomBots).map((b) => [b.id, b.color, b.shape, b.avatar, b.expression]))}
          title={info?.thread.name ?? "…"}
          subtitle={`${bot ? bot.title || "Teammate" : roomLine}${status}`}
          working={busy || boxUpdating}
          more={bot ? 0 : Math.max(0, roomBots.length - 2)}
          mentions={chips.map((who) => ({ id: who.id, handle: who.handle }))}
          files={files.map((file) => ({ name: file.name, size: formatBytes(file.size) }))}
          replying={replying ? { name: nameOf(replying.author, bots, space), color: colorOf(replying.author, bots, space) ?? "", text: quoteText(replying) } : null}
          jump={canJump}
          screens={driving.length && !screen ? driving.map((b) => ({ id: b.id, label: driving.length > 1 ? `${b.name}'s screen` : "Watching the screen" })) : []}
          call={onCall ? { label: callLabel(onCall, bot ?? undefined), since: Date.parse(onCall.info.startedAt), connecting: onCall.phase === "connecting", muted: onCall.muted, speaking: onCall.speaking, color: bot?.color ?? "" } : null}
          primary={Boolean(bot?.primary)}
          space={Boolean(space)}
          menu={actions}
          composer={{
            text: draft,
            focusRev,
            placeholder: replying ? `Reply to ${nameOf(replying.author, bots, space)}` : busy && !isRoom ? "Add to it, or say stop" : bot ? `Message ${bot.name}` : errandBot ? `Message ${errandBot.name}` : space ? "Message the space" : answersNext.length ? `${names(answersNext)} ${answersNext.length > 1 ? "answer" : "answers"} next` : "Message the room",
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
            else if (event.type === "mention") {
              const who = chips.find((chip) => chip.id === event.id);
              if (who) mention(who);
            } else if (event.type === "remove-file") setFiles(files.filter((_, at) => at !== event.index));
            else if (event.type === "cancel-reply") setReplying(null);
            else if (event.type === "jump") setJumpRev((n) => n + 1);
            else if (event.type === "screen") setScreen(event.id);
            else if (event.type === "call-mute") toggleMute();
            else if (event.type === "call-end") hangUp();
          }}
        />
      ) : null}
      <ThreadConfirms ask={ask} onClose={() => setAsk(null)} />
      {calling.confirm}
      <SelectTextDialog text={selectText} onClose={() => setSelectText(null)} />
      <ImageViewer images={pictures} openId={viewing} onOpenId={setViewing} />

      {exchange ? <ExchangeDialog threadId={threadId} withThreadId={exchange} onClose={() => setExchange(null)} /> : null}
    </div>
  );
}
