import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { brandMark, checkBrand, icoFrames, mascot, root, sourcePath } from "../../../scripts/brand.ts";

test("the reviewed brand source stays pinned", async () => {
  expect(createHash("sha256").update(await readFile(join(root, sourcePath))).digest("hex")).toBe("48207286d32f7072f95ea389e718241ce25f7e6074852736d65b1a4d0bc9d286");
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

test("the shared mark is the mascot on the ink tile, the same figure the desktop and the landing draw", async () => {
  const shared = await readFile(join(root, sourcePath));
  expect(shared.toString()).toBe(await brandMark(await mascot()));
  expect(shared.equals(await readFile(join(root, "apps/desktop/src/logo.svg")))).toBe(true);
});

// The cog with an ink hole in its centre, as the old mark and every asset drawn from it carried it.
const oldHole = (text: string) => [...text.matchAll(/<circle\b[^>]*>/g)].some(([tag]) =>
  ["cx", "cy"].every((attr) => new RegExp(`\\b${attr}\\s*=\\s*["']50["']`).test(tag)) && /\br\s*=\s*["']12["']/.test(tag));
const RETIRED = new Set([
  "bf28a137c9a870c929a6426d2a7c0ef850fe42adf94a92163289c1c12cfe782b", // gond-mark.svg
  "95aac95ce65f3c6a1f0cbd781e9bb9030659115fa4ce8b7c533e8b7399d63e2c", // AppIcon.icon cog.svg
  "308f7679d025f5d584689746eaa2e48b940c89e811cb70767a4d4e47f0477fe3", // logo.png, icon.png, ic_gond.png, BrandMark mark.png
  "ac9f4d976710d8496eda25e371330647121fc2a8ce60285017582efbf767661e", // favicon.ico
  "4be0f2b8e8712363fb8d9b439cccec98193a1f1d166bcee5df00c8ab6d0ce914", // apple-touch-icon.png
  "ef8d4695a353b9f076e6c916227bc1ad09ad521bb638bde9173c03a09d388e4b", // ic_launcher_foreground and _monochrome
  "088de3afec57f3c4aab622f582a93c8cf322807d226609729678c4ef74fe9dd5", // assets/gond-1024.png
  "7774ec49f2f9f4e15ebb41f45f54e8b15d2b1fcab8d413d5cbf7247b92933f39", // assets/gond-ios-1024.png
]);

test("the old cog-with-hole mark is rejected everywhere", async () => {
  expect(oldHole('<circle cx="50" cy="50" r="12" fill="#1b1a18"/>')).toBe(true);
  expect(oldHole("<circle r='12' fill='black' cy='50' cx='50'/>")).toBe(true);
  expect(oldHole('<circle cx="44" cy="56.5" r="6.5" fill="#fff"/>')).toBe(false);
  const files = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout.toString().split("\0").filter((path) => path && !path.endsWith("brand.test.ts"));
  for (const path of files) {
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) continue;
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(RETIRED.has(createHash("sha256").update(bytes).digest("hex")), path).toBe(false);
    if (/\.(svg|html|tsx?|jsx?|mjs|xml|json|swift|kt|css|md)$/.test(path)) expect(oldHole(bytes.toString()), path).toBe(false);
  }
});

type Pixels = { data: Buffer; width: number; height: number; channels: number };
const pixels = async (image: Buffer | string): Promise<Pixels> => {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
};
const bounds = ({ data, width, height }: Pixels, keep: (i: number) => boolean) => {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (!keep((y * width + x) * 4)) continue;
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  return { left, top, right, bottom, span: Math.max(right - left, bottom - top) + 1 };
};
// The middle half of the cog is body but for the eyes: `eye` pixels there are
// counted left and right of centre, and the centre itself must be body, where
// the old mark had its hole.
const face = (image: Pixels, figure: ReturnType<typeof bounds>, eye: (i: number) => boolean) => {
  const eyes = [0, 0];
  const from = Math.round(figure.span / 4), to = Math.round(figure.span * 3 / 4);
  for (let y = figure.top + from; y < figure.top + to; y++) for (let x = figure.left + from; x < figure.left + to; x++) {
    if (eye((y * image.width + x) * 4)) eyes[x < figure.left + figure.span / 2 ? 0 : 1]++;
  }
  const middle = ((figure.top + (figure.span >> 1)) * image.width + figure.left + (figure.span >> 1)) * 4;
  return { eyes: Math.min(...eyes), body: !eye(middle) };
};

// [path or frame, figure span range as a share of the canvas, tile span floor (0 when the canvas is all ink), eyes checked]
const icons = join(root, "apps/desktop/src-tauri/icons");
const res = "apps/android/app/src/main/res";
const MARK: [number, number] = [0.7, 0.8];
async function tileSurfaces(): Promise<[string, Buffer, [number, number], number][]> {
  const favicon = icoFrames(await readFile(join(root, "apps/web/app/favicon.ico")));
  const read = (path: string) => readFile(join(root, path));
  const og = await sharp(await read("apps/web/app/opengraph-image.png")).extract({ left: 400, top: 115, width: 400, height: 400 }).png().toBuffer();
  return [
    ...favicon.slice(0, 3).map((frame, i) => [`favicon ${[16, 32, 48][i]}`, frame, [0.76, 0.88], 0.95] as [string, Buffer, [number, number], number]),
    ["favicon 256", favicon[3], MARK, 0.95],
    ...await Promise.all(["apps/web/public/logo.png", "apps/web/app/icon.png", `${res}/drawable-nodpi/ic_gond.png`, "apps/ios/Gond/Assets.xcassets/BrandMark.imageset/mark.png", "assets/gond-1024.png", "apps/desktop/icon-source.png", ...["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"].map((dpi) => `${res}/mipmap-${dpi}/ic_launcher.png`)]
      .map(async (path) => [path, await read(path), MARK, 0.95] as [string, Buffer, [number, number], number])),
    ["opengraph-image.png, its middle", og, MARK, 0.95],
    ["apple-touch-icon.png", await read("apps/web/public/apple-touch-icon.png"), MARK, 0],
    ["assets/gond-ios-1024.png", await read("assets/gond-ios-1024.png"), MARK, 0],
    ["logo-maskable.png", await read("apps/web/public/logo-maskable.png"), [0.55, 0.63], 0],
    ["ic_splash.png", await read(`${res}/drawable-nodpi/ic_splash.png`), [0.45, 0.53], 0],
    ["desktop 24", icoFrames(await readFile(join(icons, "icon.ico")), [16, 24, 32, 48, 64, 256])[1], MARK, 0.95],
  ];
}

test("every surface that shows the tile shows the mascot with both eyes and no hole", async () => {
  for (const [name, image, [low, high], tileFloor] of await tileSurfaces()) {
    const px = await pixels(image);
    const size = px.width;
    expect(px.height, name).toBe(size);
    const light = (i: number) => px.data[i + 3] >= 128 && px.data[i] + px.data[i + 1] + px.data[i + 2] >= 384;
    const dark = (i: number) => px.data[i + 3] >= 128 && px.data[i] + px.data[i + 1] + px.data[i + 2] < 300;
    if (tileFloor) expect(bounds(px, (i) => px.data[i + 3] >= 128).span / size, `${name} tile`).toBeGreaterThanOrEqual(tileFloor);
    else expect(bounds(px, (i) => px.data[i + 3] < 255).span, `${name} is opaque`).toBeLessThanOrEqual(0);
    const figure = bounds(px, light);
    expect(figure.span / size, `${name} mascot`).toBeGreaterThanOrEqual(low);
    expect(figure.span / size, `${name} mascot`).toBeLessThanOrEqual(high);
    const { eyes, body } = face(px, figure, dark);
    expect(eyes, `${name} eyes`).toBeGreaterThan(0);
    expect(body, `${name} body between the eyes`).toBe(true);
  }
  for (const path of ["apps/web/public/apple-touch-icon.png", "apps/web/public/logo-maskable.png", "assets/gond-ios-1024.png", `${res}/drawable-nodpi/ic_splash.png`]) {
    expect((await sharp(join(root, path)).metadata()).hasAlpha, `${path} has no alpha`).toBe(false);
  }
});

test("the maskable and splash mascots stay inside their safe circles", async () => {
  for (const [path, radius] of [["apps/web/public/logo-maskable.png", 0.4], [`${res}/drawable-nodpi/ic_splash.png`, 1 / 3]] as const) {
    const px = await pixels(join(root, path));
    for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) {
      const i = (y * px.width + x) * 4;
      if (px.data[i] + px.data[i + 1] + px.data[i + 2] < 384) continue;
      expect(Math.hypot(x + 0.5 - px.width / 2, y + 0.5 - px.height / 2) / px.width, `${path} at ${x},${y}`).toBeLessThanOrEqual(radius);
    }
  }
});

test("one-colour silhouettes are a white cog with the eyes cut out", async () => {
  const cog = await sharp(join(root, "apps/ios/AppIcon.icon/Assets/cog.svg")).png().toBuffer();
  const silhouettes: [string, Buffer | string, [number, number]][] = [
    ["AppIcon.icon cog.svg", cog, MARK],
    ...["foreground", "monochrome"].map((layer) => [`ic_launcher_${layer}`, join(root, res, `drawable-nodpi/ic_launcher_${layer}.png`), [0.45, 0.53]] as [string, string, [number, number]]),
    ...["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"].map((dpi) => [`${dpi} ic_notification`, join(root, res, `drawable-${dpi}/ic_notification.png`), [0.85, 0.95]] as [string, string, [number, number]]),
    ["notification-badge.png", join(root, "apps/web/public/notification-badge.png"), [0.85, 0.95]],
  ];
  for (const [name, image, [low, high]] of silhouettes) {
    const px = await pixels(image);
    for (let i = 0; i < px.data.length; i += 4) {
      if (px.data[i + 3] && (px.data[i] < 255 || px.data[i + 1] < 255 || px.data[i + 2] < 255)) throw new Error(`${name}: not white at ${i / 4}`);
    }
    const figure = bounds(px, (i) => px.data[i + 3] >= 128);
    expect(figure.span / px.width, `${name} span`).toBeGreaterThanOrEqual(low);
    expect(figure.span / px.width, `${name} span`).toBeLessThanOrEqual(high);
    const { eyes, body } = face(px, figure, (i) => px.data[i + 3] < 128);
    expect(eyes, `${name} eye holes`).toBeGreaterThan(0);
    expect(body, `${name} body between the eyes`).toBe(true);
  }
});
