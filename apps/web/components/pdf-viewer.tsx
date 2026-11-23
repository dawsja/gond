"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Download, Loader2, Minus, Plus, X } from "lucide-react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  activePageIndex,
  clampPdfZoom,
  PDF_MAX_FIT_WIDTH,
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  PDF_ZOOM_STEP,
  pdfRenderMetrics,
} from "@/lib/pdf-viewer";

export type ViewerPdf = { id: string; name: string };

type PdfJsModule = typeof import("pdfjs-dist");

let pdfJsPromise: Promise<PdfJsModule> | null = null;

function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfJsPromise) {
    pdfJsPromise = import("pdfjs-dist").then((pdfjs) => {
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      }
      return pdfjs;
    });
  }
  return pdfJsPromise;
}

export function PdfViewer({ file, onClose }: { file: ViewerPdf | null; onClose: () => void }) {
  return (
    <DialogPrimitive.Root
      open={Boolean(file)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 isolate z-50 bg-black/90 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Popup
          data-slot="pdf-viewer"
          data-no-swipe-back=""
          aria-label={file?.name ?? "PDF"}
          className="fixed inset-0 z-50 outline-none duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0"
        >
          {file ? <PdfViewerBody key={file.id} file={file} onClose={onClose} /> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function PdfViewerBody({ file, onClose }: { file: ViewerPdf; onClose: () => void }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [defaultAspect, setDefaultAspect] = useState(8.5 / 11);
  const [currentPage, setCurrentPage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(0);

  const changeZoom = useCallback((delta: number) => {
    setZoom((value) => clampPdfZoom(value + delta));
  }, []);

  useEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const measure = () => {
      const styles = getComputedStyle(node);
      const horizontalPad = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
      const inner = Math.max(240, node.clientWidth - horizontalPad);
      setFitWidth(Math.min(inner, PDF_MAX_FIT_WIDTH));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let loadingTask: ReturnType<PdfJsModule["getDocument"]> | null = null;

    void (async () => {
      try {
        const [pdfjs, response] = await Promise.all([
          loadPdfJs(),
          fetch(`/api/attachments/${file.id}`, { credentials: "same-origin", signal: controller.signal }),
        ]);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (cancelled) return;
        loadingTask = pdfjs.getDocument({ data: bytes, useSystemFonts: true });
        const doc = await loadingTask.promise;
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        let aspect = 8.5 / 11;
        if (doc.numPages > 0) {
          const first = await doc.getPage(1);
          const vp = first.getViewport({ scale: 1 });
          if (vp.width > 0 && vp.height > 0) aspect = vp.width / vp.height;
          first.cleanup();
        }
        if (cancelled) {
          void loadingTask.destroy();
          return;
        }
        setDefaultAspect(aspect);
        setPageCount(doc.numPages);
        setCurrentPage(1);
        setPdf(doc);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      void loadingTask?.destroy();
    };
  }, [file.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") changeZoom(PDF_ZOOM_STEP);
      else if (event.key === "-") changeZoom(-PDF_ZOOM_STEP);
      else if (event.key === "0") setZoom(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [changeZoom]);

  const updateCurrentPage = useCallback(() => {
    const node = scrollerRef.current;
    if (!node || pageCount === 0) return;
    const boxes = pageRefs.current.slice(0, pageCount).map((el) => ({
      top: el?.offsetTop ?? 0,
      height: el?.offsetHeight ?? 0,
    }));
    setCurrentPage(activePageIndex(boxes, node.scrollTop, node.clientHeight));
  }, [pageCount]);

  return (
    <>
      <DialogPrimitive.Title className="sr-only">{file.name}</DialogPrimitive.Title>
      <div
        ref={scrollerRef}
        onScroll={updateCurrentPage}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
        className="absolute inset-0 overflow-auto overscroll-contain px-3 pt-[calc(var(--safe-top)+72px)] pb-[calc(var(--safe-bottom)+76px)] sm:px-6"
      >
        {failed ? (
          <div
            className="flex min-h-full items-center justify-center"
            onClick={(event) => {
              if (event.target === event.currentTarget) onClose();
            }}
          >
            <p className="rounded-full bg-primary px-4 py-2.5 text-[13.5px] text-foreground">
              Couldn&apos;t load this PDF. Download it to open it.
            </p>
          </div>
        ) : !pdf ? (
          <div
            className="flex min-h-full items-center justify-center"
            onClick={(event) => {
              if (event.target === event.currentTarget) onClose();
            }}
          >
            <div className="flex items-center gap-2 rounded-full border border-primary-edge bg-primary px-4 py-2.5 text-[13.5px] text-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              <span>Loading PDF…</span>
            </div>
          </div>
        ) : (
          <div
            className="mx-auto flex w-fit min-w-full flex-col items-center gap-3"
            onClick={(event) => {
              if (event.target === event.currentTarget) onClose();
            }}
          >
            {Array.from({ length: pageCount }, (_, i) => (
              <PdfPage
                key={i + 1}
                pdf={pdf}
                pageNumber={i + 1}
                fitWidth={fitWidth || 360}
                zoom={zoom}
                defaultAspect={defaultAspect}
                scrollerRef={scrollerRef}
                onRef={(el) => {
                  pageRefs.current[i] = el;
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center gap-2 px-4 pt-[calc(var(--safe-top)+12px)] wide:desktop:pr-(--window-controls-space)">
        <p className="pointer-events-auto flex h-11 min-w-0 items-center gap-2 rounded-full border border-primary-edge bg-primary px-4 text-[13.5px] text-foreground">
          <span className="truncate font-medium">{file.name}</span>
          {pageCount > 0 ? (
            <span className="shrink-0 text-muted-foreground tabular-nums">
              {currentPage} of {pageCount}
            </span>
          ) : null}
        </p>
        <div className="ml-auto flex shrink-0 gap-2">
          <Button
            size="icon-lg"
            className="pointer-events-auto pointer-coarse:size-11"
            aria-label={`Download ${file.name}`}
            render={<a href={`/api/attachments/${file.id}?download`} download={file.name} />}
            nativeButton={false}
          >
            <Download />
          </Button>
          <DialogPrimitive.Close
            render={<Button size="icon-lg" className="pointer-events-auto pointer-coarse:size-11" aria-label="Close" />}
          >
            <X />
          </DialogPrimitive.Close>
        </div>
      </div>

      {pdf && pageCount > 0 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center px-4 pb-[calc(var(--safe-bottom)+14px)]">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-primary-edge bg-primary p-1 text-foreground">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Zoom out"
              disabled={zoom <= PDF_MIN_ZOOM}
              onClick={() => changeZoom(-PDF_ZOOM_STEP)}
            >
              <Minus />
            </Button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              aria-label="Reset zoom"
              className="min-w-12 px-1.5 text-center text-[12.5px] font-medium tabular-nums"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Zoom in"
              disabled={zoom >= PDF_MAX_ZOOM}
              onClick={() => changeZoom(PDF_ZOOM_STEP)}
            >
              <Plus />
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function releaseCanvasBitmap(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function PdfPage({
  pdf,
  pageNumber,
  fitWidth,
  zoom,
  defaultAspect,
  scrollerRef,
  onRef,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  fitWidth: number;
  zoom: number;
  defaultAspect: number;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
  onRef: (el: HTMLDivElement | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(pageNumber <= 2);
  const [aspect, setAspect] = useState(defaultAspect);

  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      containerRef.current = el;
      onRef(el);
    },
    [onRef],
  );

  useEffect(() => {
    const node = containerRef.current;
    const root = scrollerRef.current;
    if (!node || !root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry) setVisible(entry.isIntersecting);
      },
      { root, rootMargin: "800px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollerRef]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible) {
      releaseCanvasBitmap(canvas);
      return;
    }

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let page: PDFPageProxy | null = null;

    void (async () => {
      try {
        page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        if (base.width > 0 && base.height > 0) setAspect(base.width / base.height);
        const metrics = pdfRenderMetrics(base.width, base.height, fitWidth, window.devicePixelRatio || 1, zoom);
        const target = canvasRef.current;
        if (!target || cancelled) return;
        target.width = metrics.pixelWidth;
        target.height = metrics.pixelHeight;
        target.style.width = `${metrics.cssWidth}px`;
        target.style.height = `${metrics.cssHeight}px`;
        const viewport = page.getViewport({ scale: metrics.cssScale });
        renderTask = page.render({
          canvas: target,
          viewport,
          transform: metrics.outputScale !== 1 ? [metrics.outputScale, 0, 0, metrics.outputScale, 0, 0] : undefined,
        });
        await renderTask.promise;
      } catch {
        return;
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
      releaseCanvasBitmap(canvas);
      page?.cleanup();
    };
  }, [pdf, pageNumber, fitWidth, zoom, visible]);

  const width = Math.max(1, Math.round(fitWidth * zoom));
  const height = Math.max(1, Math.round(width / aspect));

  return (
    <div
      ref={setRef}
      style={{ width, height }}
      className="relative shrink-0 overflow-hidden rounded-xl bg-white shadow-lg"
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
