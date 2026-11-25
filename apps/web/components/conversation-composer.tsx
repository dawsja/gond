"use client";

import type { Message } from "@gond/shared";
import { ArrowUp, Camera, Folder, Image as ImageIcon, ListEnd, Paperclip, X } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ChangeEvent, type ClipboardEvent, type ComponentProps, type FormEvent, type KeyboardEvent, type Ref, type RefObject } from "react";
import { ConversationChrome } from "@/components/conversation-chrome";
import { formatBytes } from "@/lib/bytes";
import { isPreviewableImage } from "@/lib/file-kind";
import { ReplyingTo } from "@/components/reply-quote";
import { matchMentions, matchSkills, MentionFace, SlashMenu, slashQuery, useSkillsLibrary, type Mentionable } from "@/components/slash-menu";
import { TeachPillFor } from "@/components/teach/teach-controls";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useComposerDraft } from "@/hooks/use-composer-draft";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { api } from "@/lib/api";
import { unsentBack } from "@/lib/composer-draft";
import { composerLayout } from "@/lib/composer-layout";
import { flushDrafts, readDraft, saveDraft } from "@/lib/drafts";
import { filesFrom, type ChromeEvent } from "@/lib/native-ui";
import { historyStep } from "@/lib/sent-history";
import { isPhoneShell, useNativeShell } from "@/lib/shell";
import { cn } from "@/lib/utils";

export const MAX_FILES = 6;

export type ComposerHandle = { focus: () => void; attach: (files: File[]) => void };

export type Replying = { id: string; name: string; color: string | null; text: string };

type ChromeHeader = Omit<ComponentProps<typeof ConversationChrome>, "files" | "replying" | "mentions" | "composer" | "onEvent">;

function ComposerFileMedia({ file }: { file: File }) {
  const previewable = isPreviewableImage(file);
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const [broken, setBroken] = useState<File | null>(null);

  useEffect(() => {
    if (!previewable) return;
    let active = true;
    const url = URL.createObjectURL(file);
    void Promise.resolve().then(() => {
      if (active) setPreview({ file, url });
    });
    return () => {
      active = false;
      URL.revokeObjectURL(url);
    };
  }, [file, previewable]);

  if (previewable && preview?.file === file && broken !== file) {
    return (
      <AttachmentMedia variant="image">
        {/* eslint-disable-next-line @next/next/no-img-element -- local object URL for a file about to be sent */}
        <img src={preview.url} alt="" onError={() => setBroken(file)} />
      </AttachmentMedia>
    );
  }
  return (
    <AttachmentMedia variant="icon">
      <Paperclip />
    </AttachmentMedia>
  );
}

