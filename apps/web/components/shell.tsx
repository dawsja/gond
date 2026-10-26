"use client";

import dynamic from "next/dynamic";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import { ShareBotDialog, SharedTemplate } from "@/components/bot-template";
import { CallPill } from "@/components/call/call-controls";
import { CallProvider } from "@/components/call/call-provider";
import { ComputerPanel } from "@/components/computer-panel";
import { failed } from "@/components/failed";
import { ShellNotifications } from "@/components/shell-notifications";
import { AppSidebar } from "@/components/sidebar";
import { ViewingReport } from "@/components/viewing-report";
import { VersionWatch } from "@/components/version-watch";
import { StoreProvider } from "@/components/store";
import { TeachingProvider } from "@/components/teach/teaching-store";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/toast";
import type { SessionUser } from "@/lib/session";
import { desktopShell, shellBridge, type DesktopDownload } from "@/lib/shell";

// Opened now and then, so they load when first opened rather than with every page.
const BotDialog = dynamic(() => import("@/components/bot-dialog").then((m) => m.BotDialog));
const RoomDialog = dynamic(() => import("@/components/room-dialog").then((m) => m.RoomDialog));
const InviteSpaceDialog = dynamic(() => import("@/components/spaces/space-dialogs").then((m) => m.InviteSpaceDialog));
const JoinSpace = dynamic(() => import("@/components/spaces/join-space").then((m) => m.JoinSpace));
const NewSpace = dynamic(() => import("@/components/spaces/join-space").then((m) => m.NewSpace));
const ProfilesDialog = dynamic(() => import("@/components/profiles").then((m) => m.ProfilesDialog));
const AddProfileDialog = dynamic(() => import("@/components/profiles").then((m) => m.AddProfileDialog));

export type ShellDialog =
  | { kind: "new-bot" }
  | { kind: "edit-bot"; botId: string }
  | { kind: "new-room" }
  | { kind: "edit-room"; threadId: string }
  | { kind: "computer"; botId?: string | null }
  | { kind: "share-bot"; botId: string }
  | { kind: "invite-space"; threadId: string }
  | { kind: "join-space"; link?: string }
  | { kind: "new-space" }
  | { kind: "profiles" }
  | { kind: "add-profile" }
  | null;

export function Shell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const [dialog, setDialog] = useState<ShellDialog>(null);
  return (
    <StoreProvider user={user}>
      <TeachingProvider>
      <CallProvider>
        <SidebarProvider style={{ "--sidebar-width": "300px" } as React.CSSProperties} className="h-dvh min-h-0 overflow-hidden">
          <AppSidebar onOpen={setDialog} />
          <SidebarInset className="min-h-0 min-w-0">
            {children}
          </SidebarInset>
        </SidebarProvider>
        {dialog?.kind === "new-bot" || dialog?.kind === "edit-bot" ? <BotDialog botId={dialog.kind === "edit-bot" ? dialog.botId : null} onClose={() => setDialog(null)} /> : null}
        {dialog?.kind === "new-room" || dialog?.kind === "edit-room" ? <RoomDialog threadId={dialog.kind === "edit-room" ? dialog.threadId : null} onClose={() => setDialog(null)} /> : null}
        {dialog?.kind === "computer" ? (
          <ComputerPanel
            botId={dialog.botId ?? null}
            onClose={() => setDialog(null)}
          />
        ) : null}
        {dialog?.kind === "share-bot" ? <ShareBotDialog botId={dialog.botId} onClose={() => setDialog(null)} /> : null}
        {dialog?.kind === "invite-space" ? <InviteSpaceDialog threadId={dialog.threadId} onClose={() => setDialog(null)} /> : null}
        {dialog?.kind === "join-space" ? <JoinSpace link={dialog.link} onClose={() => setDialog(null)} /> : null}
        {dialog?.kind === "new-space" ? <NewSpace onClose={() => setDialog(null)} /> : null}
        {dialog?.kind === "profiles" ? <ProfilesDialog onClose={() => setDialog(null)} /> : null}
        {dialog?.kind === "add-profile" ? <AddProfileDialog onClose={() => setDialog(null)} /> : null}
        <Suspense>
          <SharedTemplate />
        </Suspense>
        <ShellDialogBridge open={setDialog} />
        <ShellNotifications />
        <ViewingReport />
        <VersionWatch />
        <StrayDrops />
        <ScopedSelection />
        <OutsideLinks />
        <DesktopDownloads />
        <CallPill />
      </CallProvider>
      </TeachingProvider>
    </StoreProvider>
  );
}

export const OPEN_DIALOG_EVENT = "gond:open-dialog";

