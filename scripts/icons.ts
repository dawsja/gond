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

const disc512 = await png("disc", 512);
write(join(root, "assets/gond-1024.png"), await png("disc", 1024));

write(join(android, "mipmap-xxxhdpi/ic_launcher.png"), await png("disc", 192));
write(join(android, "drawable-nodpi/ic_launcher_foreground.png"), await png("ink", 432, 0.2));
write(join(android, "drawable-nodpi/ic_splash.png"), await png("ink", 288));
write(join(android, "drawable-nodpi/ic_gond.png"), disc512);
for (const [dpi, size] of [["mdpi", 24], ["hdpi", 36], ["xhdpi", 48], ["xxhdpi", 72], ["xxxhdpi", 96]] as const) {
  write(join(android, `drawable-${dpi}/ic_notification.png`), await png("white", size));
}
