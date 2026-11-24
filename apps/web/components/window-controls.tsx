"use client";

import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { failed } from "@/components/failed";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { desktopWindow, useNativeShell, type DesktopWindow } from "@/lib/shell";

/**
 * The desktop app's title bar, which the page draws since its window has no frame: the window's
 * buttons as one pill in the top-right corner, and a strip across the top that moves the window
 * (data-window-drag, held by the app's init.js). On a wide window the strip is the top row the panes
 * leave free; under wide it is the room above the page (`--shell-inset-top`), a phone's status bar.
 */
export function WindowControls() {
  const shell = useNativeShell();
  const controls = useMemo(() => (shell === "desktop" ? desktopWindow() : null), [shell]);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let live = true;
    void controls.isMaximized().then(
      (now) => live && setMaximized(now),
      () => {},
    );
    const onWindow = (event: Event) => setMaximized(Boolean((event as CustomEvent<{ maximized?: boolean }>).detail?.maximized));
    window.addEventListener("gond:window", onWindow);
    return () => {
      live = false;
      window.removeEventListener("gond:window", onWindow);
    };
  }, [controls]);

  if (!controls) return null;
  return (
    <>
      <div data-window-drag="" aria-hidden="true" className="fixed inset-x-0 top-0 z-[5] h-(--safe-top) bg-background wide:h-16 wide:bg-transparent" />
      <div role="group" aria-label="Window" className="fixed top-1 right-2 z-[95] flex h-10 items-center rounded-full border border-primary-edge bg-primary p-0.5 wide:top-2.5 wide:h-11">
        <WindowButton label="Minimize" run={controls.minimize} onDone={setMaximized}>
          <Minus className="size-4" strokeWidth={1.5} aria-hidden="true" />
        </WindowButton>
        <WindowButton label={maximized ? "Restore" : "Maximize"} run={controls.toggleMaximize} onDone={setMaximized}>
          {maximized ? <Copy className="size-3.5 -scale-x-100" strokeWidth={1.5} aria-hidden="true" /> : <Square className="size-3.5" strokeWidth={1.5} aria-hidden="true" />}
        </WindowButton>
        <WindowButton label="Close" run={controls.closeWindow} onDone={setMaximized} closes>
          <X className="size-4" strokeWidth={1.5} aria-hidden="true" />
        </WindowButton>
      </div>
    </>
  );
}

function WindowButton({ label, run, onDone, closes, children }: { label: string; run: DesktopWindow["minimize"]; onDone: (maximized: boolean) => void; closes?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-lg"
            aria-label={label}
            onClick={() => void run().then(onDone, failed(`Couldn't ${label.toLowerCase()} the window`))}
            className={closes ? "h-full w-10 hover:bg-window-close hover:text-white" : "h-full w-10"}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
