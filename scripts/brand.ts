import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";

export const root = join(import.meta.dir, "..");
export const sourcePath = "packages/shared/brand/gond-mark.svg";
const icoSizes = [16, 32, 48, 256];

function ico(images: Buffer[]): Buffer {
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach((image, index) => {
    const entry = 6 + 16 * index;
    const size = icoSizes[index];
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  });
  return Buffer.concat([directory, ...images]);
}

export function icoFrames(data: Buffer, sizes = icoSizes): Buffer[] {
  if (data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1 || data.readUInt16LE(4) !== sizes.length) {
    throw new Error("Invalid ICO directory");
  }
  let next = 6 + 16 * sizes.length;
  const frames = sizes.map((size, index) => {
    const entry = 6 + 16 * index;
    const length = data.readUInt32LE(entry + 8);
    const offset = data.readUInt32LE(entry + 12);
    if ((data[entry] || 256) !== size || (data[entry + 1] || 256) !== size || data.readUInt16LE(entry + 4) > 1 || data.readUInt16LE(entry + 6) !== 32 || offset !== next || offset + length > data.length) {
      throw new Error(`Invalid ICO frame ${size}`);
    }
    next += length;
    return data.subarray(offset, offset + length);
  });
  if (next !== data.length) throw new Error("Unexpected ICO trailing data");
  return frames;
}

// The tile of the brand mark, drawn on a 768 square and scaled full-bleed.
const INK = "#1b1a18";
const TILE = `<rect x="128" y="128" width="768" height="768" rx="300" fill="${INK}"/><rect x="141" y="141" width="742" height="742" rx="287" fill="none" stroke="#ffffff" stroke-opacity="0.22" stroke-width="26"/>`;
// Share of the tile the mascot spans in the brand mark, and so on every
// surface that shows the tile. Windows draws the desktop icon at 16 to 32 px
// beside full-bleed neighbours, so a margin and a small figure read as small.
export const MARK_MASCOT = 0.74;
// Surfaces always shown at 24 logical px or less (a browser tab at 1x to 3x,
// status bar icons, the web notification badge) take the mascot with wider,
// further-apart eyes and a larger figure; at the exact geometry the eyes are
// 1 px smudges at 16 px and the mark reads as a blob.
export const SMALL_MASCOT = { eyeWidth: 1.6, eyeHeight: 1.1, spread: 1.2, share: 0.82 };
// The launcher layers' canvas is 108 dp, of which a launcher shows the
// middle 72 dp; the splash icon's is 288 dp, shown in a 192 dp circle.
// Both keep the mark's proportion of what is shown.
export const LAUNCHER_MASCOT = MARK_MASCOT * 72 / 108;
// The maskable icon's safe zone is the middle 80% circle.
export const MASKABLE_MASCOT = MARK_MASCOT * 0.8;
// A status bar icon is 24 dp; the figure keeps a hair of padding.
export const GLYPH_MASCOT = 0.9;
const desktopSource = "apps/desktop/icon-source.png";
const mascotPath = "apps/web/components/hq/gond-bot.tsx";

