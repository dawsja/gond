"use client";

import { handleOf, joinNames, plainMarkdown, REACTIONS, roomTargets, type Approval, type ApprovalAnswer, type Bot, type ChatAttachment, type Message, type ReactionEmoji, type Routine, type Thread, type ThreadSpace } from "@gond/shared";
import { inertChoices, remoteMember, spaceMentionables, spaceSubtitle } from "@/lib/spaces";
import { ChevronLeft, Copy, CornerUpLeft, Download, Eye, EllipsisVertical, File as FileIcon, FileArchive, FileHeadphone, FilePlay, FileSpreadsheet, FileText, FileX, ImageOff, Lock, Monitor, PanelRight, Paperclip, Pencil, RotateCcw, TextSelect, Undo2 } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent as ReactMouseEvent } from "react";
import { ApprovalCard } from "@/components/approval-card";
import { ControlCard, handOffOpen } from "@/components/control-card";
import { QuoteInBubble } from "@/components/reply-quote";
import { BotAvatar, RoomAvatar, roomMembers } from "@/components/bot-avatar";
import { Composer, MAX_FILES, type ComposerHandle, type Replying } from "@/components/conversation-composer";
import { LiveTail } from "@/components/conversation-live";
import { LoadEarlier } from "@/components/load-earlier";
import { NoteBadge } from "@/components/note-badge";
import { copyToClipboard } from "@/components/hq/clipboard";
import { choiceAnswers, joinPicks, splitPicks } from "@/lib/choices";
import { copyText } from "@/lib/markdown";
import { canReact, react, ReactionBadges, ReactionPicker } from "@/components/reactions";
import { pollInterval, useLiveEvents } from "@/components/hq/live-events";
import { ChoicesContext } from "@/components/chat-blocks";
import { ImageViewer } from "@/components/image-viewer";
import { PdfViewer, type ViewerPdf } from "@/components/pdf-viewer";
import { isPdfAttachment } from "@/lib/pdf-viewer";
import { Markdown } from "@/components/markdown";
import { PictureFall, type PictureReveal } from "@/components/picture-making";
import { NoticedLinks, noticedRuns, RunMarker, useWatches, WatchesContext, type Noticed } from "@/components/noticed";
import { DetailsSheet, RightPanel } from "@/components/right-panel";
import { ScreenPanel, useScreenDrivers } from "@/components/screen-panel";
import { SecretCard } from "@/components/secret-card";
import { ShoppingCard } from "@/components/shopping-card";
import { failed } from "@/components/failed";
import { openShellDialog } from "@/components/shell";
import { SignInCard } from "@/components/signin-card";
import { MentionFace, mentionOfBot } from "@/components/slash-menu";
import { shortTime } from "@/lib/time";
import { useActivity, useSingleFlight, useStore, type ThreadRow } from "@/components/store";
import { threadActions, ThreadConfirms, type Ask } from "@/components/thread-actions";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/components/ui/attachment";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuGroup, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupTextarea } from "@/components/ui/input-group";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message as MessageRow, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerEdges, MessageScrollerItem, MessageScrollerProvider, MessageScrollerViewport, useMessageScroller, useMessageScrollerScrollable } from "@/components/ui/message-scroller";
import { toast } from "@/components/ui/toast";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { TeachCard } from "@/components/teach/teach-card";
import { useCoarsePointer } from "@/hooks/use-mobile";
import { useMessageHistory, type PageQuery } from "@/hooks/use-message-history";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { REPLY_DISTANCE, useSwipeToReply } from "@/hooks/use-swipe-to-reply";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { api, ApiError, post } from "@/lib/api";
import { formatBytes } from "@/lib/bytes";
import { fileKind, type FileKind } from "@/lib/file-kind";
import { keep } from "@/lib/keep";
import { editUnread, retryTurn, unsend } from "@/lib/message-actions";
import { notReadYet } from "@/lib/message-state";
import { sentHistory } from "@/lib/sent-history";
import { askNative, useNativeApp, useNativeUi, type NativeMenuItem } from "@/lib/native-ui";
import { cn } from "@/lib/utils";

const ExchangeDialog = dynamic(() => import("@/components/exchange-dialog").then((m) => m.ExchangeDialog));

const POLL_MS = 4_000;
// Long enough for the last square of a landed picture to fall away.
const REVEAL_MS = 1_500;

