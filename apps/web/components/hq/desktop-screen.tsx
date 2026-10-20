"use client";

import { DESKTOP_CONTROL_LABELS, type DesktopControl } from "@gond/shared";
import {
  ArrowDownUp,
  ChevronLeft,
  CircleQuestionMark,
  ClipboardList,
  Copy,
  Crosshair,
  Ellipsis,
  Hand,
  Keyboard,
  Monitor,
  MonitorOff,
  MousePointer2,
  MousePointerClick,
  RotateCw,
  Touchpad,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useRef, useState, type ReactNode, type RefObject } from "react";

import { DesktopFrame, DesktopToolbar, DesktopView, INITIAL_REPORT, type DesktopReport, type DesktopViewHandle } from "@/components/hq/box-desktop";
import { useStore } from "@/components/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";

type HelpRow = { icon: LucideIcon; title: string; text: string };

const HELP: { heading: string; rows: HelpRow[] }[] = [
  {
    heading: "Moving around",
    rows: [
      { icon: ArrowDownUp, title: "Scroll", text: "Drag with two fingers." },
      { icon: MousePointer2, title: "Click and drag", text: "Tap to click where you tapped. Tap twice to double-click. One finger drags." },
      { icon: MousePointerClick, title: "Right-click", text: "Tap with two fingers, or press and hold." },
      { icon: ZoomIn, title: "Zoom in", text: "Pinch to zoom. Zoomed in, two fingers move around instead of scrolling." },
    ],
  },
  {
    heading: "Typing and the clipboard",
    rows: [
      { icon: Keyboard, title: "Type", text: "Tap the keyboard button at the bottom." },
      { icon: ClipboardList, title: "Copy and paste", text: "Tap the clipboard button at the bottom for Copy to phone and Paste from phone." },
    ],
  },
  {
    heading: "When a pointer is easier",
    rows: [{ icon: Touchpad, title: "Trackpad mode", text: "Turn it on from the ⋯ menu. Your finger moves the pointer: tap to click there, tap and then drag to drag. Recenter the pointer from the same menu if it drifts." }],
  },
  {
    heading: "Taking turns",
    rows: [
      { icon: Hand, title: "Take control", text: "While a bot is using the screen you can only watch. Take control and it waits for you." },
      { icon: Undo2, title: "I'm done", text: "Tap I'm done when you're finished, so the bot can carry on. Going back does the same." },
    ],
  },
];

