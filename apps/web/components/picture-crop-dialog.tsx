"use client";

import { ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode, type WheelEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { AVATAR_MAX_BYTES, AVATAR_SIZE, clampCrop, cropToBlob, coverScale, type Crop } from "@/lib/avatar";

const STAGE = 256;
const MAX_ZOOM = 4;

/** Places a picture in a circle: drag to move it, the slider or the wheel to zoom. Answers a square PNG; the circle is drawn wherever it's shown. */
export function PictureCropDialog({ file, title, onCancel, onDone }: { file: File; title: string; onCancel: () => void; onDone: (blob: Blob) => Promise<void> | void }) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>({ zoom: 1, x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; from: Crop } | null>(null);

  useEffect(() => {
    let alive = true;
    const objectUrl = URL.createObjectURL(file);
    createImageBitmap(file)
      .then((loaded) => {
        if (!alive) return loaded.close();
        setBitmap(loaded);
        setUrl(objectUrl);
        setCrop(clampCrop({ zoom: 1, x: Number.NaN, y: Number.NaN }, loaded, STAGE));
      })
      .catch(() => alive && setError("That file isn't a picture we can read."));
    return () => {
      alive = false;
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  useEffect(() => () => bitmap?.close(), [bitmap]);

  const scale = bitmap ? coverScale(bitmap, STAGE) * crop.zoom : 1;

  function zoomTo(zoom: number) {
    if (!bitmap) return;
    setCrop((current) => {
      const before = coverScale(bitmap, STAGE) * current.zoom;
      const after = coverScale(bitmap, STAGE) * zoom;
      // Keep the middle of the circle on the same spot of the picture.
      const cx = (STAGE / 2 - current.x) / before;
      const cy = (STAGE / 2 - current.y) / before;
      return clampCrop({ zoom, x: STAGE / 2 - cx * after, y: STAGE / 2 - cy * after }, bitmap, STAGE);
    });
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!bitmap) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, from: crop };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!start || start.id !== event.pointerId || !bitmap) return;
    setCrop(clampCrop({ ...start.from, x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y }, bitmap, STAGE));
  }

  function onWheel(event: WheelEvent<HTMLDivElement>) {
    zoomTo(Math.min(MAX_ZOOM, Math.max(1, crop.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08))));
  }

  async function save() {
    if (!bitmap || busy) return;
    setBusy(true);
    try {
      await onDone(await cropToBlob(bitmap, crop, STAGE, AVATAR_SIZE));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not prepare the picture.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Drag to move it, and zoom until it fits the circle.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-4">
          <div
            className="relative cursor-grab touch-none overflow-hidden rounded-2xl bg-muted select-none active:cursor-grabbing"
            style={{ width: STAGE, height: STAGE }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
            onWheel={onWheel}
          >
            {url && bitmap ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local object URL, positioned by hand
              <img src={url} alt="" draggable={false} className="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left" style={{ width: bitmap.width * scale, height: bitmap.height * scale, transform: `translate(${crop.x}px, ${crop.y}px)` }} />
            ) : (
              <div className="flex size-full items-center justify-center text-sm text-muted-foreground">{error ?? <Spinner />}</div>
            )}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_200px_color-mix(in_oklch,var(--background)_70%,transparent)] ring-2 ring-primary-edge" />
          </div>
          <div className="flex w-full items-center gap-3">
            <ZoomOut className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <Slider aria-label="Zoom" min={1} max={MAX_ZOOM} step={0.01} value={[crop.zoom]} onValueChange={(value) => zoomTo(Array.isArray(value) ? value[0]! : value)} disabled={!bitmap} />
            <ZoomIn className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </div>
          {error && bitmap ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!bitmap || busy}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            {busy ? "Saving…" : "Use this picture"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A file picker that hands a picture to the cropper, then to `save`. A GIF goes
 * as it is, so it keeps moving; the circle is drawn wherever it's shown.
 */
export function usePicturePicker(title: string, save: (picture: Blob) => Promise<void>): { choose: () => void; busy: boolean; elements: ReactNode } {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveGif(gif: File) {
    setBusy(true);
    try {
      if (gif.size > AVATAR_MAX_BYTES) throw new Error("The picture must be under 2 MB.");
      await save(gif);
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not save the picture." });
    } finally {
      setBusy(false);
    }
  }

  function picked(chosen: File | null) {
    if (input.current) input.current.value = "";
    if (!chosen) return;
    if (chosen.type === "image/gif") void saveGif(chosen);
    else setFile(chosen);
  }

  const elements = (
    <>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" tabIndex={-1} aria-hidden="true" onChange={(event) => picked(event.target.files?.[0] ?? null)} />
      {file ? (
        <PictureCropDialog
          file={file}
          title={title}
          onCancel={() => setFile(null)}
          onDone={async (blob) => {
            setBusy(true);
            try {
              await save(blob);
              setFile(null);
            } finally {
              setBusy(false);
            }
          }}
        />
      ) : null}
    </>
  );
  return { choose: () => input.current?.click(), busy, elements };
}
