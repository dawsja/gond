"use client";

import { RETENTION_DAYS, type BackupInfo, type CompactResult, type RetentionDays, type ServerStorage } from "@gond/shared";
import { Database, Download, HardDrive, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Confirm } from "@/components/confirm-dialog";
import { failed } from "@/components/failed";
import { LoadFailed } from "@/components/load-failed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, del, patch, post } from "@/lib/api";
import { formatBytes } from "@/lib/bytes";

const RETENTION_LABELS: Record<RetentionDays, string> = {
  0: "Forever",
  30: "30 days",
  90: "90 days",
  365: "1 year",
};

const RETENTION_ITEMS = RETENTION_DAYS.map((days) => ({ value: String(days), label: RETENTION_LABELS[days] }));

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function ServerStorageSection() {
  const [data, setData] = useState<ServerStorage | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmCompact, setConfirmCompact] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BackupInfo | null>(null);

  const load = useCallback(async () => {
    const res = await api<ServerStorage>("/api/server/storage").catch(() => null);
    setLoadFailed(!res);
    if (res) setData(res);
  }, []);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  async function createBackupNow() {
    setCreating(true);
    try {
      const res = await post<ServerStorage & { backup: BackupInfo }>("/api/server/backups");
      setData(res);
      toast.add({ type: "success", title: "Backup saved.", description: `${formatBytes(res.backup.size)} ready to download.` });
    } catch (failure) {
      failed("Couldn't create the backup.")(failure);
    } finally {
      setCreating(false);
    }
  }

  async function removeBackup(backup: BackupInfo) {
    await del(`/api/server/backups/${encodeURIComponent(backup.name)}`);
    setData((current) => (current ? { ...current, backups: current.backups.filter((b) => b.name !== backup.name) } : current));
    toast.add({ type: "success", title: "Backup deleted." });
  }

  async function updateStorage(body: { usageKeepDays?: RetentionDays; attachmentsKeepDays?: RetentionDays }) {
    setSaving(true);
    try {
      const res = await patch<ServerStorage>("/api/server/storage", body);
      setData(res);
    } catch (failure) {
      failed("Couldn't save that setting.")(failure);
    } finally {
      setSaving(false);
    }
  }

  async function runCompact() {
    setCompacting(true);
    try {
      const res = await post<ServerStorage & { result: CompactResult }>("/api/server/storage/compact");
      setData(res);
      const parts: string[] = [];
      if (res.result.prunedAttachments) parts.push(`${res.result.prunedAttachments} old ${res.result.prunedAttachments === 1 ? "file" : "files"}`);
      if (res.result.prunedUsage) parts.push(`${res.result.prunedUsage.toLocaleString()} usage ${res.result.prunedUsage === 1 ? "entry" : "entries"}`);
      if (res.result.prunedExports) parts.push(`${res.result.prunedExports} expired ${res.result.prunedExports === 1 ? "export" : "exports"}`);
      const detail = parts.length ? `Removed ${parts.join(", ")}, about ${formatBytes(res.result.freedBytes)} the database can use again.` : "Nothing was old enough to remove.";
      toast.add({ type: "success", title: "Cleanup finished.", description: detail });
    } catch (failure) {
      failed("Couldn't clean up the database.")(failure);
    } finally {
      setCompacting(false);
    }
  }

  if (loadFailed && !data) return <LoadFailed what="your server storage" onRetry={() => void load()} />;
  if (!data) {
    return (
      <>
        <Skeleton className="h-56 rounded-3xl" />
        <Skeleton className="h-52 rounded-3xl" />
      </>
    );
  }

  const willPrune = data.retention.usageKeepDays > 0 || data.retention.attachmentsKeepDays > 0;
  const backupsSize = data.backups.reduce((sum, backup) => sum + backup.size, 0);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Backups</CardTitle>
          <CardDescription>
            Download a standalone copy of Gond&apos;s database, including chats, memories, routines and encrypted secrets. Gond also saves a backup automatically before every server update.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-3 rounded-2xl bg-muted/60 p-3.5 wide:grid-cols-4">
            <Stat label="Database" value={formatBytes(data.db.totalBytes)} detail={`${formatBytes(data.freeBytes)} free on the disk`} />
            <Stat label="Messages" value={formatBytes(data.db.messagesBytes)} detail="Chats and search" />
            <Stat label="Files" value={formatBytes(data.db.attachmentsBytes)} detail={`${data.db.attachmentCount} ${data.db.attachmentCount === 1 ? "file" : "files"}`} />
            <Stat label="Usage log" value={data.db.usageCount ? `About ${formatBytes(data.db.usageBytes)}` : formatBytes(0)} detail={`${data.db.usageCount.toLocaleString()} ${data.db.usageCount === 1 ? "entry" : "entries"}`} />
          </div>

          {data.backups.length ? (
            <section className="flex flex-col border-t pt-4">
              <h3 className="mb-1 text-sm font-medium">
                Saved backups <span className="font-normal text-muted-foreground">· {formatBytes(backupsSize)} in all</span>
              </h3>
              <ul className="flex flex-col divide-y">
                {data.backups.map((backup) => (
                  <BackupRow key={backup.name} item={backup} onDelete={() => setDeleteTarget(backup)} />
                ))}
              </ul>
              <p className="mt-2 text-[13px] text-muted-foreground">Each backup is a whole copy of the database on this server&apos;s disk. Gond keeps your last 3 and the last 2 from before updates. Keep a copy of your secret key alongside any backup you store elsewhere, or stored secrets can&apos;t be read back.</p>
            </section>
          ) : (
            <p className="text-[13.5px] text-muted-foreground">No backups saved yet. Create one now, or Gond will save one automatically before your next update.</p>
          )}
        </CardContent>
        <CardFooter>
          <Button onClick={() => void createBackupNow()} disabled={creating}>
            {creating ? <Spinner data-icon="inline-start" /> : <Database data-icon="inline-start" aria-hidden="true" />}
            {creating ? "Creating backup…" : "Create backup"}
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Storage</CardTitle>
          <CardDescription>Keep old usage history and uploaded files from growing the database without limit. Cleanup runs daily, or whenever you run it below.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <FieldGroup className="gap-3 wide:grid wide:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="usage-keep">Keep usage history</FieldLabel>
              <Select
                items={RETENTION_ITEMS}
                value={String(data.retention.usageKeepDays)}
                disabled={saving}
                onValueChange={(value) => value && void updateStorage({ usageKeepDays: Number(value) as RetentionDays })}
              >
                <SelectTrigger id="usage-keep" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {RETENTION_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="attachments-keep">Keep uploaded files</FieldLabel>
              <Select
                items={RETENTION_ITEMS}
                value={String(data.retention.attachmentsKeepDays)}
                disabled={saving}
                onValueChange={(value) => value && void updateStorage({ attachmentsKeepDays: Number(value) as RetentionDays })}
              >
                <SelectTrigger id="attachments-keep" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {RETENTION_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </FieldGroup>
          <p className="text-[13px] text-muted-foreground">Chats keep their messages, but a removed file can&apos;t be opened any more. The space it took is used again before the database grows; the file on disk doesn&apos;t get smaller.</p>
        </CardContent>
        <CardFooter>
          <Button variant="outline" disabled={compacting} onClick={() => (willPrune ? setConfirmCompact(true) : void runCompact())}>
            {compacting ? <Spinner data-icon="inline-start" /> : <HardDrive data-icon="inline-start" aria-hidden="true" />}
            {compacting ? "Cleaning up…" : "Clean up now"}
          </Button>
        </CardFooter>
      </Card>

      <Confirm
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete this backup?"
        description={deleteTarget ? `${deleteTarget.name} (${formatBytes(deleteTarget.size)}) will be removed from the server.` : ""}
        action="Delete backup"
        onConfirm={async () => {
          if (deleteTarget) await removeBackup(deleteTarget);
          setDeleteTarget(null);
        }}
      />

      <Confirm
        open={confirmCompact}
        onOpenChange={setConfirmCompact}
        title="Clean up now?"
        description="This removes usage entries and uploaded files older than the limits you picked. Removed files can't be opened from your chats any more."
        action="Clean up now"
        destructive={false}
        onConfirm={async () => {
          await runCompact();
          setConfirmCompact(false);
        }}
      />
    </>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className="text-[15px] font-semibold tabular-nums">{value}</span>
      <span className="text-[12px] text-muted-foreground">{detail}</span>
    </div>
  );
}

