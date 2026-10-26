import { describe, expect, test } from "bun:test";
import { fileKind } from "../lib/file-kind";

const file = (name: string, mediaType = "application/octet-stream") => ({ name, mediaType });

describe("fileKind", () => {
  test("reads the type first", () => {
    expect(fileKind(file("a", "text/csv"))).toBe("spreadsheet");
    expect(fileKind(file("a", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))).toBe("spreadsheet");
    expect(fileKind(file("a", "application/pdf"))).toBe("document");
    expect(fileKind(file("a", "audio/mp4"))).toBe("audio");
    expect(fileKind(file("a", "video/quicktime"))).toBe("video");
    expect(fileKind(file("a", "application/zip"))).toBe("archive");
    expect(fileKind(file("a", "text/plain; charset=utf-8"))).toBe("document");
  });

  test("falls back to the extension when the type says nothing", () => {
    expect(fileKind(file("Invoices October.xlsx"))).toBe("spreadsheet");
    expect(fileKind(file("Contract draft.DOCX"))).toBe("document");
    expect(fileKind(file("Standup.m4a"))).toBe("audio");
    expect(fileKind(file("clip.mov"))).toBe("video");
    expect(fileKind(file("backup.tar.gz"))).toBe("archive");
    expect(fileKind(file("photos.7z"))).toBe("archive");
  });

  test("anything else is a plain file", () => {
    expect(fileKind(file("setup.exe"))).toBe("other");
    expect(fileKind(file("no extension"))).toBe("other");
  });
});
