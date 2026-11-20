// Pictures people send are read here, in a worker, by ImageMagick built as WebAssembly: a hostile file
// can reach neither the API's memory nor its files, and a slow one doesn't hold up its requests.
import { ImageMagick, initializeImageMagick, MagickFormat, MagickGeometry, ResourceLimits } from "@imagemagick/magick-wasm";

declare const self: Worker;

export type ImageJob = { id: number; op: "jpeg" | "preview"; type: string; data: Uint8Array; edge: number };
export type ImageReply = { id: number; data?: Uint8Array; error?: string };

// The coder is named for the type the picture was sent as, never guessed from its bytes, so a file is
// only ever read as the kind of picture it says it is.
const CODERS: Record<string, MagickFormat> = {
  "image/jpeg": MagickFormat.Jpeg,
  "image/png": MagickFormat.Png,
  "image/webp": MagickFormat.WebP,
  "image/gif": MagickFormat.Gif,
  "image/bmp": MagickFormat.Bmp,
  "image/heic": MagickFormat.Heic,
};

const ready = (async () => {
  const wasm = await Bun.file(Bun.fileURLToPath(import.meta.resolve("@imagemagick/magick-wasm/magick.wasm"))).bytes();
  await initializeImageMagick(wasm);
  // A picture claiming to be enormous is refused before it is decoded.
  ResourceLimits.memory = 768n * 1024n * 1024n;
  ResourceLimits.width = 20_000n;
  ResourceLimits.height = 20_000n;
  ResourceLimits.area = 200_000_000n;
})();

self.onmessage = async (event: MessageEvent<ImageJob>) => {
  const job = event.data;
  try {
    await ready;
    const coder = CODERS[job.op === "jpeg" ? "image/heic" : job.type];
    if (!coder) throw new Error(`no reader for ${job.type}`);
    const out = ImageMagick.read(job.data, coder, (image) => {
      image.autoOrient();
      image.strip();
      if (job.op === "preview") {
        const fit = new MagickGeometry(job.edge, job.edge);
        fit.greater = true;
        image.resize(fit);
        image.quality = 85;
      } else {
        image.quality = 90;
      }
      return image.write(MagickFormat.Jpeg, (bytes) => new Uint8Array(bytes));
    });
    self.postMessage({ id: job.id, data: out } satisfies ImageReply, [out.buffer]);
  } catch (error) {
    self.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) } satisfies ImageReply);
  }
};
