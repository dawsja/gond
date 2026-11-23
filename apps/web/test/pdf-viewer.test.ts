import { describe, expect, test } from "bun:test";
import { activePageIndex, clampPdfZoom, isPdfAttachment, pdfRenderMetrics, PDF_MAX_ZOOM, PDF_MIN_ZOOM } from "../lib/pdf-viewer";

describe("isPdfAttachment", () => {
  test("matches application/pdf regardless of casing or parameters", () => {
    expect(isPdfAttachment({ name: "report.pdf", mediaType: "application/pdf" })).toBe(true);
    expect(isPdfAttachment({ name: "unnamed", mediaType: "APPLICATION/PDF; charset=binary" })).toBe(true);
  });

  test("falls back to .pdf extension only for generic media types", () => {
    expect(isPdfAttachment({ name: "Invoice.PDF", mediaType: "application/octet-stream" })).toBe(true);
    expect(isPdfAttachment({ name: "draft.pdf", mediaType: "" })).toBe(true);
    expect(isPdfAttachment({ name: "fake.pdf", mediaType: "text/html" })).toBe(false);
  });

  test("rejects removed attachments and non-PDFs", () => {
    expect(isPdfAttachment({ name: "report.pdf", mediaType: "application/pdf", removed: true })).toBe(false);
    expect(isPdfAttachment({ name: "photo.jpg", mediaType: "image/jpeg" })).toBe(false);
    expect(isPdfAttachment({ name: "notes.txt", mediaType: "text/plain" })).toBe(false);
  });
});

describe("clampPdfZoom", () => {
  test("clamps zoom within supported bounds", () => {
    expect(clampPdfZoom(0.25)).toBe(PDF_MIN_ZOOM);
    expect(clampPdfZoom(1.5)).toBe(1.5);
    expect(clampPdfZoom(10)).toBe(PDF_MAX_ZOOM);
  });
});

describe("pdfRenderMetrics", () => {
  test("fits page to container width and scales cleanly for retina screens", () => {
    const m = pdfRenderMetrics(612, 792, 360, 3, 1);
    expect(m.cssWidth).toBe(360);
    expect(m.cssHeight).toBe(466);
    expect(m.outputScale).toBe(2);
    expect(m.pixelWidth).toBe(720);
    expect(m.pixelHeight).toBe(932);
  });

  test("caps total canvas pixels to stay safely under iOS Safari limits when zoomed", () => {
    const m = pdfRenderMetrics(612, 792, 896, 3, 2.5);
    expect(m.cssWidth).toBe(2240);
    expect(m.pixelWidth * m.pixelHeight).toBeLessThanOrEqual(8_000_000);
  });
});

describe("activePageIndex", () => {
  const pages = [
    { top: 0, height: 500 },
    { top: 512, height: 500 },
    { top: 1024, height: 500 },
  ];

  test("tracks the page crossing the viewport focus line", () => {
    expect(activePageIndex(pages, 0, 700)).toBe(1);
    expect(activePageIndex(pages, 350, 700)).toBe(2);
    expect(activePageIndex(pages, 900, 700)).toBe(3);
  });

  test("returns 1 when no pages are measured yet", () => {
    expect(activePageIndex([], 0, 700)).toBe(1);
  });
});
