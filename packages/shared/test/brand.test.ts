import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { checkBrand, icoFrames, root, sourcePath } from "../../../scripts/brand.ts";

test("the reviewed brand source stays pinned", async () => {
  expect(createHash("sha256").update(await readFile(join(root, sourcePath))).digest("hex")).toBe("bf28a137c9a870c929a6426d2a7c0ef850fe42adf94a92163289c1c12cfe782b");
});

test("all web brand assets match the source", async () => {
  await checkBrand();
});

test("ICO frame dimensions agree with the directory", async () => {
  const frames = icoFrames(await readFile(join(root, "apps/web/app/favicon.ico")));
  expect(await Promise.all(frames.map(async (frame) => {
    const { width, height } = await sharp(frame).metadata();
    return [width, height];
  }))).toEqual([[16, 16], [32, 32], [48, 48], [256, 256]]);
});

test("tracked web and shared source cannot restore the old brand", async () => {
  const files = Bun.spawnSync(["git", "ls-files", "-z", "--", "apps/web", "packages/shared"], { cwd: root }).stdout.toString().split("\0");
  for (const path of files.filter((path) => /\.(tsx?|jsx?|svg|html|css)$/.test(path) && !path.includes("/test/"))) {
    const source = await readFile(join(root, path), "utf8");
    expect(source, path).not.toMatch(/assets\/gond(?:-1024)?\.(?:svg|png)/);
    expect(source.includes('<circle cx="50" cy="50" r="50" fill="#ffffff"') && source.includes('M40.14 25.36'), path).toBe(false);
    for (const mark of source.matchAll(/function BrandMark\b[\s\S]*?\n}/g)) {
      expect(mark[0], path).not.toContain("rounded-full");
    }
  }
});
