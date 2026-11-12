import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { checkBrand, icoFrames, root, sourcePath } from "../../../scripts/brand.ts";

test("the reviewed brand source stays pinned", async () => {
  expect(createHash("sha256").update(await readFile(join(root, sourcePath))).digest("hex")).toBe("bf28a137c9a870c929a6426d2a7c0ef850fe42adf94a92163289c1c12cfe782b");
});

test("all web and native brand assets match the source", async () => {
  await checkBrand();
}, 30_000);

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

test("native surfaces cannot restore the old mark", async () => {
  const files = Bun.spawnSync(["git", "ls-files", "-z", "--", "apps/desktop", "apps/android", "apps/ios", "assets"], { cwd: root }).stdout.toString().split("\0");
  for (const path of files.filter((path) => /\.(svg|xml|swift|html|json|ts)$/.test(path))) {
    if (!(await Bun.file(join(root, path)).exists())) continue;
    const source = await readFile(join(root, path), "utf8");
    expect(source, path).not.toContain("assets/gond.svg");
    expect(source.includes('<circle cx="50" cy="50" r="50" fill="#ffffff"') && source.includes("M40.14 25.36"), path).toBe(false);
    expect(source, path).not.toMatch(/name="ic_launcher_background">#FFFFFF/i);
  }
});

test("Android glyphs stay white and inside the adaptive safe circle", async () => {
  const base = "apps/android/app/src/main/res";
  for (const path of ["drawable-nodpi/ic_launcher_foreground.png", "drawable-nodpi/ic_launcher_monochrome.png", ...["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"].map((dpi) => `drawable-${dpi}/ic_notification.png`)]) {
    const { data, info } = await sharp(join(root, base, path)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let visible = 0;
    for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * 4;
      if (!data[i + 3]) continue;
      visible++;
      if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255) throw new Error(`${path}: nonwhite glyph at ${x},${y}`);
      if (path.includes("launcher") && Math.hypot(x + 0.5 - info.width / 2, y + 0.5 - info.height / 2) > info.width * 33 / 108) throw new Error(`${path}: glyph escapes 66dp safe circle`);
    }
    expect(visible, path).toBeGreaterThan(0);
  }
  const marketing = await sharp(join(root, "assets/gond-ios-1024.png")).metadata();
  expect([marketing.width, marketing.height, marketing.hasAlpha]).toEqual([1024, 1024, false]);
});

test("native consumers keep their generated layers and ink backgrounds", async () => {
  const android = "apps/android/app/src/main/res";
  for (const mode of ["values", "values-night"]) {
    expect(await readFile(join(root, android, mode, "colors.xml"), "utf8")).toContain('<color name="ic_launcher_background">#1b1a18</color>');
  }
  const adaptive = await readFile(join(root, android, "mipmap-anydpi-v26/ic_launcher.xml"), "utf8");
  expect(adaptive).toContain('<monochrome android:drawable="@drawable/ic_launcher_monochrome"');
  expect(adaptive).toContain('<foreground android:drawable="@drawable/ic_launcher_foreground"');
  expect(adaptive).toContain('<background android:drawable="@color/ic_launcher_background"');
  expect(await readFile(join(root, "apps/ios/Gond/ConnectView.swift"), "utf8")).toContain('Image("BrandMark")');
});

test("the desktop icon is the mascot, full-bleed, its eyes showing from 24 px", async () => {
  const icons = join(root, "apps/desktop/src-tauri/icons");
  const images = [...icoFrames(await readFile(join(icons, "icon.ico")), [16, 24, 32, 48, 64, 256]), ...await Promise.all(["32x32.png", "64x64.png", "128x128.png", "icon.png", "StoreLogo.png"].map((name) => readFile(join(icons, name))))];
  for (const image of images) {
    const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const size = info.width;
    const light = (i: number) => data[i] + data[i + 1] + data[i + 2] >= 384;
    const box = (keep: (i: number) => boolean) => {
      let left = size, top = size, right = -1, bottom = -1;
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        if (data[i + 3] < 128 || !keep(i)) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
      return { left, top, span: Math.max(right - left, bottom - top) + 1 };
    };
    const tile = box(() => true);
    const cog = box(light);
    expect(tile.span / size, `${size} px tile`).toBeGreaterThanOrEqual(0.95);
    expect(cog.span / size, `${size} px mascot`).toBeGreaterThanOrEqual(0.6);
    if (size < 24) continue;
    // The middle half of the cog is all body but the eyes, so dark pixels there are eyes.
    const eyes = [0, 0];
    const from = Math.round(cog.span / 4), to = Math.round(cog.span * 3 / 4);
    for (let y = cog.top + from; y < cog.top + to; y++) for (let x = cog.left + from; x < cog.left + to; x++) {
      const i = (y * size + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] < 300) eyes[x < cog.left + cog.span / 2 ? 0 : 1]++;
    }
    expect(Math.min(...eyes), `${size} px eyes`).toBeGreaterThan(0);
    // Between the eyes is body; the plain mark has its hole there.
    const middle = ((cog.top + (cog.span >> 1)) * size + cog.left + (cog.span >> 1)) * 4;
    expect(light(middle), `${size} px body between the eyes`).toBe(true);
  }
});