// The mascot standing still with its eyes open, its geometry read from the
// component so no surface can drift from it: a white cog, ink eyes. `small`
// widens and spreads the eyes about their own centres for tiny surfaces.
export async function mascot(ink = INK, small = false): Promise<string> {
  const source = await readFile(join(root, mascotPath), "utf8");
  const cog = source.match(/const COG =\s*"([^"]+)"/)?.[1];
  const stroke = source.match(/<path d=\{shape === "cog" \? COG[^>]*strokeWidth="([\d.]+)"/)?.[1];
  const eye = source.match(/<rect x=\{cx - ([\d.]+)\} y=\{cy - ([\d.]+)\} width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)" fill="#fff" transform=\{`rotate\((-?[\d.]+) \$\{cx\} \$\{cy\}\)`\}/);
  const eyes = [...source.matchAll(/eye\(\{ cx: ([\d.]+), cy: ([\d.]+), lid:/g)].map(([, cx, cy]) => [Number(cx), Number(cy)]);
  if (!cog || !stroke || !eye || eyes.length !== 2) throw new Error(`Mascot geometry not found in ${mascotPath}`);
  const [, dx, dy, width, height, rx, turn] = eye;
  const body = `<path d="${cog}" fill="#ffffff" stroke="#ffffff" stroke-width="${stroke}" stroke-linejoin="round"/>`;
  if (!small) return body + eyes.map(([cx, cy]) => `<rect x="${cx - Number(dx)}" y="${cy - Number(dy)}" width="${width}" height="${height}" rx="${rx}" fill="${ink}" transform="rotate(${turn} ${cx} ${cy})"/>`).join("");
  const mid = [(eyes[0][0] + eyes[1][0]) / 2, (eyes[0][1] + eyes[1][1]) / 2];
  const w = Number(width) * SMALL_MASCOT.eyeWidth, h = Number(height) * SMALL_MASCOT.eyeHeight;
  return body + eyes.map(([x, y]) => {
    const cx = mid[0] + (x - mid[0]) * SMALL_MASCOT.spread, cy = mid[1] + (y - mid[1]) * SMALL_MASCOT.spread;
    return `<rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" rx="${w / 2}" fill="${ink}" transform="rotate(${turn} ${cx} ${cy})"/>`;
  }).join("");
}

// The figure centred on a 1024 canvas, spanning `share` of it by its
// measured bounding box.
async function placed(figure: string, share: number): Promise<string> {
  const { data, info } = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 100 100">${figure}</svg>`))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width, top = info.height, right = -1, bottom = -1;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const x = (i / 4) % info.width, y = Math.floor(i / 4 / info.width);
    left = Math.min(left, x); right = Math.max(right, x + 1);
    top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
  }
  const scale = share * 1024 / (Math.max(right - left, bottom - top) / 10);
  return `<g transform="translate(512 512) scale(${scale}) translate(${-(left + right) / 20} ${-(top + bottom) / 20})">${figure}</g>`;
}

// The brand mark: the mascot centred on the ink tile, the tile full-bleed.
export async function brandMark(figure?: string, share = MARK_MASCOT): Promise<string> {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><g transform="translate(512 512) scale(${1024 / 768}) translate(-512 -512)">${TILE}</g>`
    + `${await placed(figure ?? await mascot(), share)}</svg>`;
}

const canvas = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>`);

// The mascot on a square of ink, for surfaces that are opaque or masked by
// the system.
async function onInk(figure: string, share: number): Promise<Buffer> {
  return canvas(`<rect width="1024" height="1024" fill="${INK}"/>${await placed(figure, share)}`);
}

// A one-colour silhouette: the white cog with the eyes cut out, so the eyes
// show whatever is behind (the launcher's ink, a tint, the status bar).
async function glyph(figure: string, share: number): Promise<Buffer> {
  return canvas(`<defs><mask id="glyph">${await placed(figure.replaceAll(INK, "black"), share)}</mask></defs><rect width="1024" height="1024" fill="white" mask="url(#glyph)"/>`);
}

export async function renderBrand(): Promise<Map<string, Buffer>> {
  const figure = await mascot();
  const small = await mascot(INK, true);
  const source = Buffer.from(await brandMark(figure));
  const tiny = await brandMark(small, SMALL_MASCOT.share);
  const mark = (size: number) => sharp(source).resize(size, size).png().toBuffer();
  // A favicon's 16, 32 and 48 frames are a 16 px tab at 1x, 2x and 3x.
  const favicon = (size: number) => sharp(Buffer.from(size < 256 ? tiny : source.toString())).resize(size, size).png().toBuffer();
  const logo = await mark(512);
  const badge = await glyph(small, GLYPH_MASCOT);
  const outputs = new Map<string, Buffer>([
    [sourcePath, source],
    ["apps/web/public/logo.png", logo],
    ["apps/web/app/icon.png", logo],
    ["apps/web/app/favicon.ico", ico(await Promise.all(icoSizes.map(favicon)))],
    ["apps/web/public/apple-touch-icon.png", await sharp(await onInk(figure, MARK_MASCOT)).resize(180, 180).removeAlpha().png().toBuffer()],
    ["apps/web/public/logo-maskable.png", await sharp(await onInk(figure, MASKABLE_MASCOT)).resize(512, 512).removeAlpha().png().toBuffer()],
    ["apps/web/public/notification-badge.png", await sharp(badge).resize(96, 96).png().toBuffer()],
    ["apps/web/app/opengraph-image.png", await sharp({ create: { width: 1200, height: 630, channels: 3, background: INK } })
      .composite([{ input: await mark(400), gravity: "centre" }]).png().toBuffer()],
  ]);
  await renderNative(outputs, source, figure, badge, logo, mark);
  return outputs;
}

async function renderNative(outputs: Map<string, Buffer>, source: Buffer, figure: string, badge: Buffer, logo: Buffer, mark: (size: number) => Promise<Buffer>) {
  outputs.set("assets/gond-1024.png", await mark(1024));
  outputs.set(desktopSource, await mark(1024));
  outputs.set("apps/desktop/src/logo.svg", source);
  // Icon Composer draws the ink fill edge to edge and one white glass layer
  // over it; the eyes are holes in that layer, so they are the fill's ink.
  outputs.set("apps/ios/AppIcon.icon/Assets/cog.svg", await glyph(figure, MARK_MASCOT));
  const android = "apps/android/app/src/main/res";
  const adaptive = await sharp(await glyph(figure, LAUNCHER_MASCOT)).resize(432, 432).png().toBuffer();
  outputs.set(`${android}/drawable-nodpi/ic_launcher_foreground.png`, adaptive);
  outputs.set(`${android}/drawable-nodpi/ic_launcher_monochrome.png`, adaptive);
  // The splash screen shows its icon in a circle two thirds of the canvas wide.
  outputs.set(`${android}/drawable-nodpi/ic_splash.png`, await sharp(await onInk(figure, LAUNCHER_MASCOT)).resize(288, 288).removeAlpha().png().toBuffer());
  outputs.set(`${android}/drawable-nodpi/ic_gond.png`, logo);
  for (const [dpi, size] of [["mdpi", 24], ["hdpi", 36], ["xhdpi", 48], ["xxhdpi", 72], ["xxxhdpi", 96]] as const) {
    outputs.set(`${android}/drawable-${dpi}/ic_notification.png`, await sharp(badge).resize(size, size).png().toBuffer());
    outputs.set(`${android}/mipmap-${dpi}/ic_launcher.png`, await mark(size * 2));
  }
  const imageset = "apps/ios/Gond/Assets.xcassets/BrandMark.imageset";
  outputs.set(`${imageset}/mark.png`, logo);
  outputs.set(`${imageset}/Contents.json`, Buffer.from(JSON.stringify({ images: [{ filename: "mark.png", idiom: "universal" }], info: { author: "xcode", version: 1 } }, null, 2) + "\n"));
  // Xcode compiles AppIcon.icon for older iOS too; this is an opaque reference, not a second app icon catalog.
  outputs.set("assets/gond-ios-1024.png", await sharp(await onInk(figure, MARK_MASCOT)).resize(1024, 1024).removeAlpha().png().toBuffer());
  const fill = (value: string) => [{ value: { solid: value } }, { appearance: "dark", value: { solid: value } }];
  outputs.set("apps/ios/AppIcon.icon/icon.json", Buffer.from(JSON.stringify({
    "fill-specializations": fill("extended-srgb:0.10588,0.10196,0.09412,1.00000"),
    groups: [{ layers: [{ "fill-specializations": fill("extended-srgb:1.00000,1.00000,1.00000,1.00000"), glass: true, "image-name": "cog.svg", name: "cog" }], lighting: "combined", shadow: { kind: "neutral", opacity: 0.5 }, specular: true, translucency: { enabled: false, value: 0.5 } }],
    "supported-platforms": { squares: "shared" },
  }, null, 2) + "\n"));
}

async function comparePixels(actual: Buffer, expected: Buffer) {
  const decode = (image: Buffer) => sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [a, b] = await Promise.all([decode(actual), decode(expected)]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height || a.data.length !== b.data.length) throw new Error("Dimensions differ");
  for (let i = 0; i < a.data.length; i++) {
    if (Math.abs(a.data[i] - b.data[i]) > 2) throw new Error(`Pixels differ at channel ${i}`);
  }
}

async function tree(directory: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(directory, prefix), { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory() ? tree(directory, join(prefix, entry.name)) : [join(prefix, entry.name)]))).flat().sort();
}

