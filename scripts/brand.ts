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

export async function renderBrand(): Promise<Map<string, Buffer>> {
  const source = await readFile(join(root, sourcePath));
  const svg = source.toString();
  const ink = svg.match(/<rect[^>]*fill="([^"]+)"/)?.[1];
  if (!ink) throw new Error("Missing brand background");
  const cropped = await sharp(source).extract({ left: 64, top: 64, width: 896, height: 896 }).png().toBuffer();
  const mark = (size: number) => sharp(cropped).resize(size, size).png().toBuffer();
  const logo = await mark(512);
  const glyph = svg.match(/<g transform="rotate[\s\S]*?<\/g>/)?.[0];
  if (!glyph) throw new Error("Missing brand glyph");
  // The glyph's luminance becomes alpha, including the transparent centre hole.
  const mask = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${glyph.replaceAll(ink, "black")}</svg>`))
    .resize(96, 96).flatten({ background: "black" }).greyscale().raw().toBuffer();
  const rgba = Buffer.alloc(96 * 96 * 4, 255);
  for (let i = 0; i < mask.length; i++) rgba[i * 4 + 3] = mask[i];
  const outputs = new Map<string, Buffer>([
    ["apps/web/public/logo.png", logo],
    ["apps/web/app/icon.png", logo],
    ["apps/web/app/favicon.ico", ico(await Promise.all(icoSizes.map(mark)))],
    ["apps/web/public/apple-touch-icon.png", await sharp(cropped).resize(180, 180).flatten({ background: ink }).png().toBuffer()],
    ["apps/web/public/logo-maskable.png", await sharp({ create: { width: 512, height: 512, channels: 3, background: ink } })
      .composite([{ input: await mark(410), gravity: "centre" }]).png().toBuffer()],
    ["apps/web/public/notification-badge.png", await sharp(rgba, { raw: { width: 96, height: 96, channels: 4 } }).png().toBuffer()],
    ["apps/web/app/opengraph-image.png", await sharp({ create: { width: 1200, height: 630, channels: 3, background: ink } })
      .composite([{ input: await mark(400), gravity: "centre" }]).png().toBuffer()],
  ]);
  await renderNative(outputs, source, svg, ink, glyph, cropped, logo, mark);
  return outputs;
}

// Share of the canvas the desktop icon's cog spans. Windows draws a taskbar icon
// at 16 to 32 px with no tile of its own, so the source's margin and small cog
// read as a small icon beside full-bleed neighbours.
export const DESKTOP_GLYPH = 0.68;
const desktopSource = "apps/desktop/icon-source.png";

async function desktopMark(svg: string, glyph: string): Promise<Buffer> {
  const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${body}</svg>`;
  const around = (scale: number, body: string) => `<g transform="translate(512 512) scale(${scale}) translate(-512 -512)">${body}</g>`;
  const tile = svg.match(/<rect[^>]*\/>/g);
  const width = Number(tile?.[0].match(/width="([\d.]+)"/)?.[1]);
  if (tile?.length !== 2 || !width) throw new Error("Missing brand tile");
  // The cog is centred on 512, so scaling about the centre keeps its place and rotation.
  const { data, info } = await sharp(Buffer.from(wrap(glyph))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let low = info.width, high = -1;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const x = (i / 4) % info.width, y = Math.floor(i / 4 / info.width);
    low = Math.min(low, x, y);
    high = Math.max(high, x, y);
  }
  const extent = 2 * Math.max(512 - low, high + 1 - 512);
  return Buffer.from(wrap(around(1024 / width, tile.join("")) + around(DESKTOP_GLYPH * 1024 / extent, glyph)));
}

async function renderNative(outputs: Map<string, Buffer>, source: Buffer, svg: string, ink: string, glyph: string, cropped: Buffer, logo: Buffer, mark: (size: number) => Promise<Buffer>) {
  outputs.set("assets/gond-1024.png", await sharp(source).resize(1024, 1024).png().toBuffer());
  outputs.set(desktopSource, await sharp(await desktopMark(svg, glyph)).resize(1024, 1024).png().toBuffer());
  // The Connect screen's mark is the tile alone, as the web's BrandMark draws logo.png.
  if (!svg.includes('viewBox="0 0 1024 1024"')) throw new Error("Unexpected brand viewBox");
  outputs.set("apps/desktop/src/logo.svg", Buffer.from(svg.replace('viewBox="0 0 1024 1024"', 'viewBox="64 64 896 896"')));
  const wrap = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>`);
  // A luminance mask cuts the source's ink hole out of the white glass layer.
  const glyphSvg = wrap(`<defs><mask id="glyph"><g transform="${svg.match(/<g transform="([^"]+)"/)![1]}">${glyph.replaceAll(ink, "black")}</g></mask></defs><rect width="1024" height="1024" fill="white" mask="url(#glyph)"/>`);
  outputs.set("apps/ios/AppIcon.icon/Assets/cog.svg", glyphSvg);
  const silhouette = (size: number) => sharp(glyphSvg).resize(size, size).png().toBuffer();
  const android = "apps/android/app/src/main/res";
  const adaptive = await silhouette(432);
  outputs.set(`${android}/drawable-nodpi/ic_launcher_foreground.png`, adaptive);
  outputs.set(`${android}/drawable-nodpi/ic_launcher_monochrome.png`, adaptive);
  outputs.set(`${android}/drawable-nodpi/ic_splash.png`, await sharp(source).resize(288, 288).png().toBuffer());
  outputs.set(`${android}/drawable-nodpi/ic_gond.png`, logo);
  for (const [dpi, size] of [["mdpi", 24], ["hdpi", 36], ["xhdpi", 48], ["xxhdpi", 72], ["xxxhdpi", 96]] as const) {
    outputs.set(`${android}/drawable-${dpi}/ic_notification.png`, await silhouette(size));
    outputs.set(`${android}/mipmap-${dpi}/ic_launcher.png`, await mark(size * 2));
  }
  const imageset = "apps/ios/Gond/Assets.xcassets/BrandMark.imageset";
  outputs.set(`${imageset}/mark.png`, logo);
  outputs.set(`${imageset}/Contents.json`, Buffer.from(JSON.stringify({ images: [{ filename: "mark.png", idiom: "universal" }], info: { author: "xcode", version: 1 } }, null, 2) + "\n"));
  // Xcode compiles AppIcon.icon for older iOS too; this is an opaque reference, not a second app icon catalog.
  outputs.set("assets/gond-ios-1024.png", await sharp(cropped).resize(1024, 1024).flatten({ background: ink }).removeAlpha().png().toBuffer());
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
