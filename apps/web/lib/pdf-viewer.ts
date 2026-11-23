export const PDF_MIN_ZOOM = 1;
export const PDF_MAX_ZOOM = 2.5;
export const PDF_ZOOM_STEP = 0.5;
export const PDF_MAX_FIT_WIDTH = 896;

const MAX_DPR = 2;
const IOS_SAFE_CANVAS_PIXELS = 8_000_000;

export type PdfRenderMetrics = {
  cssScale: number;
  cssWidth: number;
  cssHeight: number;
  outputScale: number;
  pixelWidth: number;
  pixelHeight: number;
};

export function isPdfAttachment(file: { name: string; mediaType: string; removed?: boolean }): boolean {
  if (file.removed) return false;
  const type = file.mediaType.toLowerCase().split(";")[0]!.trim();
  if (type === "application/pdf") return true;
  return (!type || type === "application/octet-stream") && /\.pdf$/i.test(file.name);
}

export function clampPdfZoom(zoom: number): number {
  const clamped = Math.min(PDF_MAX_ZOOM, Math.max(PDF_MIN_ZOOM, zoom));
  return Math.round(clamped * 100) / 100;
}

export function pdfRenderMetrics(
  pageWidth: number,
  pageHeight: number,
  fitWidth: number,
  dpr = 1,
  zoom = 1,
): PdfRenderMetrics {
  const safePageW = Math.max(1, pageWidth);
  const safePageH = Math.max(1, pageHeight);
  const safeFitW = Math.max(1, fitWidth);
  const safeZoom = clampPdfZoom(zoom);
  const cssScale = (safeFitW / safePageW) * safeZoom;
  const cssWidth = Math.max(1, Math.round(safePageW * cssScale));
  const cssHeight = Math.max(1, Math.round(safePageH * cssScale));
  const targetDpr = Math.min(Math.max(Number.isFinite(dpr) ? dpr : 1, 1), MAX_DPR);
  const rawPixels = cssWidth * cssHeight * targetDpr * targetDpr;
  const outputScale = rawPixels > IOS_SAFE_CANVAS_PIXELS ? Math.sqrt(IOS_SAFE_CANVAS_PIXELS / (cssWidth * cssHeight)) : targetDpr;
  const pixelWidth = Math.max(1, Math.floor(cssWidth * outputScale));
  const pixelHeight = Math.max(1, Math.floor(cssHeight * outputScale));
  return { cssScale, cssWidth, cssHeight, outputScale, pixelWidth, pixelHeight };
}

export function activePageIndex(
  pages: readonly { top: number; height: number }[],
  scrollTop: number,
  viewportHeight: number,
): number {
  if (pages.length === 0) return 1;
  const focus = scrollTop + viewportHeight * 0.35;
  let current = 1;
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i]!;
    if (page.top <= focus) current = i + 1;
    else break;
  }
  return Math.min(pages.length, Math.max(1, current));
}
