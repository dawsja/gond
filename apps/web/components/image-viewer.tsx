"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { useStableCallback } from "@/hooks/use-stable-callback";
import { askNative, useNativeUi } from "@/lib/native-ui";
import { cn } from "@/lib/utils";

type ViewerImage = { id: string; name: string };

const ZOOM = 2.5;
const SWIPE_PX = 60;

/**
 * Pictures in a conversation, one at a time over the dimmed page: the picture is the object, with
 * the pills floating over it like a conversation's. A tap zooms in where it lands and dragging
 * moves around; a swipe or the arrows go to the next one.
 */
type ViewerProps = { images: ViewerImage[]; openId: string | null; onOpenId: (id: string | null) => void };

export function ImageViewer(props: ViewerProps) {
  return useNativeUi() ? <NativeViewer {...props} /> : <PageViewer {...props} />;
}

/** The iPhone app's Quick Look: its own zoom, swipes, Share and Save to Photos, in Liquid Glass. */
function NativeViewer({ images, openId, onOpenId }: ViewerProps) {
  const shown = useRef<string | null>(null);
  const close = useStableCallback(onOpenId);
  useEffect(() => {
    if (!openId) {
      shown.current = null;
      return;
    }
    if (shown.current) return;
    shown.current = openId;
    const index = Math.max(0, images.findIndex((image) => image.id === openId));
    void askNative({ kind: "pictures", items: images.map((image) => ({ url: `/api/attachments/${image.id}`, name: image.name })), index }).then(() => close(null));
  }, [openId, images, close]);
  return null;
}

function PageViewer({ images, openId, onOpenId }: ViewerProps) {
  const index = images.findIndex((image) => image.id === openId);
  const image = index >= 0 ? images[index]! : null;
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);
  const [broken, setBroken] = useState<string | null>(null);
  const press = useRef<{ x: number; y: number; moved: boolean; origin: { x: number; y: number } | null } | null>(null);

  const go = (step: number) => {
    const next = images[index + step];
    if (!next) return;
    setZoom(null);
    onOpenId(next.id);
  };

  useEffect(() => {
    if (!image) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") go(-1);
      else if (event.key === "ArrowRight") go(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const onPointerDown = (event: PointerEvent<HTMLImageElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = { x: event.clientX, y: event.clientY, moved: false, origin: zoom };
  };
  const onPointerMove = (event: PointerEvent<HTMLImageElement>) => {
    const start = press.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 6) start.moved = true;
    if (start.origin) {
      const box = event.currentTarget.getBoundingClientRect();
      // Dragging moves the picture under the finger, so the zoom's origin goes the other way.
      const shift = (100 * ZOOM) / (ZOOM - 1);
      setZoom({ x: clamp(start.origin.x - (dx / box.width) * shift, 0, 100), y: clamp(start.origin.y - (dy / box.height) * shift, 0, 100) });
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLImageElement>) => {
    const start = press.current;
    press.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    if (!start.origin && start.moved && Math.abs(dx) > SWIPE_PX && Math.abs(dx) > Math.abs(event.clientY - start.y)) {
      go(dx < 0 ? 1 : -1);
      return;
    }
    if (start.moved) return;
    if (zoom) {
      setZoom(null);
      return;
    }
    const box = event.currentTarget.getBoundingClientRect();
    setZoom({ x: ((event.clientX - box.left) / box.width) * 100, y: ((event.clientY - box.top) / box.height) * 100 });
  };

  return (
    <DialogPrimitive.Root
      open={Boolean(image)}
      onOpenChange={(open) => {
        if (!open) {
          setZoom(null);
          onOpenId(null);
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/90 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup data-slot="image-viewer" aria-label={image?.name ?? "Picture"} className="fixed inset-0 z-50 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0">
          {image ? (
            <>
              <DialogPrimitive.Title className="sr-only">{image.name}</DialogPrimitive.Title>
              <div
                className="absolute inset-0 flex items-center justify-center overflow-hidden px-4 pt-[calc(var(--safe-top)+72px)] pb-[calc(var(--safe-bottom)+24px)] wide:px-20"
                onClick={(event) => {
                  // A tap on the dark around the picture closes it, as on a phone's photo viewer.
                  if (event.target !== event.currentTarget) return;
                  setZoom(null);
                  onOpenId(null);
                }}
              >
                {broken === image.id ? <p className="rounded-full bg-primary px-4 py-2.5 text-[13.5px] text-foreground">Couldn&apos;t load this picture. Download it to open it.</p> : null}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  key={image.id}
                  onError={() => setBroken(image.id)}
                  hidden={broken === image.id}
                  src={`/api/attachments/${image.id}`}
                  alt={image.name}
                  draggable={false}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => (press.current = null)}
                  style={zoom ? { transform: `scale(${ZOOM})`, transformOrigin: `${zoom.x}% ${zoom.y}%` } : undefined}
                  className={cn("max-h-full max-w-full touch-none rounded-2xl object-contain select-none", zoom ? "cursor-zoom-out" : "cursor-zoom-in transition-transform duration-150")}
                />
              </div>
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2 px-4 pt-[calc(var(--safe-top)+12px)]">
                <p className="pointer-events-auto flex h-11 min-w-0 items-center gap-2 rounded-full border border-primary-edge bg-primary px-4 text-[13.5px] text-foreground">
                  <span className="truncate font-medium">{image.name}</span>
                  {images.length > 1 ? <span className="shrink-0 text-muted-foreground tabular-nums">{index + 1} of {images.length}</span> : null}
                </p>
                <div className="ml-auto flex shrink-0 gap-2">
                  <Button size="icon-lg" className="pointer-events-auto pointer-coarse:size-11" aria-label={`Download ${image.name}`} render={<a href={`/api/attachments/${image.id}?download`} download={image.name} />} nativeButton={false}>
                    <Download />
                  </Button>
                  <DialogPrimitive.Close render={<Button size="icon-lg" className="pointer-events-auto pointer-coarse:size-11" aria-label="Close" />}>
                    <X />
                  </DialogPrimitive.Close>
                </div>
              </div>
              {index > 0 ? (
                <Button size="icon-lg" className="absolute top-1/2 left-4 -translate-y-1/2 hidden wide:inline-flex" aria-label="Previous picture" onClick={() => go(-1)}>
                  <ChevronLeft />
                </Button>
              ) : null}
              {index < images.length - 1 ? (
                <Button size="icon-lg" className="absolute top-1/2 right-4 -translate-y-1/2 hidden wide:inline-flex" aria-label="Next picture" onClick={() => go(1)}>
                  <ChevronRight />
                </Button>
              ) : null}
            </>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
