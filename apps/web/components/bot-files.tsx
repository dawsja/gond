"use client";

import type { Bot, BotFileEntry } from "@gond/shared";
import { ChevronLeft, Download, File, FileImage, FileText, Folder, FolderOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError } from "@/lib/api";

const SHOWN = 8;
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
const TEXT = /\.(md|markdown|txt|csv|json|jsonl|ya?ml|toml|log|html?|css|js|mjs|ts|tsx|py|sh|sql|xml|svg|ini|env\.example)$/i;

type Listing = { entries?: BotFileEntry[]; directory?: string[] };
type Opened = { path: string; entry: BotFileEntry };

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
}

function join(folder: string, name: string): string {
  return folder === "." ? name : `${folder}/${name}`;
}

const rawUrl = (bot: Bot, path: string, view = false) => `/api/bots/${bot.id}/files/raw?path=${encodeURIComponent(path)}${view ? "&view=1" : ""}`;

function FileIcon({ entry }: { entry: BotFileEntry }) {
  const Icon = entry.dir ? Folder : PICTURE.test(entry.name) ? FileImage : TEXT.test(entry.name) ? FileText : File;
  return <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

/** What the bot keeps in its own folder on the computer, to look at and download without opening the computer. */
export function BotFiles({ bot }: { bot: Bot }) {
  const [folder, setFolder] = useState(".");
  const [entries, setEntries] = useState<BotFileEntry[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [opened, setOpened] = useState<Opened | null>(null);

  const load = useCallback(async () => {
    try {
      const { file } = await api<{ file: Listing }>(`/api/bots/${bot.id}/files?path=${encodeURIComponent(folder)}`);
      const list = file.entries ?? (file.directory ?? []).map((name) => ({ name, dir: false, size: 0, modified: null }));
      setEntries(list.filter((e) => !e.name.startsWith(".")).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
      setFailure(null);
    } catch (error) {
      setEntries([]);
      setFailure(error instanceof ApiError && error.status === 404 && folder === "." ? null : error instanceof ApiError && error.status === 503 ? "The computer isn't running, so its files can't be read right now." : error instanceof Error ? error.message : "Couldn't read the files.");
    }
  }, [bot.id, folder]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const go = (next: string) => {
    setEntries(null);
    setAll(false);
    setFolder(next);
  };
  const shown = entries && !all ? entries.slice(0, SHOWN) : entries;

  return (
    <section>
      <h2 className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">Files</h2>
      {folder !== "." ? (
        <button type="button" onClick={() => go(folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : ".")} className="mt-2 flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-left text-[13px] font-medium outline-none hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11">
          <ChevronLeft className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="truncate">{folder}</span>
        </button>
      ) : null}
      {entries === null ? (
        <div className="mt-3 flex justify-center">
          <Spinner className="text-muted-foreground" />
        </div>
      ) : failure ? (
        <p className="mt-2 text-[12.5px] text-muted-foreground">{failure}</p>
      ) : entries.length === 0 ? (
        <Empty className="mt-2 border px-3 py-5">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Folder />
            </EmptyMedia>
            <EmptyTitle>{folder === "." ? "No files yet" : "Nothing in here"}</EmptyTitle>
            <EmptyDescription className="text-xs">{folder === "." ? `What ${bot.name} makes and keeps on the computer shows up here.` : "This folder is empty."}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="mt-2 flex flex-col gap-0.5">
          {shown!.map((entry) => {
            const path = join(folder, entry.name);
            return (
              <li key={entry.name} className="flex items-center gap-1 rounded-lg hover:bg-card">
                <button type="button" onClick={() => (entry.dir ? go(path) : setOpened({ path, entry }))} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11">
                  <FileIcon entry={entry} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{entry.name}</span>
                  <span className="shrink-0 text-[11.5px] text-muted-foreground">{entry.dir ? when(entry.modified) : size(entry.size)}</span>
                </button>
                {entry.dir ? null : (
                  <Button variant="ghost" size="icon-sm" aria-label={`Download ${entry.name}`} render={<a href={rawUrl(bot, path)} download={entry.name} />} nativeButton={false} className="shrink-0 pointer-coarse:size-11">
                    <Download aria-hidden="true" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {entries && entries.length > SHOWN ? (
        <Button variant="ghost" size="sm" onClick={() => setAll((a) => !a)} className="mt-1 w-full">
          {all ? "Show fewer" : `Show all ${entries.length}`}
        </Button>
      ) : null}
      {opened ? <FileViewer bot={bot} opened={opened} onClose={() => setOpened(null)} /> : null}
    </section>
  );
}

function FileViewer({ bot, opened, onClose }: { bot: Bot; opened: Opened; onClose: () => void }) {
  const { path, entry } = opened;
  const picture = PICTURE.test(entry.name);
  const [text, setText] = useState<{ content: string | null; note: string | null } | null>(picture ? { content: null, note: null } : null);

  useEffect(() => {
    if (picture) return;
    api<{ file: { content?: string; binary?: boolean } }>(`/api/bots/${bot.id}/files?path=${encodeURIComponent(path)}`)
      .then(({ file }) => setText(file.content !== undefined ? { content: file.content, note: null } : { content: null, note: "This file can't be shown here. Download it to open it." }))
      .catch((error: unknown) => setText({ content: null, note: error instanceof ApiError && error.status === 413 ? "This file is too large to show here. Download it to open it." : error instanceof Error ? error.message : "Couldn't open it." }));
  }, [bot.id, path, picture]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="truncate pr-10">{entry.name}</DialogTitle>
          <DialogDescription>
            {size(entry.size)}
            {entry.modified ? ` · changed ${new Date(entry.modified).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
          </DialogDescription>
        </DialogHeader>
        {picture ? (
          // eslint-disable-next-line @next/next/no-img-element -- a file from the bot's folder, served only when its bytes are a picture
          <img src={rawUrl(bot, path, true)} alt={entry.name} className="mx-auto max-h-[60dvh] max-w-full rounded-2xl border border-primary-edge object-contain" />
        ) : text === null ? (
          <div className="flex justify-center py-10">
            <Spinner className="text-muted-foreground" />
          </div>
        ) : text.content === null ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{text.note}</p>
        ) : /\.(md|markdown)$/i.test(entry.name) ? (
          <div className="rounded-2xl border border-primary-edge bg-primary px-4 py-3 text-[14px]">
            <Markdown text={text.content} />
          </div>
        ) : (
          <pre className="overflow-x-auto rounded-2xl border border-primary-edge bg-primary px-4 py-3 font-mono text-[12.5px] leading-5 whitespace-pre-wrap wrap-anywhere">{text.content}</pre>
        )}
        <DialogFooter>
          <Button variant="outline" size="lg" onClick={onClose}>
            Close
          </Button>
          <Button size="lg" render={<a href={rawUrl(bot, path)} download={entry.name} />} nativeButton={false}>
            <Download data-icon="inline-start" aria-hidden="true" />
            Download
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