function icnsChunks(data: Buffer): Map<string, Buffer> {
  if (data.toString("ascii", 0, 4) !== "icns" || data.readUInt32BE(4) !== data.length) throw new Error("Invalid ICNS directory");
  const chunks = new Map<string, Buffer>();
  for (let offset = 8; offset < data.length;) {
    const type = data.toString("ascii", offset, offset + 4);
    const length = data.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > data.length || chunks.has(type)) throw new Error("Invalid ICNS chunk");
    chunks.set(type, data.subarray(offset + 8, offset + length));
    offset += length;
  }
  return chunks;
}

export async function desktopBrand(check: boolean, source: Buffer) {
  const temp = await mkdtemp(join(tmpdir(), "gond-brand-"));
  const destination = join(root, "apps/desktop/src-tauri/icons");
  try {
    await writeFile(join(temp, "source.png"), source);
    const result = Bun.spawnSync([join(root, "apps/desktop/node_modules/.bin/tauri"), "icon", join(temp, "source.png"), "-o", join(temp, "icons"), "--ios-color", "#1b1a18"], { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    const files = await tree(join(temp, "icons"));
    if (check && JSON.stringify(files) !== JSON.stringify(await tree(destination))) throw new Error("Desktop icon file list differs; run bun run --filter @gond/desktop icons");
    for (const path of files) {
      const expected = await readFile(join(temp, "icons", path));
      if (!check) {
        await mkdir(dirname(join(destination, path)), { recursive: true });
        await writeFile(join(destination, path), expected);
      } else {
        try {
          const actual = await readFile(join(destination, path));
          if (path.endsWith(".png")) await comparePixels(actual, expected);
          else if (path.endsWith(".ico")) {
            const sizes = [16, 24, 32, 48, 64, 256];
            const a = icoFrames(actual, sizes);
            const b = icoFrames(expected, sizes);
            for (let i = 0; i < sizes.length; i++) await comparePixels(a[i], b[i]);
          } else if (path.endsWith(".icns")) {
            // Tauri's ICNS chunk order is not stable; compare keyed payloads instead.
            const a = icnsChunks(actual);
            const b = icnsChunks(expected);
            if ([...a.keys()].sort().join() !== [...b.keys()].sort().join()) throw new Error("ICNS frame list differs");
            for (const [type, image] of b) {
              const frame = a.get(type)!;
              if (image.subarray(1, 4).toString() === "PNG") await comparePixels(frame, image);
              else if (!frame.equals(image)) throw new Error(`ICNS ${type} differs`);
            }
          } else if (!actual.equals(expected)) throw new Error("Container or metadata differs from fresh Tauri output");
        } catch (error) {
          throw new Error(`${path}: ${error}; run bun run --filter @gond/desktop icons`);
        }
      }
    }
    return files.length;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function checkBrand() {
  const outputs = await renderBrand();
  for (const [path, expected] of outputs) {
    try {
      const actual = await readFile(join(root, path));
      if (path.endsWith(".ico")) {
        const frames = icoFrames(actual);
        const expectedFrames = icoFrames(expected);
        for (let i = 0; i < frames.length; i++) await comparePixels(frames[i], expectedFrames[i]);
      } else if (/\.(svg|json)$/.test(path)) {
        if (!actual.equals(expected)) throw new Error("Derived source differs");
      } else await comparePixels(actual, expected);
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
  await desktopBrand(true, outputs.get(desktopSource)!);
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    await checkBrand();
    console.log("Brand check passed: web and native assets, fresh Tauri containers and PNGs");
  } else {
    const outputs = await renderBrand();
    for (const [path, image] of outputs) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), image);
      console.log(`${path}: ${image.length} bytes`);
    }
    console.log(`Desktop: ${await desktopBrand(false, outputs.get(desktopSource)!)} Tauri assets regenerated`);
  }
}
