import { mkdir, readFile, writeFile } from "node:fs/promises";
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

export function icoFrames(data: Buffer): Buffer[] {
  if (data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1 || data.readUInt16LE(4) !== icoSizes.length) {
    throw new Error("Invalid ICO directory");
  }
  let next = 6 + 16 * icoSizes.length;
  const frames = icoSizes.map((size, index) => {
    const entry = 6 + 16 * index;
    const length = data.readUInt32LE(entry + 8);
    const offset = data.readUInt32LE(entry + 12);
    if ((data[entry] || 256) !== size || (data[entry + 1] || 256) !== size || offset !== next || offset + length > data.length) {
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
  return new Map([
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
}

async function comparePixels(actual: Buffer, expected: Buffer) {
  const decode = (image: Buffer) => sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [a, b] = await Promise.all([decode(actual), decode(expected)]);
  if (a.info.width !== b.info.width || a.info.height !== b.info.height || a.data.length !== b.data.length) throw new Error("Dimensions differ");
  for (let i = 0; i < a.data.length; i++) {
    if (Math.abs(a.data[i] - b.data[i]) > 2) throw new Error(`Pixels differ at channel ${i}`);
  }
}

export async function checkBrand() {
  for (const [path, expected] of await renderBrand()) {
    try {
      const actual = await readFile(join(root, path));
      if (path.endsWith(".ico")) {
        const frames = icoFrames(actual);
        const expectedFrames = icoFrames(expected);
        for (let i = 0; i < frames.length; i++) await comparePixels(frames[i], expectedFrames[i]);
      } else await comparePixels(actual, expected);
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : error}`);
    }
  }
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    await checkBrand();
    console.log("Brand check passed: 7 assets, ICO sizes 16, 32, 48, 256");
  } else {
    for (const [path, image] of await renderBrand()) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), image);
      console.log(`${path}: ${image.length} bytes`);
    }
  }
}
