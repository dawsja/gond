// A copy of a picture small enough to show a model: the long edge at most
// PREVIEW_EDGE (what vision models work at anyway), JPEG, rotated the way
// the camera held it. The original stays where it is.

export const PREVIEW_EDGE = 1568;
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;

// The coder is named for ImageMagick, never guessed from the file's bytes,
// so a file can only ever be read as the kind of picture it was sent as.
export const PREVIEW_CODERS = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

// An iPhone's HEIC or HEIF photo as a JPEG every browser and model can read, stdin to stdout: rotated
// the way the camera held it, its metadata (where it was taken, too) left behind.
export const JPEG_FROM_HEIC = ["convert", "heic:-[0]", "-auto-orient", "-strip", "-quality", "90", "jpeg:-"];

export function previewArgv(source, mediaType, out, edge = PREVIEW_EDGE) {
  const coder = PREVIEW_CODERS[mediaType];
  if (!coder) return null;
  return ["convert", `${coder}:${source}[0]`, "-auto-orient", "-strip", "-resize", `${edge}x${edge}>`, "-quality", "85", `jpeg:${out}`];
}
