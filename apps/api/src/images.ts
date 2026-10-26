/** The picture type the bytes themselves say, never the name or the type the browser sent; null for anything else. */
export function pictureType(data: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  const starts = (bytes: number[], at = 0) => bytes.every((byte, i) => data[at + i] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

// The brands an iPhone's (and others') HEIF photos open with; AVIF's own is left out.
const HEIF_BRANDS = new Set(["heic", "heix", "heim", "heis", "hevc", "hevx", "hevm", "hevs", "mif1", "msf1"]);

/** Whether the bytes are a HEIC or HEIF photo: an `ftyp` box first, naming a HEIF brand. */
export function isHeic(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const text = (from: number) => String.fromCharCode(...data.subarray(from, from + 4));
  return text(4) === "ftyp" && HEIF_BRANDS.has(text(8));
}