function BackupRow({ item, onDelete }: { item: BackupInfo; onDelete: () => void }) {
  return (
    <li className="flex items-center gap-3 py-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground [&_svg]:size-[18px]">
        <Database aria-hidden="true" />
      </span>
      <div className="flex min-w-0 grow flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium whitespace-nowrap">{when(item.createdAt)}</span>
          <Badge variant="secondary">{item.reason === "pre-update" ? "Before update" : "Manual"}</Badge>
        </div>
        <span className="truncate text-[13px] text-muted-foreground tabular-nums">
          {formatBytes(item.size)}
          <span className="hidden wide:inline"> · {item.name}</span>
        </span>
      </div>
      <Button variant="outline" className="hidden wide:inline-flex" render={<a href={`/api/server/backups/${encodeURIComponent(item.name)}`} download={item.name} />} nativeButton={false}>
        <Download data-icon="inline-start" aria-hidden="true" />
        Download
      </Button>
      <Button variant="outline" size="icon" aria-label="Download this backup" className="wide:hidden" render={<a href={`/api/server/backups/${encodeURIComponent(item.name)}`} download={item.name} />} nativeButton={false}>
        <Download aria-hidden="true" />
      </Button>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label="Delete this backup" onClick={onDelete} />}>
          <Trash2 aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>Delete</TooltipContent>
      </Tooltip>
    </li>
  );
}
