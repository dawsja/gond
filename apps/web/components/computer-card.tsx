"use client";

import { BOX_UPDATE_PHASE_LABELS, type BoxStatus, type BoxUpdate } from "@gond/shared";
import { RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useStore } from "@/components/store";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogMedia, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { api, post } from "@/lib/api";
import { cn } from "@/lib/utils";

const ORDER = ["pausing", "pulling", "restarting", "resetting", "patching", "resuming", "done"] as const;

function versionOf(text: string | null | undefined): string | null {
  return text ? (/\d+(?:\.\d+)+/.exec(text)?.[0] ?? text) : null;
}

function progressOf(update: BoxUpdate | null): number {
  if (!update) return 0;
  if (update.phase === "failed") return 100;
  const at = ORDER.indexOf(update.phase as (typeof ORDER)[number]);
  return at < 0 ? 0 : Math.round(((at + 1) / ORDER.length) * 100);
}

export function ComputerCard({ status, admin, onCheck }: { status: BoxStatus | null; admin: boolean; onCheck: () => Promise<void> | void }) {
  const { boxUpdate, boxUpdating } = useStore();
  const [docker, setDocker] = useState<{ available: boolean; reason: string | null } | null>(null);
  const [confirming, setConfirming] = useState<"update" | "reset" | null>(null);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!admin) return;
    void Promise.resolve().then(() =>
      api<{ docker: { available: boolean; reason: string | null } }>("/api/box/update")
        .then((d) => setDocker(d.docker))
        .catch(() => undefined),
    );
  }, [admin]);
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [boxUpdate?.log.length]);

  async function start(kind: "update" | "reset") {
    setConfirming(null);
    setShowLog(true);
    try {
      await post(kind === "update" ? "/api/box/update" : "/api/box/reset", kind === "update" ? { pull: true } : {});
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : `Couldn't start the ${kind}.` });
    }
  }

  const versions = status?.versions;
  const installed = versions
    ? [
        { name: "Node", version: versionOf(versions.node) },
        { name: "Bun", version: versionOf(versions.bun) },
        { name: "Claude Code", version: versionOf(versions.claude) },
      ].filter((tool) => tool.version)
    : [];
  const liveSessions = status?.agents.filter((a) => a.running).length ?? 0;
  const state: { text: string; tone: "ok" | "busy" | "problem" | "unknown"; detail: string } = boxUpdating
    ? { text: "Updating", tone: "busy", detail: "The computer is paused while it updates. Messages wait and are answered after." }
    : !status
      ? { text: "Checking…", tone: "unknown", detail: "" }
      : !status.configured
        ? { text: "Not set up", tone: "problem", detail: "Gond isn't connected to a computer. Set GOND_BOX_URL on the API to connect it." }
        : !status.reachable
          ? { text: "Unreachable", tone: "problem", detail: "The computer isn't answering. Check that its container is running." }
          : { text: "Running", tone: "ok", detail: liveSessions ? (liveSessions === 1 ? (admin ? "1 bot session is live on it." : "1 of your bots is live on it.") : admin ? `${liveSessions} bot sessions are live on it.` : `${liveSessions} of your bots are live on it.`) : admin ? "No bot is working on it right now." : "None of your bots is working on it right now." };

  const blocked = boxUpdating || !status?.reachable;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Status</CardTitle>
          <CardDescription>The machine every bot works on. Everyone has their own account there, kept through restarts and updates.</CardDescription>
          <CardAction>
            <Button variant="ghost" size="sm" onClick={() => void onCheck()}>
              Check again
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant="outline" className="h-6 gap-1.5">
              <span className={cn("size-2 rounded-full", state.tone === "ok" ? "bg-mint" : state.tone === "busy" ? "bg-amber" : state.tone === "problem" ? "bg-destructive" : "bg-ash")} aria-hidden="true" />
              {state.text}
            </Badge>
            <span className="flex-1 text-[13.5px]">{state.detail}</span>
          </div>
          {installed.length ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-muted-foreground">Installed</span>
              <div className="flex flex-wrap gap-1.5">
                {installed.map((tool) => (
                  <Badge key={tool.name} variant="secondary">
                    {tool.name} {tool.version}
                  </Badge>
                ))}
              </div>
            </div>
          ) : null}

          {boxUpdate && admin ? (
            <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
              <Progress value={progressOf(boxUpdate)} aria-label="Update progress" className={cn(boxUpdate.phase === "failed" && "[&_[data-slot=progress-indicator]]:bg-destructive")}>
                <span className="flex w-full items-center gap-2 text-[13px] font-medium">
                  {boxUpdating ? <Spinner /> : null}
                  {BOX_UPDATE_PHASE_LABELS[boxUpdate.phase]}
                  <button type="button" onClick={() => setShowLog((v) => !v)} className="ml-auto text-xs font-normal text-muted-foreground underline underline-offset-3 hover:text-foreground">
                    {showLog ? "Hide the log" : "Show the log"}
                  </button>
                </span>
              </Progress>
              {boxUpdate.error ? <p className="text-[12.5px] text-destructive">{boxUpdate.error}</p> : null}
              {showLog ? (
                <pre ref={logRef} data-select-all className="max-h-56 overflow-y-auto rounded-lg border bg-background p-3 font-mono text-[11.5px] leading-5 whitespace-pre-wrap text-foreground dark:bg-black/40">
                  {boxUpdate.log.join("\n") || "…"}
                </pre>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {admin ? (
        <Card>
          <CardHeader>
            <CardTitle>Update and reset</CardTitle>
            <CardDescription>Both stop every bot that&apos;s working, for everyone, and ask before they start.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ActionRow
              icon={<RefreshCw />}
              tone="warn"
              title="Update the computer"
              badge="Pauses everyone"
              line="Restarts it on the newest version. Everyone's files stay."
              action={
                <Button variant="outline" disabled={blocked} onClick={() => setConfirming("update")}>
                  {boxUpdating && boxUpdate?.kind !== "reset" ? <Spinner data-icon="inline-start" /> : null}
                  {boxUpdating && boxUpdate?.kind !== "reset" ? "Updating…" : "Update"}
                </Button>
              }
            />
            <Separator />
            <ActionRow
              icon={<Trash2 />}
              tone="destructive"
              title="Reset the computer"
              badge="Can't be undone"
              line="Deletes everyone's files and every bot's memory on it."
              action={
                <Button variant="destructive" disabled={blocked} onClick={() => setConfirming("reset")}>
                  {boxUpdating && boxUpdate?.kind === "reset" ? <Spinner data-icon="inline-start" /> : null}
                  {boxUpdating && boxUpdate?.kind === "reset" ? "Resetting…" : "Reset"}
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : null}

      <AlertDialog open={confirming === "reset"} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia tone="destructive">
              <TriangleAlert />
            </AlertDialogMedia>
            <AlertDialogTitle>Reset the computer for everyone?</AlertDialogTitle>
            <AlertDialogDescription>Every bot stops, and the computer goes back to how it was built. This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <Consequences
            groups={[
              { title: "Deleted", lines: ["Everyone's home folder and files", "Every bot's memory and work", "Anything the bots installed", "Websites the bots were signed in to"] },
              { title: "Kept", lines: ["Bots, chats, skills and settings", "Secrets and connected apps", "Everyone's AI sign-ins"] },
            ]}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onAction={() => start("reset")}>
              Reset for everyone
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirming === "update"} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogMedia tone="warn">
              <RefreshCw />
            </AlertDialogMedia>
            <AlertDialogTitle>Update the computer?</AlertDialogTitle>
            <AlertDialogDescription>Every bot stops what it&apos;s doing while the computer restarts on the newest version. It usually takes a few minutes.</AlertDialogDescription>
          </AlertDialogHeader>
          <Consequences
            groups={[
              { title: "Stopped", lines: ["Work that's running now", "Open desktops and terminals"] },
              { title: "Kept", lines: ["Everyone's files and bots' memory", "New messages, answered after"] },
            ]}
          />
          {docker && !docker.available ? <p className="text-[13px] text-muted-foreground">This server can&apos;t download a new image, so the computer is updated in place instead.</p> : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onAction={() => start("update")}>Update</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ActionRow({ icon, tone, title, badge, line, action }: { icon: ReactNode; tone: "warn" | "destructive"; title: string; badge: string; line: string; action: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 wide:flex-row wide:items-center">
      <div className="flex flex-1 items-start gap-3">
        <span className={cn("mt-0.5 inline-flex size-9 shrink-0 items-center justify-center rounded-full [&_svg]:size-4", tone === "destructive" ? "bg-destructive/10 text-destructive dark:bg-destructive/20" : "bg-[color-mix(in_oklch,var(--tone-warn)_14%,transparent)] text-tone-warn")} aria-hidden="true">
          {icon}
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{title}</span>
            <Badge tone={tone === "destructive" ? "bad" : "warn"}>{badge}</Badge>
          </div>
          <p className="text-[13.5px] text-muted-foreground">{line}</p>
        </div>
      </div>
      <div className="flex shrink-0 pl-12 wide:pl-0">{action}</div>
    </div>
  );
}

function Consequences({ groups }: { groups: { title: string; lines: string[] }[] }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-muted/50 p-4">
      {groups.map((group) => (
        <section key={group.title}>
          <h3 className="text-[13px] font-medium">{group.title}</h3>
          <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-muted-foreground">
            {group.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