export function openShellDialog(dialog: NonNullable<ShellDialog>) {
  window.dispatchEvent(new CustomEvent(OPEN_DIALOG_EVENT, { detail: dialog }));
}

const SELECTION_SCOPE = "[data-select-all], [data-slot=dialog-content], [data-slot=alert-dialog-content], [data-slot=sheet-content]";

function isField(element: Element | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable);
}

/**
 * Selecting text in a box of it (a routine's prompt, a file, a code block: `data-select-all`) or in a
 * pop-up stays there, as in a field: Ctrl+A or ⌘A after a click in one selects it alone, and a mouse
 * drag that starts in one can't spill onto the page around it, so it scrolls the box instead.
 */
function ScopedSelection() {
  useEffect(() => {
    const root = document.documentElement;
    let last: Element | null = null;
    let scope: Element | null = null;
    const end = () => {
      root.removeAttribute("data-selecting");
      scope?.removeAttribute("data-selecting-in");
      scope = null;
    };
    const down = (event: PointerEvent) => {
      last = event.target instanceof Element ? event.target : null;
      end();
      if (event.pointerType !== "mouse" || event.button !== 0 || isField(last)) return;
      scope = last?.closest(SELECTION_SCOPE) ?? null;
      if (!scope) return;
      scope.setAttribute("data-selecting-in", "");
      root.setAttribute("data-selecting", "");
    };
    const key = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "a" || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.defaultPrevented) return;
      if (isField(document.activeElement)) return;
      const open = [...document.querySelectorAll(SELECTION_SCOPE)].filter((element) => !element.matches("[data-select-all]"));
      const target = (last?.isConnected ? last.closest(SELECTION_SCOPE) : null) ?? open.at(-1);
      if (!target) return;
      event.preventDefault();
      window.getSelection()?.selectAllChildren(target);
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("pointerup", end, true);
    document.addEventListener("pointercancel", end, true);
    document.addEventListener("keydown", key);
    return () => {
      end();
      document.removeEventListener("pointerdown", down, true);
      document.removeEventListener("pointerup", end, true);
      document.removeEventListener("pointercancel", end, true);
      document.removeEventListener("keydown", key);
    };
  }, []);
  return null;
}

// In the apps, a link to another site goes straight to the app's "open outside" (a Custom Tab,
// Safari's view, the system browser): a new window from a web view is the app's to catch, and an
// Android WebView doesn't always report one.
function OutsideLinks() {
  useEffect(() => {
    const bridge = shellBridge();
    if (typeof bridge?.openExternal !== "function") return;
    const open = bridge.openExternal.bind(bridge);
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement)) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin === window.location.origin || !["http:", "https:", "mailto:"].includes(url.protocol)) return;
      event.preventDefault();
      void open(url.toString());
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
  return null;
}

// The desktop app saves a download straight to the Downloads folder, so this is how the person hears it went.
function DesktopDownloads() {
  useEffect(() => {
    const onDownload = (event: Event) => {
      const { ok, id, name, folder } = (event as CustomEvent<DesktopDownload>).detail;
      if (!ok) {
        toast.add({ type: "error", title: name ? `Couldn't download ${name}.` : "Couldn't download that file." });
        return;
      }
      const show = desktopShell()?.showDownload;
      toast.add({
        type: "success",
        title: `Saved to ${folder ?? "Downloads"}`,
        description: name ?? undefined,
        actionProps:
          typeof show === "function" && id !== null
            ? { children: "Show in folder", onClick: () => void show(id).catch(failed("Couldn't open the folder.")) }
            : undefined,
      });
    };
    window.addEventListener("gond:download", onDownload);
    return () => window.removeEventListener("gond:download", onDownload);
  }, []);
  return null;
}

// A file dropped where nothing takes it would replace the page with the file, in a browser and in the apps.
function StrayDrops() {
  useEffect(() => {
    const refuse = (event: DragEvent) => {
      if (event.defaultPrevented || !event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      if (event.type === "dragover") event.dataTransfer.dropEffect = "none";
    };
    window.addEventListener("dragover", refuse);
    window.addEventListener("drop", refuse);
    return () => {
      window.removeEventListener("dragover", refuse);
      window.removeEventListener("drop", refuse);
    };
  }, []);
  return null;
}

function ShellDialogBridge({ open }: { open: (dialog: ShellDialog) => void }) {
  useEffect(() => {
    const onOpen = (event: Event) => open((event as CustomEvent<NonNullable<ShellDialog>>).detail);
    window.addEventListener(OPEN_DIALOG_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_DIALOG_EVENT, onOpen);
  }, [open]);
  return null;
}
