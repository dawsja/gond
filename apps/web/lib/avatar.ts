import { AVATAR_MAX_BYTES } from "@gond/shared";

export { AVATAR_MAX_BYTES };
export const AVATAR_SIZE = 512;

/** Where a picture sits in a square stage: its zoom over the size that just covers the stage, and its top-left corner in stage pixels. */
export type Crop = { zoom: number; x: number; y: number };
type Size = { width: number; height: number };

export function coverScale(picture: Size, stage: number): number {
  return stage / Math.min(picture.width, picture.height);
}

/** Keeps the picture covering the whole stage, so the circle never shows an edge. */
export function clampCrop(crop: Crop, picture: Size, stage: number): Crop {
  const zoom = Math.max(1, crop.zoom);
  const scale = coverScale(picture, stage) * zoom;
  const clamp = (offset: number, span: number) => Math.min(0, Math.max(stage - span, offset));
  const centered = (span: number) => (stage - span) / 2;
  const width = picture.width * scale;
  const height = picture.height * scale;
  return {
    zoom,
    x: Number.isFinite(crop.x) ? clamp(crop.x, width) : centered(width),
    y: Number.isFinite(crop.y) ? clamp(crop.y, height) : centered(height),
  };
}

/** The square of the picture the stage shows, in the picture's own pixels. */
function cropSource(crop: Crop, picture: Size, stage: number): { x: number; y: number; side: number } {
  const scale = coverScale(picture, stage) * crop.zoom;
  return { x: -crop.x / scale, y: -crop.y / scale, side: stage / scale };
}

export async function cropToBlob(bitmap: ImageBitmap, crop: Crop, stage: number, size: number): Promise<Blob> {
  const source = cropSource(crop, bitmap, stage);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Couldn't prepare the picture.");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, source.x, source.y, source.side, source.side, 0, 0, size, size);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Couldn't prepare the picture.");
  if (blob.size > AVATAR_MAX_BYTES) throw new Error("The picture must be under 2 MB.");
  return blob;
}
