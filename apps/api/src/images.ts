/** The picture type the bytes themselves say, never the name or the type the browser sent; null for anything else. */
export function pictureType(data: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | "image/gif" | null {
  const starts = (bytes: number[], at = 0) => bytes.every((byte, i) => data[at + i] === byte);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}
