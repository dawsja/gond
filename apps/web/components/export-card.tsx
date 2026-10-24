"use client";

import { EXPORT_KEEP_DAYS, EXPORT_RANGES, EXPORTS_LISTED, type ChatExport, type ExportRange } from "@gond/shared";
import { CircleAlert, Clock, Download, FileArchive, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { failed } from "@/components/failed";
import { useLiveEvents } from "@/components/hq/live-events";
import { LoadFailed } from "@/components/load-failed";
import { useStore } from "@/components/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, del, post } from "@/lib/api";

const ALL = "all";

function formatBytes(n: number) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function ExportCard() {
  const { threads } = useStore();
  const [exports, setExports] = useState<ChatExport[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [chat, setChat] = useState<string>(ALL);
  const [range, setRange] = useState<ExportRange>("all");
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ exports: ChatExport[] }>("/api/exports").catch(() => null);
    setLoadFailed(!data);
    if (data) setExports(data.exports);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic !== "exports") return;
    setExports((current) => {
      if (!current) return current;
      const rest = current.filter((x) => x.id !== event.id);
      if (!event.export) return rest;
      const at = current.findIndex((x) => x.id === event.id);
      return at === -1 ? [event.export, ...rest].slice(0, EXPORTS_LISTED) : current.map((x) => (x.id === event.id ? event.export! : x));
    });
  });

  const bots = threads.filter((t) => t.kind === "bot");
  const rooms = threads.filter((t) => t.kind === "room");
  const picked = chat === ALL ? null : (threads.find((t) => t.id === chat) ?? null);
  const preparing = exports?.some((x) => x.status === "preparing") ?? false;

  async function start() {
    setStarting(true);
    try {
      const data = await post<{ export: ChatExport }>("/api/exports", { threadId: picked?.id ?? null, range });
      setExports((current) => [data.export, ...(current ?? []).filter((x) => x.id !== data.export.id)].slice(0, EXPORTS_LISTED));
    } catch (failure) {
      failed("Couldn't start the export.")(failure);
    } finally {
      setStarting(false);
    }
  }

  async function remove(id: string) {
    setDeleting(id);
    try {
      await del(`/api/exports/${id}`);
      setExports((current) => current?.filter((x) => x.id !== id) ?? current);
    } catch (failure) {
      failed("Couldn't delete the export.")(failure);
    } finally {
      setDeleting(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export your chats</CardTitle>
        <CardDescription>
          Gond gathers your conversations on the server and lets you know when the file is ready, so you can leave this page. Each chat comes as a readable Markdown file and a complete JSON file, with its files and pictures.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <FieldGroup className="gap-3 wide:grid wide:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="export-chats">Chats</FieldLabel>
            <Select items={[{ value: ALL, label: "All bots and rooms" }, ...threads.map((t) => ({ value: t.id, label: t.name }))]} value={picked ? chat : ALL} onValueChange={(value) => value && setChat(value)}>
              <SelectTrigger id="export-chats" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value={ALL}>All bots and rooms</SelectItem>
                </SelectGroup>
                {bots.length ? (
                  <>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Bots</SelectLabel>
                      {bots.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </>
                ) : null}
                {rooms.length ? (
                  <>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Rooms</SelectLabel>
                      {rooms.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </>
                ) : null}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="export-range">From</FieldLabel>
            <Select items={EXPORT_RANGES.map((r) => ({ value: r.id, label: r.label }))} value={range} onValueChange={(value) => value && setRange(value as ExportRange)}>
              <SelectTrigger id="export-range" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {EXPORT_RANGES.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        {loadFailed && !exports ? <LoadFailed what="your exports" onRetry={() => void load()} /> : null}
        {!exports && !loadFailed ? <Skeleton className="h-16 rounded-xl" /> : null}
        {exports?.length ? (
          <section className="flex flex-col border-t pt-4">
            <h3 className="mb-1 text-sm font-medium">Your exports</h3>
            <ul className="flex flex-col divide-y">
              {exports.map((x) => (
                <ExportRow key={x.id} item={x} deleting={deleting === x.id} onDelete={() => void remove(x.id)} />
              ))}
            </ul>
            <p className="mt-2 text-[13px] text-muted-foreground">Exports are kept for {EXPORT_KEEP_DAYS} days. Stored secrets are never in them.</p>
          </section>
        ) : null}
      </CardContent>
      <CardFooter>
        <Button onClick={() => void start()} disabled={starting || preparing || !threads.length}>
          {starting ? <Spinner data-icon="inline-start" /> : null}
          {preparing ? "Preparing an export…" : "Start an export"}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ExportRow({ item, deleting, onDelete }: { item: ChatExport; deleting: boolean; onDelete: () => void }) {
  const remove = (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label={item.status === "preparing" ? "Stop and delete this export" : "Delete this export"} onClick={onDelete} disabled={deleting} />}>
        {deleting ? <Spinner /> : <Trash2 aria-hidden="true" />}
      </TooltipTrigger>
      <TooltipContent>{item.status === "preparing" ? "Stop and delete" : "Delete"}</TooltipContent>
    </Tooltip>
  );
  const icon = { preparing: <Spinner />, ready: <FileArchive aria-hidden="true" />, failed: <CircleAlert aria-hidden="true" />, expired: <Clock aria-hidden="true" /> }[item.status];

  return (
    <li className="flex items-center gap-3 py-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-[18px]">{icon}</span>
      <div className="flex min-w-0 grow flex-col gap-0.5">
        {item.status === "preparing" ? (
          <Progress value={item.total ? Math.round((item.done / item.total) * 100) : null} aria-label="How far the export has got" className="gap-2">
            <span className="text-sm font-medium">Preparing {item.label.charAt(0).toLowerCase() + item.label.slice(1)}</span>
            <span className="ml-auto text-[13px] text-muted-foreground tabular-nums">
              {item.done} of {item.total} {item.total === 1 ? "chat" : "chats"}
            </span>
          </Progress>
        ) : (
          <>
            <span className={item.status === "expired" ? "text-sm font-medium break-words text-muted-foreground" : "text-sm font-medium break-words"}>{item.label}</span>
            <span className="text-[13px] text-muted-foreground">
              {item.status === "ready" && item.size !== null && item.expiresAt ? `${day(item.createdAt)} · ${formatBytes(item.size)} · kept until ${day(item.expiresAt)}` : null}
              {item.status === "failed" ? item.error : null}
              {item.status === "expired" ? `${day(item.createdAt)} · no longer kept` : null}
            </span>
          </>
        )}
      </div>
      {item.status === "ready" ? (
        <Button variant="outline" render={<a href={`/api/exports/${item.id}/download`} download />} nativeButton={false}>
          <Download data-icon="inline-start" aria-hidden="true" />
          Download
        </Button>
      ) : null}
      {item.status === "failed" ? <Badge tone="bad">Didn&apos;t finish</Badge> : null}
      {item.status === "expired" ? <Badge variant="secondary">Expired</Badge> : remove}
    </li>
  );
}