// Every line is Markdown to parse as the conversation opens, so the first page is short; earlier ones load on the way up.
const PAGE = 60;
const JUMP_PAGE = 200;
const COMPOSER_HEIGHT = 68;
// Soon enough that the chat list's reload for a reply also takes in this read marker's change.
const READ_DELAY_MS = 100;

type ThreadInfo = { thread: Thread; bot: Bot | null; busy: string[]; answering?: string[] };

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

const RING = "transition-shadow duration-500";
const RINGED = "ring-2 ring-ring";

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

function Handoff({ message, threadId, bots, other, onOpen }: { message: Message; threadId: string; bots: Bot[]; other: ThreadRow | undefined; onOpen: (withThreadId: string) => void }) {
  const incoming = message.threadId === threadId;
  const otherId = incoming ? message.fromThreadId! : message.threadId;
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

function showsTime(event: ReactMouseEvent): boolean {
  if (event.target instanceof Element && event.target.closest("a, button, img, input, textarea")) return false;
  return !window.getSelection()?.toString();
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

/** A file shown as a picture, on its own outside the bubble: anything an image but an SVG, which could run script, while it's still kept. */
function isPicture(file: ChatAttachment): boolean {
  return !file.removed && file.mediaType.startsWith("image/") && file.mediaType !== "image/svg+xml";
}

function revealIn(message: Message, reveals: Record<string, PictureReveal>): PictureReveal | undefined {
  for (const file of message.attachments) if (reveals[file.id]) return reveals[file.id];
  return undefined;
}

function quoteText(message: Message): string {
  return plainMarkdown(message.body).slice(0, 280) || message.attachments[0]?.name || "";
}

const Line = memo(function Line({ message, threadId, bots, other, bot, approval, isRoom, space, editing, latestHandOff, stops, touch, picks, closedBy, inert, sentTo, noticed, reveal, highlighted, unread, onPick, onView, onViewPdf, onDecide, onOpenExchange, onEdit, onUnsend, onSelectText, onReacted, onReply, onJump }: { message: Message; threadId: string; bots: Bot[]; other: ThreadRow | undefined; bot: Bot | null; approval: Approval | null | undefined; isRoom: boolean; space: ThreadSpace | null; editing: boolean; latestHandOff: boolean; stops: boolean; touch: boolean; picks: string; closedBy: string | null; inert: boolean; sentTo: string | undefined; noticed: Noticed | undefined; reveal: PictureReveal | undefined; highlighted: boolean; unread: string | undefined; onPick: (option: string, from: Message) => Promise<void>; onView: (attachmentId: string) => void; onViewPdf: (file: ViewerPdf) => void; onDecide: (id: string, answer: ApprovalAnswer) => Promise<void>; onOpenExchange: (withThreadId: string) => void; onEdit: (message: Message | null, text?: string) => Promise<boolean>; onUnsend: (message: Message) => void; onSelectText: (text: string) => void; onReacted: (message: Message) => void; onReply: (message: Message) => void; onJump: (id: string) => void }) {
  const mine = message.author === "you";
  const bubble = useRef<HTMLDivElement>(null);
  const nativeApp = useNativeApp();
  // The tap that ends a long press still clicks the bubble; it shouldn't also show the time.
  const menuOpenedAt = useRef(0);

  const [selected, setSelected] = useState("");
  const [timed, setTimed] = useState(false);
  const [swipe, setSwipe] = useState(0);
  const replyable = message.kind === "message" && !message.fromThreadId && message.author !== "routine" && message.author !== "system";
  useSwipeToReply(bubble, touch && replyable, setSwipe, () => onReply(message));
  const choices = useMemo(() => (mine || inert ? {} : { pick: (option: string) => onPick(option, message), answer: { picks: splitPicks(picks), closedBy } }), [mine, inert, onPick, message, picks, closedBy]);

  const author = mine ? null : bots.find((b) => b.id === message.author) ?? null;
  const remote = remoteMember(space, message.author);
  if (message.kind === "prompt") return null;
  if (message.commerceId) return <MessageRow align="start"><MessageContent><ShoppingCard message={message} bot={author ?? bot ?? undefined} /></MessageContent></MessageRow>;
  if (message.kind === "message" && message.fromThreadId && author) return <Handoff message={message} threadId={threadId} bots={bots} other={other} onOpen={onOpenExchange} />;
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
          {message.kind === "signin" ? <SignInCard message={message} bot={author ?? bot ?? undefined} /> : message.kind === "secret" ? <SecretCard message={message} bot={author ?? bot ?? undefined} /> : <ApprovalCard message={message} approval={approval} bot={author ?? bot ?? undefined} noticed={Boolean(noticed)} onDecide={onDecide} />}
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
  const openNativeMenu = async (selection: string) => {
    const node = bubble.current;
    if (!node) return;
    const lift = nativeApp === "iphone";
    // The badges hang below the bubble, so the lifted copy would cut them; the reactions bar shows them anyway.
    if (lift) {
      menuOpenedAt.current = Date.now();
      node.dataset.lifting = "";
    }
    const box = node.getBoundingClientRect();
    const items: NativeMenuItem[] = [];
    if (replyable) items.push({ id: "reply", label: "Reply", symbol: "arrowshape.turn.up.left" });
    if (selection) items.push({ id: "copy-selection", label: "Copy selection", symbol: "character.cursor.ibeam" });
    if (message.body) items.push({ id: "copy", label: "Copy text", symbol: "doc.on.doc" });
    if (message.body && lift) items.push({ id: "select", label: "Select text", symbol: "character.cursor.ibeam" });
    if (edits) items.push({ id: "edit", label: editsInPlace ? "Edit" : "Edit and resend", symbol: "pencil" });
    if (takeBack) items.push({ id: "unsend", label: "Unsend", symbol: "arrow.uturn.backward", destructive: true });
    const picked = await askNative({
      kind: "message",
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      mine,
      reactions: reactable ? { options: REACTIONS, mine: message.reactions.find((r) => r.author === "you")?.emoji ?? null } : null,
      items,
    });
    if (lift) delete node.dataset.lifting;
    const copied = (ok: boolean) => toast.add(ok ? { title: "Copied." } : { type: "error", title: "Couldn't copy it." });
    if (picked?.react && (REACTIONS as readonly string[]).includes(picked.react)) reactWith(picked.react as ReactionEmoji);
    else if (picked?.action === "reply") onReply(message);
    else if (picked?.action === "copy-selection") void copyToClipboard(selection).then(copied);
    else if (picked?.action === "copy") void copyToClipboard(copyText(message.body)).then(copied);
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

        {message.checkIn ? (
          <p className="flex items-center gap-1.5 pl-1 text-xs text-muted-foreground">
            <Eye className="size-3.5 shrink-0 text-tint-ink" aria-hidden="true" />
            <span>
              <span className="font-semibold text-tint-ink">Checked in</span> · {shortTime(message.createdAt)}
            </span>
          </p>
        ) : null}
        <ContextMenu onOpenChange={(open) => setSelected(open ? selectionIn(bubble.current) : "")}>
        <ContextMenuTrigger
          ref={bubble}
          onClick={(event) => Date.now() - menuOpenedAt.current > 1500 && showsTime(event) && setTimed((on) => !on)}
          onContextMenu={(event) => {
            if (nativeApp === "iphone" && touch) {
              event.preventDefault();
              event.preventBaseUIHandler();
              if (menu) void openNativeMenu("");
              return;
            }
            // A right click on a link gets the browser's own menu (open in a new tab, copy the address).
            if (!touch && event.target instanceof Element && event.target.closest("a[href]")) {
              event.preventBaseUIHandler();
              return;
            }
            if (nativeApp === "mac") {
              event.preventDefault();
              event.preventBaseUIHandler();
              if (menu) void openNativeMenu(selectionIn(bubble.current));
            }
          }}
          className={cn("group/lift touch-pan-y select-text pointer-coarse:select-none", !swipe && "transition-transform duration-200")}
          style={swipe ? { transform: `translateX(${swipe}px)` } : undefined}
          render={<Bubble variant={mine ? "default" : message.checkIn ? "tint" : "outline"} align={mine ? "end" : "start"} className={cn("max-w-[86%] sm:max-w-[78%]", message.reactions.length > 0 && "mb-2.5")} />}
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
                {files.map((file) =>
                  file.removed ? (
                    <Attachment key={file.id} size="sm" aria-label={`${file.name}, removed to save space`}>
                      <AttachmentMedia variant="icon" className="text-muted-foreground">
                        {file.mediaType.startsWith("image/") ? <ImageOff /> : <FileX />}
                      </AttachmentMedia>
                      <AttachmentContent>
                        <AttachmentTitle className="text-muted-foreground">{file.name}</AttachmentTitle>
                        <AttachmentDescription>Removed to save space</AttachmentDescription>
                      </AttachmentContent>
                    </Attachment>
                  ) : (
                  <Attachment key={file.id} size="sm">
                    {isPdfAttachment(file) && !nativeApp ? (
                      <AttachmentTrigger onClick={() => onViewPdf({ id: file.id, name: file.name })} aria-label={`View ${file.name}`} />
                    ) : (
                      <AttachmentTrigger render={<a href={`/api/attachments/${file.id}`} target="_blank" rel="noreferrer" aria-label={`Open ${file.name}`} />} />
                    )}
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
                  ),
                )}
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

type HistoryProps = {
  messages: Message[];
  threadId: string;
  bots: Bot[];
  threads: ReadonlyMap<string, ThreadRow>;
  approvals: ReadonlyMap<string, Approval | null>;
  bot: Bot | null;
  isRoom: boolean;
  space: ThreadSpace | null;
  inSpace: boolean;
  roomBots: Bot[];
  answering: string[] | undefined;
  editing: string | null;
  touch: boolean;
  reveals: Record<string, PictureReveal>;
  flash: string | null;
  unread: ReadonlyMap<string, string>;
  watches: Routine[];
  onPick: (option: string, from: Message) => Promise<void>;
  onView: (attachmentId: string) => void;
  onViewPdf: (file: ViewerPdf) => void;
  onDecide: (id: string, answer: ApprovalAnswer) => Promise<void>;
  onOpenExchange: (withThreadId: string) => void;
  onEdit: (message: Message | null, text?: string) => Promise<boolean>;
  onUnsend: (message: Message) => void;
  onSelectText: (text: string) => void;
  onReacted: (message: Message) => void;
  onReply: (message: Message) => void;
  onJump: (id: string) => void;
};

// One object per watch and place, so a line a run noticed keeps its props as later lines arrive.
const sameNoticed = new Map<string, Noticed>();
function noticedOnce(noticed: Noticed | undefined): Noticed | undefined {
  if (!noticed) return undefined;
  const key = `${noticed.lead ? 1 : 0}${noticed.watch}`;
  const known = sameNoticed.get(key);
  if (known) return known;
  sameNoticed.set(key, noticed);
  return noticed;
}

/** The conversation's lines, each drawn only when what it shows changed; typing and streaming never reach it. */
const MessageHistory = memo(function MessageHistory({ messages, threadId, bots, threads, approvals, bot, isRoom, space, inSpace, roomBots, answering, editing, touch, reveals, flash, unread, watches, ...handlers }: HistoryProps) {
  const answers = useMemo(() => choiceAnswers(messages), [messages]);
  const inert = useMemo(() => inertChoices(messages, inSpace), [messages, inSpace]);
  const runs = useMemo(() => noticedRuns(messages), [messages]);
  const handOff = useMemo(() => messages.findLast((m) => m.kind === "control") ?? null, [messages]);
  // Who a line in a room went to: the router's pick when it made one (`sentTo`), else read the way the API reads it (`roomTargets`).
  const sentTo = useMemo(() => {
    const map = new Map<string, string>();
    if (!roomBots.length) return map;
    messages.forEach((m, index) => {
      const routed = m.sentTo ? roomBots.filter((b) => m.sentTo!.includes(b.id)) : [];
      if (routed.length) map.set(m.id, joinNames(routed.map((b) => b.name)));
      else if (m.steered) map.set(m.id, joinNames(roomTargets(m.body, roomBots, messages.slice(0, index)).map((b) => b.name)));
    });
    return map;
  }, [messages, roomBots]);
  return (
    <WatchesContext.Provider value={watches}>
      {messages.map((m) => (
        <MessageScrollerItem key={m.id} messageId={m.id}>
          <Line
            message={m}
            threadId={threadId}
            bots={bots}
            other={m.kind === "message" && m.fromThreadId ? threads.get(m.threadId === threadId ? m.fromThreadId : m.threadId) : undefined}
            bot={bot}
            approval={m.approvalId ? approvals.get(m.approvalId) : undefined}
            isRoom={isRoom}
            space={space}
            editing={editing === m.id}
            latestHandOff={m.id === handOff?.id}
            stops={Boolean(answering?.includes(m.id))}
            touch={touch}
            picks={joinPicks(answers.get(m.id))}
            closedBy={answers.get(m.id)?.closedBy ?? null}
            inert={inert.has(m.id)}
            sentTo={sentTo.get(m.id)}
            noticed={noticedOnce(runs.get(m.id))}
            reveal={revealIn(m, reveals)}
            highlighted={m.id === flash}
            unread={unread.get(m.id)}
            {...handlers}
          />
        </MessageScrollerItem>
      ))}
    </WatchesContext.Provider>
  );
});

function picturesIn(messages: Message[]) {
  return messages.flatMap((m) => (m.kind === "prompt" ? [] : m.attachments.filter(isPicture).map((file) => ({ id: file.id, name: file.name }))));
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

function JumpToMessage({ id, ready, loaded, earlier, onFound }: { id: string | null; ready: boolean; loaded: boolean; earlier: (limit: number) => Promise<boolean>; onFound: (id: string) => void }) {
  const { scrollToMessage } = useMessageScroller();
  const [done, setDone] = useState<string | null>(null);
  // Each page read back looks again.
  const [pages, setPages] = useState(0);
  useEffect(() => {
    if (!id || !ready || done === id) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      if (scrollToMessage(id, { align: "center" })) {
        onFound(id);
        return setDone(id);
      }
      if (loaded) return;
      void earlier(JUMP_PAGE).then((more) => {
        if (stale) return;
        if (more) return setPages((n) => n + 1);
        setDone(id);
        toast.add({ title: "That message isn't in this conversation any more." });
      });
    }, 150);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [id, ready, loaded, done, pages, scrollToMessage, earlier, onFound]);
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

export function Conversation({ threadId }: { threadId: string }) {
  const { bots, threads, approvals, refresh, boxUpdating, desktop } = useStore();
  const activity = useActivity();
  const router = useRouter();
  const nativeChrome = useNativeUi();
  const composer = useRef<ComposerHandle>(null);
  const [canJump, setCanJump] = useState(false);
  const [jumpRev, setJumpRev] = useState(0);
  const [info, setInfo] = useState<ThreadInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [infoFailed, setInfoFailed] = useState(false);

  const fetchPage = useCallback(
    async ({ before, from, limit }: PageQuery) => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (before) query.set("before", before);
      if (from) query.set("from", from);
      return (await api<{ messages: Message[] }>(`/api/threads/${threadId}/messages?${query}`)).messages;
    },
    [threadId],
  );
  const { messages, earlier, failed: loadFailed, approvals: shownApprovals, reload, catchUp, loadEarlier, add, update, putApproval, refreshApprovals } = useMessageHistory(fetchPage, { page: PAGE });

  const [dropping, setDropping] = useState(false);
  const [panel, setPanel] = useState(true);
  const [details, setDetails] = useState(false);
  const [screen, setScreen] = useState<string | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  const [paused, setPaused] = useState(false);
  const [composerHeight, setComposerHeight] = useState(COMPOSER_HEIGHT);

  const touch = useCoarsePointer();
  const params = useSearchParams();
  const jumpTo = params.get("m");
  const [exchange, setExchange] = useState<string | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [replying, setReplying] = useState<Message | null>(null);
  // A tap on a reply's quote; the count makes a second tap on the same quote go again.
  const [jump, setJump] = useState<{ id: string; n: number } | null>(null);
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
  const [viewingPdf, setViewingPdf] = useState<ViewerPdf | null>(null);

  const [reveals, setReveals] = useState<Record<string, PictureReveal>>({});
  const onLanded = useCallback((reveal: PictureReveal) => {
    setReveals((current) => ({ ...current, [reveal.file]: reveal }));
    window.setTimeout(() => setReveals((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== reveal.file))), REVEAL_MS);
  }, []);

  // The store holds what still waits; what was answered comes with the messages that show it.
  const approvalMap = useMemo(() => {
    const map = new Map<string, Approval | null>(shownApprovals);
    for (const a of approvals) map.set(a.id, a);
    return map;
  }, [approvals, shownApprovals]);
  const threadMap = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);

  const sentLines = useMemo(() => sentHistory(messages), [messages]);
  // Until the conversation's details load, whether it is a space is unknown, so assume it is.
  const inSpace = info ? Boolean(info.thread.space) : true;
  const pictures = useMemo(() => picturesIn(messages), [messages]);

  const replaceMessage = useCallback((changed: Pick<Message, "id" | "reactions">) => update((current) => current.map((m) => (m.id === changed.id ? { ...m, reactions: changed.reactions } : m))), [update]);

  const loadInfo = useCallback(async () => {
    try {
      const next = await api<ThreadInfo>(`/api/threads/${threadId}`);
      setInfo((current) => keep(current, next));
      setInfoFailed(false);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) setMissing(true);
      else setInfoFailed(true);
    }
  }, [threadId]);

  // A reply sends several events at once; this runs once for all of them.
  const refreshInfo = useSingleFlight(loadInfo);
  const readTimer = useRef<number | null>(null);
  const markRead = useCallback(() => {
    if (readTimer.current !== null) return;
    readTimer.current = window.setTimeout(() => {
      readTimer.current = null;
      void post(`/api/threads/${threadId}/read`).catch(() => undefined);
    }, READ_DELAY_MS);
  }, [threadId]);
  useEffect(
    () => () => {
      if (readTimer.current !== null) window.clearTimeout(readTimer.current);
      readTimer.current = null;
    },
    [threadId],
  );

  useSwipeBack("/app");
  useEffect(() => {
    void Promise.resolve().then(() => {
      void loadInfo();
      void post(`/api/threads/${threadId}/read`).catch(() => undefined);
    });
  }, [threadId, loadInfo]);

  const live = useLiveEvents((event) => {
    if (event.topic === "open") {
      void catchUp();
      void refreshInfo();
      void refreshApprovals();
    } else if (event.topic === "thread" && event.threadId === threadId) {
      void (event.cleared ? reload() : catchUp());
      void refreshInfo();
      markRead();
    } else if (event.topic === "reactions" && event.threadId === threadId) {
      replaceMessage({ id: event.messageId, reactions: event.reactions });
    } else if (event.topic === "approvals") {
      void catchUp();
      void refreshApprovals();
    } else if (event.topic === "bots") void refreshInfo();
  });

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) void catchUp();
    }, pollInterval(live, POLL_MS));
    return () => window.clearInterval(timer);
  }, [live, catchUp]);

  useEffect(() => {
    if (live) {
      void Promise.resolve().then(() => setPaused(false));
      return;
    }
    const timer = window.setTimeout(() => setPaused(true), 5_000);
    return () => window.clearTimeout(timer);
  }, [live]);

  const working = activity[threadId] ?? {};
  // Which bots work here changes as a turn picks up a line, so the details (what each answers) follow.
  const workingKey = Object.keys(working).sort().join(" ");
  useEffect(() => {
    if (workingKey) void Promise.resolve().then(refreshInfo);
  }, [workingKey, refreshInfo]);
  const thread = info?.thread ?? null;
  const isRoom = thread?.kind === "room";
  const bot = info?.bot ?? null;
  const space = thread?.space ?? null;
  const answering = info?.answering;
  const watches = useWatches(bot?.id ?? null);
  const roomBots = useMemo(() => (isRoom && thread ? roomMembers(thread, bots) : []), [isRoom, thread, bots]);
  const roomDrivers = useScreenDrivers(threadId);
  // A line that names nobody is placed by the router after it is sent, so only a line steered into running answers is named ahead.
  const roomWorking = [...new Set([...Object.keys(working), ...(info?.busy ?? [])])];
  const answersNext = roomBots.length && roomWorking.length ? roomTargets("", roomBots, messages, roomWorking).map((b) => b.name) : [];
  const handOff = useMemo(() => messages.findLast((m) => m.kind === "control") ?? null, [messages]);
  // The person's lines no bot has read yet: `waiting` as loaded, until a turn takes one up or a bot answers it.
  const botWorking = Boolean(bot && (bot.id in working || info?.busy.includes(bot.id)));
  const botName = bot?.name ?? null;
  const unreadNote = useMemo(() => {
    const map = new Map<string, string>();
    if (space) return map;
    const taken = new Set(answering ?? []);
    for (const m of messages) if (m.answering && m.author !== "you") taken.add(m.answering);
    const note = notReadYet({ isRoom, botName, working: botWorking });
    for (const m of messages) if (m.author === "you" && m.waiting && !taken.has(m.id)) map.set(m.id, note);
    return map;
  }, [messages, answering, isRoom, botName, botWorking, space]);
  const waitingOnYou = approvals.some((a) => a.threadId === threadId && a.status === "pending") || handOffOpen(handOff, desktop);

  const members = useMemo(() => (isRoom && thread ? thread.members.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => Boolean(b)) : []), [isRoom, thread, bots]);
  const chips = useMemo(() => (isRoom ? [...members.map(mentionOfBot), ...spaceMentionables(space)] : []), [isRoom, members, space]);
  const mentionable = useMemo(() => (isRoom ? chips : bots.filter((b) => !b.hidden).map(mentionOfBot)), [isRoom, chips, bots]);
  const reply = useMemo<Replying | null>(() => (replying ? { id: replying.id, name: nameOf(replying.author, bots, space), color: colorOf(replying.author, bots, space), text: quoteText(replying) } : null), [replying, bots, space]);

  function replyTo(message: Message) {
    setReplying(message);
    setEditing(null);
    window.requestAnimationFrame(() => composer.current?.focus());
  }

  async function pick(option: string, from: Message) {
    // In a room the option goes to the bot that offered it, as the person would say it. It replies to
    // the message that asked, so the bot knows which question it answers and only that one closes.
    const offeredBy = isRoom ? bots.find((b) => b.id === from.author) : undefined;
    const body = offeredBy ? `@${handleOf(offeredBy.name)} ${option}` : option;
    try {
      const data = await api<{ message: Message }>(`/api/threads/${threadId}/messages`, { method: "POST", body: JSON.stringify({ body, replyTo: from.id }) });
      add([data.message]);
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
      add([data.message]);
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
      update((current) => current.map((m) => (m.id === message.id ? (data?.message ?? { ...m, body: text }) : m)));
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
        update((current) => current.filter((m) => m.id !== message.id));
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
      putApproval(data.approval);
      await refresh();
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Couldn't send your answer." });
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
    composer.current?.attach([...event.dataTransfer.files]);
  }

  const onPick = useStableCallback(pick);
  const onDecide = useStableCallback(decide);
  const onEdit = useStableCallback(edit);
  const onUnsend = useStableCallback(takeBack);
  const onReply = useStableCallback(replyTo);
  const onSent = useStableCallback((message: Message) => {
    add([message]);
    setSent(message.id);
    setReplying(null);
  });
  const onCancelReply = useCallback(() => setReplying(null), []);
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
  const roomLine = info ? (space ? spaceSubtitle(space) : `${info.thread.members.length} bots`) : "";
  const row = threadMap.get(threadId);
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
  const status = boxUpdating ? " · the computer is updating, replies wait" : busy ? " · working" : waitingOnYou ? " · waiting on you" : watches.length ? ` · watching ${watches.length === 1 ? "1 thing" : `${watches.length} things`}` : "";
  const hint = busy && !isRoom ? "Add to it, or say stop" : bot ? `Message ${bot.name}` : space ? "Message the space" : answersNext.length ? `${joinNames(answersNext)} ${answersNext.length > 1 ? "answer" : "answers"} next` : "Message the room";

  return (
    <div className="flex min-h-0 flex-1">
      <section data-native-column="" className="relative flex min-w-0 flex-1 flex-col [--header-top:calc(64px+var(--safe-top))] mac:[--header-top:var(--safe-top)]" style={{ "--composer-h": `${composerHeight}px` } as CSSProperties} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
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

        {/* In the desktop app this row is the title bar, and the window's buttons take the corner unless the panel does. */}
        <header data-window-drag="" className={cn("pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[calc(64px+var(--safe-top))] items-center gap-2 px-3 pt-[var(--safe-top)] sm:px-4 desktop:pointer-events-auto wide:desktop:pr-(--window-controls-space)", panel && info && "xwide:desktop:pr-4", nativeChrome && "invisible")}>
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
          <JumpToMessage id={jumpTo} ready={messages.length > 0} loaded={earlier === false} earlier={loadEarlier} onFound={flashOn} />
          {jump ? <JumpToMessage key={jump.n} id={jump.id} ready={messages.length > 0} loaded={earlier === false} earlier={loadEarlier} onFound={flashOn} /> : null}
          <FollowSent id={sent} />
          <FollowComposer height={composerHeight} />
          {nativeChrome ? <NativeJump onCanJump={setCanJump} jumpRev={jumpRev} /> : null}
          <MessageScroller className="flex-1">
            <MessageScrollerViewport preserveScrollOnPrepend className="px-3 pt-(--header-top) pb-(--composer-h) sm:px-4 wide:px-[max(1.5rem,calc((100%-46rem)/2))]">
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
                        <Button variant="outline" onClick={() => void reload()}>
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
                <MessageHistory
                  messages={messages}
                  threadId={threadId}
                  bots={bots}
                  threads={threadMap}
                  approvals={approvalMap}
                  bot={bot}
                  isRoom={isRoom}
                  space={space}
                  inSpace={inSpace}
                  roomBots={roomBots}
                  answering={answering}
                  editing={editing}
                  touch={touch}
                  reveals={reveals}
                  flash={flash}
                  unread={unreadNote}
                  watches={watches}
                  onPick={onPick}
                  onView={setViewing}
                  onViewPdf={setViewingPdf}
                  onDecide={onDecide}
                  onOpenExchange={setExchange}
                  onEdit={onEdit}
                  onUnsend={onUnsend}
                  onSelectText={setSelectText}
                  onReacted={replaceMessage}
                  onReply={onReply}
                  onJump={onJump}
                />
                <LiveTail threadId={threadId} isRoom={isRoom} catchUp={catchUp} onLanded={onLanded} />
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerEdges top="calc(var(--header-top) + 1.5rem)" bottom="calc(var(--composer-h) + 1.5rem)" />
            {nativeChrome ? null : <MessageScrollerButton className="data-[direction=end]:bottom-[calc(var(--composer-h)+8px)]" />}
          </MessageScroller>
        </MessageScrollerProvider>

        <Composer
          ref={composer}
          threadId={threadId}
          nativeChrome={nativeChrome}
          touch={touch}
          busy={busy}
          hint={hint}
          label={bot ? `Message ${bot.name}` : "Message the room"}
          space={space}
          chips={chips}
          mentionable={mentionable}
          reply={reply}
          sentLines={sentLines}
          paused={paused}
          chrome={{
            thread: threadId,
            avatarKey: JSON.stringify((bot ? [bot] : roomBots).map((b) => [b.id, b.color, b.shape, b.avatar, b.expression])),
            title: info?.thread.name ?? "…",
            subtitle: `${bot ? bot.title || "Teammate" : roomLine}${status}`,
            working: busy || boxUpdating,
            more: bot ? 0 : Math.max(0, roomBots.length - 2),
            jump: canJump,
            screens: driving.length && !screen ? driving.map((b) => ({ id: b.id, label: driving.length > 1 ? `${b.name}'s screen` : "Watching the screen" })) : [],
            primary: Boolean(bot?.primary),
            space: Boolean(space),
            menu: actions,
          }}
          onCancelReply={onCancelReply}
          onSent={onSent}
          onHeight={setComposerHeight}
          onChromeEvent={(event) => {
            if (event.type === "back") router.push("/app");
            else if (event.type === "details") {
              if (document.documentElement.dataset.shell === "mac") setPanel((p) => !p);
              else openPill();
            }
            else if (event.type === "menu") actions.flat().find((action) => action.id === event.id)?.run();
            else if (event.type === "cancel-reply") setReplying(null);
            else if (event.type === "jump") setJumpRev((n) => n + 1);
            else if (event.type === "screen") setScreen(event.id);
          }}
        />
      </section>
      {panel && info ? <RightPanel thread={info.thread} bot={bot} screen={screenProps} /> : null}
      {info ? <DetailsSheet open={details} onOpenChange={setDetails} thread={info.thread} bot={bot} screen={screenProps} /> : null}
      {screen ? <ScreenPanel botId={screen} expanded onExpand={() => setScreen(screen)} onCollapse={() => setScreen(null)} /> : null}
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
      <ThreadConfirms ask={ask} onClose={() => setAsk(null)} />
      <SelectTextDialog text={selectText} onClose={() => setSelectText(null)} />
      <ImageViewer images={pictures} openId={viewing} onOpenId={setViewing} />
      <PdfViewer file={viewingPdf} onClose={() => setViewingPdf(null)} />

      {exchange ? <ExchangeDialog key={exchange} threadId={threadId} withThreadId={exchange} onClose={() => setExchange(null)} /> : null}
    </div>
  );
}
