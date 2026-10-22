"use client";

import { useEffect, useState, type ReactNode } from "react";
import { BotDialog } from "@/components/bot-dialog";
import { ComputerPanel } from "@/components/computer-panel";
import { ShellNotifications } from "@/components/shell-notifications";
import { RoomDialog } from "@/components/room-dialog";
import { AppSidebar } from "@/components/sidebar";
import { ViewingReport } from "@/components/viewing-report";
import { StoreProvider } from "@/components/store";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import type { SessionUser } from "@/lib/session";

export type ShellDialog = { kind: "new-bot" } | { kind: "edit-bot"; botId: string } | { kind: "new-room" } | { kind: "edit-room"; threadId: string } | { kind: "computer"; botId?: string | null } | null;

export function Shell({ user, children }: { user: SessionUser; children: ReactNode }) {
  const [dialog, setDialog] = useState<ShellDialog>(null);
  return (
    <StoreProvider user={user}>
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
          onClose={() => setDialog(null)}
        />
      ) : null}
      <ShellDialogBridge open={setDialog} />
      <ShellNotifications />
      <ViewingReport />
      <StrayDrops />
    </StoreProvider>
  );
}

export const OPEN_DIALOG_EVENT = "gond:open-dialog";

export function openShellDialog(dialog: NonNullable<ShellDialog>) {
  window.dispatchEvent(new CustomEvent(OPEN_DIALOG_EVENT, { detail: dialog }));
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