/** A page of its own over the screen, like a settings page: it scrolls, and only the close button floats. */
function HelpPage({ onClose }: { onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="desktop-help-title" className="absolute inset-0 z-20 bg-background">
      <Button size="icon-xl" aria-label="Close" onClick={onClose} className="absolute top-[calc(10px+var(--safe-top))] left-3 z-10">
        <X aria-hidden="true" />
      </Button>
      <div className="h-full overflow-y-auto overscroll-contain px-4 pt-[calc(10px+var(--safe-top))] pb-[calc(24px+var(--safe-bottom))]">
        <div className="mx-auto flex max-w-lg flex-col gap-6">
          <h2 id="desktop-help-title" className="flex h-11 items-center pl-14 text-[19px] font-semibold">
            Using the computer
          </h2>
          {HELP.map((section) => (
            <section key={section.heading} className="flex flex-col gap-2">
              <h3 className="px-4 text-[14px] text-muted-foreground">{section.heading}</h3>
              <ul className="overflow-hidden rounded-3xl bg-card">
                {section.rows.map(({ icon: Icon, title, text }) => (
                  <li key={title} className="flex gap-4 pl-4 [&:not(:first-child)>div]:border-t">
                    <Icon className="mt-4 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-3.5 pr-4">
                      <span className="text-[16px] font-medium">{title}</span>
                      <span className="text-[14px] text-muted-foreground">{text}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function PasteDialog({ open, onOpenChange, container, onType }: { open: boolean; onOpenChange: (open: boolean) => void; container: RefObject<HTMLDivElement | null>; onType: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setText("");
        onOpenChange(next);
      }}
    >
      <DialogContent container={container}>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            onType(text);
            setText("");
            onOpenChange(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>Paste from phone</DialogTitle>
            <DialogDescription>Paste here and it&apos;s typed where the cursor is on the computer, and put on its clipboard too.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="desktop-paste">Text</FieldLabel>
              <Textarea id="desktop-paste" value={text} onChange={(event) => setText(event.target.value)} rows={4} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={!text}>
              Type it
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function statusLine(report: DesktopReport, control: DesktopControl, driver: string) {
  if (report.status === "starting") return "Starting the desktop";
  if (report.status === "connecting") return "Connecting";
  if (report.status === "ended") return "Disconnected";
  if (report.status === "error") return "Couldn't connect";
  return control === "bots" ? `${driver} is using it` : DESKTOP_CONTROL_LABELS[control];
}

/** The phone's controls, floating over the screen like a conversation's: nothing but the pills covers it. */
function PhoneControls({
  title,
  icon,
  driver,
  frame,
  view,
  report,
  control,
  onControlChange,
  keyboardOpen,
  trackpad,
  onTrackpad,
  onHelp,
  onPaste,
  onStop,
  onClose,
}: {
  title: string;
  icon: ReactNode;
  driver: string;
  frame: RefObject<HTMLDivElement | null>;
  view: RefObject<DesktopViewHandle | null>;
  report: DesktopReport;
  control: DesktopControl;
  onControlChange: (holder: "person" | "free") => void;
  keyboardOpen: boolean;
  trackpad: boolean;
  onTrackpad: (on: boolean) => void;
  onHelp: () => void;
  onPaste: () => void;
  onStop?: () => void;
  onClose: () => void;
}) {
  const live = report.status === "live";
  const canType = live && control !== "bots";
  const zoomed = report.zoom > 1;
  const broken = report.status === "ended" || report.status === "error";

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col wide:hidden">
      <header className="flex h-[calc(64px+var(--safe-top))] shrink-0 items-center gap-2 px-3 pt-[var(--safe-top)]">
        <Button size="icon-xl" aria-label="Back" onClick={onClose} className="pointer-events-auto">
          <ChevronLeft aria-hidden="true" />
        </Button>
        <div className="flex min-w-0 items-center gap-2.5 pl-1">
          {icon}
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[17px] leading-5 font-semibold">{title}</span>
            <span className="truncate text-[11px] leading-3.5 text-muted-foreground">{statusLine(report, control, driver)}</span>
          </span>
        </div>
        <span className="flex-1" />
        <Button size="icon-xl" aria-label="Using the computer" onClick={onHelp} className="pointer-events-auto">
          <CircleQuestionMark aria-hidden="true" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="icon-xl" aria-label="More" className="pointer-events-auto" />}>
            <Ellipsis aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60" container={frame}>
            <DropdownMenuGroup>
              {live ? (
                <DropdownMenuItem onClick={() => onControlChange(control === "person" ? "free" : "person")}>
                  {control === "person" ? <Undo2 aria-hidden="true" /> : <Hand aria-hidden="true" />}
                  {control === "person" ? "I'm done" : "Take control"}
                </DropdownMenuItem>
              ) : null}
              {live ? (
                <DropdownMenuItem onClick={() => view.current?.zoomTo(zoomed ? 1 : 2)}>
                  {zoomed ? <ZoomOut aria-hidden="true" /> : <ZoomIn aria-hidden="true" />}
                  {zoomed ? "Fit the screen" : "Zoom in"}
                </DropdownMenuItem>
              ) : null}
              {broken ? (
                <DropdownMenuItem onClick={() => view.current?.reconnect()}>
                  <RotateCw aria-hidden="true" />
                  Reconnect
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuGroup>
            {canType ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuCheckboxItem checked={trackpad} onCheckedChange={onTrackpad} closeOnClick>
                    <Touchpad aria-hidden="true" />
                    Trackpad mode
                  </DropdownMenuCheckboxItem>
                  {trackpad ? (
                    <DropdownMenuItem onClick={() => view.current?.recenterPointer()}>
                      <Crosshair aria-hidden="true" />
                      Recenter the pointer
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuGroup>
              </>
            ) : null}
            {onStop ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem variant="destructive" onClick={onStop}>
                    <MonitorOff aria-hidden="true" />
                    Stop the desktop
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        {report.status === "starting" || report.status === "connecting" ? <Spinner className="size-6 text-muted-foreground" /> : null}
        {broken ? (
          <>
            <p className="text-[14px] text-muted-foreground">{report.message ?? "The desktop connection ended."}</p>
            <Button variant="outline" onClick={() => view.current?.reconnect()} className="pointer-events-auto">
              Reconnect
            </Button>
          </>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-col items-center gap-3 px-4 pb-[calc(16px+var(--safe-bottom))]">
        {report.notice ? <span className="rounded-full border border-primary-edge bg-primary px-3 py-1.5 text-[12px] text-primary-foreground">{report.notice}</span> : null}
        <div className="flex w-full items-end justify-between gap-3">
          {canType ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button size="icon-xl" aria-label="Clipboard" className="pointer-events-auto" />}>
                <ClipboardList aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-60" container={frame}>
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={() => view.current?.copyToPhone()}>
                    <Copy aria-hidden="true" />
                    Copy to phone
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      void view.current?.pasteFromPhone().then((pasted) => {
                        if (!pasted) onPaste();
                      })
                    }
                  >
                    <ClipboardList aria-hidden="true" />
                    Paste from phone
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="size-11" />
          )}
          {live && control !== "free" ? (
            <Button size="lg" onClick={() => onControlChange(control === "person" ? "free" : "person")} className="pointer-events-auto">
              {control === "person" ? <Undo2 data-icon="inline-start" aria-hidden="true" /> : <Hand data-icon="inline-start" aria-hidden="true" />}
              {control === "person" ? "I'm done" : "Take control"}
            </Button>
          ) : null}
          {canType ? (
            <Button
              size="icon-xl"
              aria-label={keyboardOpen ? "Hide the keyboard" : "Keyboard"}
              aria-pressed={keyboardOpen}
              // Keep the field focused: a tap here would otherwise close the keyboard before it reopens.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => (keyboardOpen ? view.current?.closeKeyboard() : view.current?.openKeyboard())}
              className="pointer-events-auto"
            >
              <Keyboard aria-hidden="true" />
            </Button>
          ) : (
            <span className="size-11" />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The live screen at its full size: a window with a toolbar on a wide
 * screen, and on a phone the desktop on the page with floating pills, the
 * clipboard and the keyboard in the corners, and a pinch to zoom.
 */
export function DesktopScreen({
  title,
  wideTitle,
  icon,
  driver,
  control: reported,
  onControlChange,
  onClose,
  closeLabel,
  backdropLabel,
  onStop,
}: {
  title: string;
  wideTitle: string;
  icon: ReactNode;
  driver: string;
  control: DesktopControl;
  onControlChange: (holder: "person" | "free") => void;
  onClose: () => void;
  closeLabel: string;
  backdropLabel: string;
  onStop?: () => void;
}) {
  const { desktop } = useStore();
  // A bot that is driving holds the screen from its first batch, before the box's own lock arrives.
  const control: DesktopControl = reported === "free" && desktop?.drivers.length ? "bots" : reported;
  const frame = useRef<HTMLDivElement>(null);
  const view = useRef<DesktopViewHandle>(null);
  const [report, setReport] = useState<DesktopReport>(INITIAL_REPORT);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [trackpad, setTrackpad] = useState(false);
  const [help, setHelp] = useState(false);
  const [paste, setPaste] = useState(false);
  const typeText = useCallback((text: string) => view.current?.typeText(text), []);

  // Leaving hands the screen back, so a bot waiting on it carries on.
  const close = () => {
    if (control === "person") onControlChange("free");
    onClose();
  };

  return (
    <DesktopFrame
      frame={frame}
      onBackdrop={close}
      backdropLabel={backdropLabel}
      bar={<DesktopToolbar title={wideTitle} icon={icon} driver={driver} frame={frame} report={report} control={control} onControlChange={onControlChange} view={view} onHelp={() => setHelp(true)} onStop={onStop} onClose={close} closeLabel={closeLabel} className="hidden wide:flex" />}
    >
      <DesktopView ref={view} viewOnly={control === "bots"} trackpad={trackpad} quality="full" onStatus={setReport} onKeyboard={setKeyboardOpen} />
      <PhoneControls
        title={title}
        icon={icon}
        driver={driver}
        frame={frame}
        view={view}
        report={report}
        control={control}
        onControlChange={onControlChange}
        keyboardOpen={keyboardOpen}
        trackpad={trackpad}
        onTrackpad={setTrackpad}
        onHelp={() => setHelp(true)}
        onPaste={() => setPaste(true)}
        onStop={onStop}
        onClose={close}
      />
      {help ? <HelpPage onClose={() => setHelp(false)} /> : null}
      <PasteDialog open={paste} onOpenChange={setPaste} container={frame} onType={typeText} />
    </DesktopFrame>
  );
}

export function BoxDesktop({ onClose, control, onControlChange }: { onClose: () => void; control: DesktopControl; onControlChange: (holder: "person" | "free") => void }) {
  const stopDesktop = useCallback(async () => {
    await fetch("/api/box/desktop", { method: "DELETE" }).catch(() => undefined);
    onClose();
  }, [onClose]);

  return (
    <DesktopScreen
      title="Computer"
      wideTitle="Box · Desktop"
      icon={<Monitor className="size-6" aria-hidden="true" />}
      driver="A bot"
      control={control}
      onControlChange={onControlChange}
      onClose={onClose}
      closeLabel="Hide (the desktop keeps running)"
      backdropLabel="Hide desktop"
      onStop={() => void stopDesktop()}
    />
  );
}
