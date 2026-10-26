import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import sharp from "sharp";

const root = join(import.meta.dir, "..");
const asset = readFileSync(join(root, "assets/gond.svg"), "utf8");
const cog = asset.match(/ d="([^"]+)"/)?.[1];
if (!cog) throw new Error("assets/gond.svg has no path");
const android = join(root, "apps/android/app/src/main/res");

type Variant = "disc" | "ink" | "white";

function source(variant: Variant, inset = 0): Buffer {
  const scale = 1 - inset * 2;
  const colour = variant === "white" ? "#ffffff" : "#1b1a18";
  const disc = variant === "disc" ? '<circle cx="50" cy="50" r="50" fill="#ffffff"/>' : "";
  const path = `<path transform="translate(50 50) scale(${scale}) translate(-52 -54)" d="${cog}" fill="${colour}" stroke="${colour}" stroke-width="5" stroke-linejoin="round"/>`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${disc}${path}</svg>`);
}

async function png(variant: Variant, size: number, inset = 0): Promise<Buffer> {
  return sharp(source(variant, inset), { density: Math.max(72, (size / 100) * 72 * 2) })
    .resize(size, size)
    .png()
    .toBuffer();
}

function write(path: string, data: Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`${path.replace(root + "/", "")} ${data.length} bytes`);
}

function ico(images: Buffer[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + 16 * images.length;
  for (const image of images) {
    const size = image.readUInt32BE(16);
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.length;
  }
  return Buffer.concat([header, ...entries, ...images]);
}

const disc512 = await png("disc", 512);
write(join(root, "apps/web/public/logo.png"), disc512);
write(join(root, "apps/web/app/icon.png"), disc512);
write(join(root, "apps/web/public/logo-maskable.png"), await png("disc", 512, 0.12));
write(join(root, "apps/web/app/favicon.ico"), ico(await Promise.all([16, 32, 48, 256].map((s) => png("disc", s)))));
write(join(root, "assets/gond-1024.png"), await png("disc", 1024));

write(join(android, "mipmap-xxxhdpi/ic_launcher.png"), await png("disc", 192));
write(join(android, "drawable-nodpi/ic_launcher_foreground.png"), await png("ink", 432, 0.2));
write(join(android, "drawable-nodpi/ic_splash.png"), await png("ink", 288));
write(join(android, "drawable-nodpi/ic_gond.png"), disc512);
for (const [dpi, size] of [["mdpi", 24], ["hdpi", 36], ["xhdpi", 48], ["xxhdpi", 72], ["xxxhdpi", 96]] as const) {
  write(join(android, `drawable-${dpi}/ic_notification.png`), await png("white", size));
}