export function Composer({
  ref,
  threadId,
  nativeChrome,
  touch,
  busy,
  hint,
  label,
  chips,
  mentionable,
  reply,
  sentLines,
  paused,
  chrome,
  onCancelReply,
  onSent,
  onHeight,
  onChromeEvent,
}: {
  ref?: Ref<ComposerHandle>;
  threadId: string;
  nativeChrome: boolean;
  touch: boolean;
  busy: boolean;
  hint: string;
  label: string;
  chips: Mentionable[];
  mentionable: Mentionable[];
  reply: Replying | null;
  /** The person's sent lines, newest first, for Up and Down (`sentHistory`). */
  sentLines: string[];
  paused: boolean;
  chrome: ChromeHeader;
  onCancelReply: () => void;
  onSent: (message: Message) => void;
  onHeight: (height: number) => void;
  onChromeEvent: (event: ChromeEvent) => void;
}) {
  const { text: draft, rev: draftRev, latest: latestDraft, typed: appTyped, set: setDraft } = useComposerDraft();
  const [recall, setRecall] = useState<number | null>(null);
  const restored = useRef(false);
  useEffect(() => {
    const saved = readDraft(threadId);
    void Promise.resolve().then(() => {
      if (saved) setDraft((d) => d || saved);
      setRecall(null);
      restored.current = true;
    });
    // Leaving the conversation writes its draft at once, so the chat list shows it.
    return () => flushDrafts();
  }, [threadId, setDraft]);
  useEffect(() => {
    if (restored.current) saveDraft(threadId, draft);
  }, [threadId, draft]);

  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusRev, setFocusRev] = useState(0);
  const skills = useSkillsLibrary();
  const [slash, setSlash] = useState<{ kind: "skill" | "bot"; query: string; start: number; selected: number } | null>(null);
  const shell = useNativeShell();
  const phone = touch || isPhoneShell(shell);
  const cameraInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const textarea = useRef<HTMLTextAreaElement>(null);
  // A message past one line takes the pill's full width, its buttons on a row of their own beneath;
  // it stays that way until it's empty, or the wider text could fit one line again and flip back.
  const [stackedLatch, setStacked] = useState(false);
  const stacked = composerLayout(draft, false, stackedLatch);
  const below = stacked && !nativeChrome;
  useEffect(() => {
    if (draft) return;
    // Clearing a one-line field need not resize it. Reset for the next draft without waiting for that.
    void Promise.resolve().then(() => setStacked(false));
  }, [draft]);
  const heightWatch = useRef<ResizeObserver | null>(null);
  const composerField = useCallback((node: HTMLTextAreaElement | null) => {
    textarea.current = node;
    heightWatch.current?.disconnect();
    heightWatch.current = null;
    if (!node || typeof ResizeObserver === "undefined") return;
    heightWatch.current = new ResizeObserver(() => {
      const needsRows = node.offsetHeight > parseFloat(getComputedStyle(node).minHeight) + 4;
      setStacked((previous) => composerLayout(node.value, needsRows, previous));
    });
    heightWatch.current.observe(node);
  }, []);
  const form = useRef<HTMLFormElement>(null);
  const reportHeight = useStableCallback(onHeight);
  useEffect(() => {
    const node = form.current;
    if (!node) return;
    const observer = new ResizeObserver(() => reportHeight(Math.ceil(node.offsetHeight)));
    // The border box: under the iPhone app's composer only the padding changes, with the keyboard.
    observer.observe(node, { box: "border-box" });
    return () => observer.disconnect();
  }, [reportHeight]);

  const focus = useStableCallback(() => {
    if (nativeChrome) setFocusRev((n) => n + 1);
    else textarea.current?.focus();
  });

  const attach = useStableCallback((added: File[]) => {
    if (!added.length) return;
    const room = MAX_FILES - files.length;
    if (added.length > room) setNotice(`At most ${MAX_FILES} files per message.`);
    else if (notice) setNotice(null);
    if (room > 0) setFiles([...files, ...added.slice(0, room)]);
  });

  useImperativeHandle(ref, () => ({ focus, attach }), [focus, attach]);

  async function send(event?: FormEvent, after = false) {
    event?.preventDefault();
    const unsent = latestDraft();
    const text = unsent.trim();
    if ((!text && !files.length) || sending) return;
    setSending(true);
    setNotice(null);
    // Cleared as Send is tapped, so the field empties at once and what's typed while it's on its way stays.
    setDraft("");
    setRecall(null);
    try {
      const replyTo = reply?.id;
      let body: BodyInit = JSON.stringify({ body: text, ...(after ? { after: true } : {}), ...(replyTo ? { replyTo } : {}) });
      if (files.length) {
        const data = new FormData();
        data.set("body", text);
        if (after) data.set("after", "1");
        if (replyTo) data.set("replyTo", replyTo);
        for (const file of files) data.append("files", file, file.name);
        body = data;
      }
      const data = await api<{ message: Message }>(`/api/threads/${threadId}/messages`, { method: "POST", body });
      onSent(data.message);
      setFiles([]);
    } catch (failure) {
      if (unsent) setDraft((d) => unsentBack(d, unsent));
      setNotice(failure instanceof Error ? failure.message : "Couldn't send.");
    } finally {
      setSending(false);

      if (!touch) textarea.current?.focus();
    }
  }

  function insertToken(token: string) {
    if (!slash) return;
    const el = textarea.current;
    // The app's field keeps its caret to itself; what's typed there is at the end.
    const caret = nativeChrome ? draft.length : (el?.selectionStart ?? draft.length);
    const next = `${draft.slice(0, slash.start)}${token} ${draft.slice(caret)}`;
    setDraft(next);
    setSlash(null);
    if (nativeChrome) return focus();
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
      const at = recall !== null && sentLines[recall] === draft ? recall : null;
      const step = historyStep({ key: event.key, text: draft, start: el.selectionStart, end: el.selectionEnd, at, count: sentLines.length });
      if (step !== null) {
        event.preventDefault();
        const next = step < 0 ? "" : sentLines[step]!;
        setRecall(step < 0 ? null : step);
        setDraft(next);
        window.requestAnimationFrame(() => el.setSelectionRange(next.length, next.length));
        return;
      }
    }
    if (event.key === "Escape" && reply) {
      event.preventDefault();
      onCancelReply();
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

  const mention = (who: Mentionable) => {
    setDraft((d) => `${d}${d && !d.endsWith(" ") ? " " : ""}@${who.handle} `);
    focus();
  };

  function openPicker(input: RefObject<HTMLInputElement | null>) {
    if (files.length >= MAX_FILES) {
      setNotice(`At most ${MAX_FILES} files per message.`);
      return;
    }
    input.current?.click();
  }

  function onPickFiles(event: ChangeEvent<HTMLInputElement>) {
    attach([...(event.target.files ?? [])]);
    event.target.value = "";
  }

  const placeholder = reply ? `Reply to ${reply.name}` : hint;
  const attachButton = phone ? (
    <DropdownMenu>
      <DropdownMenuTrigger render={<InputGroupButton type="button" variant="ghost" size="icon-sm" aria-label="Attach files" className={cn("rounded-full", below && "mr-auto")} />}>
        <Paperclip aria-hidden="true" className="size-[18px]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => openPicker(cameraInput)}>
            <Camera aria-hidden="true" />
            Take photo
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openPicker(photoInput)}>
            <ImageIcon aria-hidden="true" />
            Photo library
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openPicker(fileInput)}>
            <Folder aria-hidden="true" />
            Files
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <Tooltip>
      <TooltipTrigger render={<InputGroupButton type="button" variant="ghost" size="icon-sm" aria-label="Attach files" onClick={() => openPicker(fileInput)} className={cn("rounded-full", below && "mr-auto")} />}>
        <Paperclip aria-hidden="true" className="size-[18px]" />
      </TooltipTrigger>
      <TooltipContent>Attach files</TooltipContent>
    </Tooltip>
  );

  return (
    <>
      <form
        onSubmit={send}
        ref={form}
        data-native-composer={nativeChrome ? "" : undefined}
        style={nativeChrome ? { paddingBottom: "var(--native-composer-bottom, max(0.75rem, var(--safe-bottom)))" } : undefined}
        className={cn("pointer-events-none absolute inset-x-0 bottom-0 z-20 px-3 pt-2.5 pb-[calc(var(--safe-bottom)+8px)] sm:px-4 sm:pt-3 wide:px-[max(1.5rem,calc((100%-46rem)/2))] wide:pb-5 [&>*]:pointer-events-auto", nativeChrome && "transition-[padding] duration-250 ease-out")}
      >
        <input ref={cameraInput} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onPickFiles} />
        <input ref={photoInput} type="file" accept="image/*" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onPickFiles} />
        <input ref={fileInput} type="file" multiple className="sr-only" tabIndex={-1} aria-hidden="true" onChange={onPickFiles} />
        {chips.length && !nativeChrome ? (
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
                <ComposerFileMedia file={file} />
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
        {reply && !nativeChrome ? <ReplyingTo name={reply.name} color={reply.color} text={reply.text} onCancel={onCancelReply} /> : null}
        <div
          className={cn(!nativeChrome && "-mx-3 -mt-2 -mb-[calc(var(--safe-bottom)+8px)] px-3 pt-2 pb-[calc(var(--safe-bottom)+8px)] sm:-mx-4 sm:px-4 wide:m-0 wide:p-0")}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && document.activeElement === textarea.current) e.preventDefault();
          }}
        >
          <div className="relative flex items-end gap-2.5">
            {slash ? <SlashMenu kind={slash.kind} skills={skills} people={mentionable} query={slash.query} selected={slash.selected} onPickSkill={(skill) => insertSkill(skill.slug)} onPickPerson={insertMention} /> : null}
            <InputGroup variant="pill" className={cn("min-h-11 rounded-[22px] px-1.5 wide:shadow-subtle-3", nativeChrome && "invisible overflow-hidden")} style={nativeChrome ? { height: "var(--native-composer-height, 2.75rem)" } : undefined}>
              {below ? null : (
                <InputGroupAddon align="inline-start" className="self-end pt-0 pb-[5px] pl-0">
                  {attachButton}
                </InputGroupAddon>
              )}
              <InputGroupTextarea
                ref={composerField}
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
                placeholder={placeholder}
                aria-label={label}
                enterKeyHint={touch ? "enter" : "send"}
                // An empty field is one row whatever its hint, so a long one never makes the pill taller.
                className={cn("max-h-40 min-h-[42px] py-2.5 pr-4 text-[16px] leading-5 placeholder-shown:h-[42px] placeholder-shown:overflow-hidden placeholder-shown:[field-sizing:fixed] placeholder:truncate sm:text-[14px]", below ? "pl-2.5" : "pl-1.5")}
              />
              <InputGroupAddon align={below ? "block-end" : "inline-end"} className={cn("mr-0 gap-1 pt-0 pr-0 pb-[5px] has-[>button]:mr-0", below ? "justify-end pl-0" : "self-end")}>
                {below ? attachButton : null}

                {busy && draft.trim() && !files.length ? (
                  <Tooltip>
                    <TooltipTrigger render={<InputGroupButton type="button" variant="ghost" size="sm" aria-label="Send after it finishes" disabled={sending} onClick={() => void send(undefined, true)} className="rounded-full" />}>
                      <ListEnd aria-hidden="true" />
                      <span className="hidden pointer-coarse:inline">Later</span>
                    </TooltipTrigger>
                    <TooltipContent>Send after it finishes</TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger render={<InputGroupButton type="submit" variant="tint" size="icon-sm" aria-label="Send" disabled={sending || (!draft.trim() && !files.length)} className="rounded-full" />}>
                    <ArrowUp aria-hidden="true" />
                  </TooltipTrigger>
                  <TooltipContent>{touch ? "Send" : "Send (Enter)"}</TooltipContent>
                </Tooltip>
              </InputGroupAddon>
            </InputGroup>
          </div>
        </div>
      </form>
      {nativeChrome ? (
        <ConversationChrome
          {...chrome}
          mentions={chips.map((who) => ({ id: who.id, handle: who.handle }))}
          files={files.map((file) => ({ name: file.name, size: formatBytes(file.size) }))}
          replying={reply ? { name: reply.name, color: reply.color ?? "", text: reply.text } : null}
          composer={{
            text: draft,
            textRev: draftRev,
            focusRev,
            placeholder,
            canSend: !sending && Boolean(draft.trim() || files.length),
            sending,
            later: busy && Boolean(draft.trim()) && !files.length,
          }}
          onEvent={(event) => {
            if (event.type === "text") {
              appTyped(event.value);
              setRecall(null);
              if (notice) setNotice(null);
              trackSlash(event.value, event.value.length);
            } else if (event.type === "send") void send(undefined, Boolean(event.later));
            else if (event.type === "attach") void filesFrom(event.files).then(attach, () => setNotice("Couldn't attach that file."));
            else if (event.type === "notice") setNotice(event.text);
            else if (event.type === "mention") {
              const who = chips.find((chip) => chip.id === event.id);
              if (who) mention(who);
            } else if (event.type === "remove-file") setFiles(files.filter((_, at) => at !== event.index));
            else onChromeEvent(event);
          }}
        />
      ) : null}
    </>
  );
}
