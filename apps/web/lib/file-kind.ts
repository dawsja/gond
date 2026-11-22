export type FileKind = "spreadsheet" | "document" | "audio" | "video" | "archive" | "other";

const BY_EXTENSION: Record<string, FileKind> = {
  csv: "spreadsheet",
  tsv: "spreadsheet",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  ods: "spreadsheet",
  numbers: "spreadsheet",
  pdf: "document",
  doc: "document",
  docx: "document",
  odt: "document",
  rtf: "document",
  pages: "document",
  txt: "document",
  md: "document",
  markdown: "document",
  json: "document",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  tgz: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
  rar: "archive",
};

const BY_TYPE: Record<string, FileKind> = {
  "text/csv": "spreadsheet",
  "text/tab-separated-values": "spreadsheet",
  "application/vnd.ms-excel": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.oasis.opendocument.spreadsheet": "spreadsheet",
  "application/pdf": "document",
  "application/msword": "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.oasis.opendocument.text": "document",
  "application/rtf": "document",
  "application/json": "document",
  "application/zip": "archive",
  "application/x-zip-compressed": "archive",
  "application/x-tar": "archive",
  "application/gzip": "archive",
  "application/x-gzip": "archive",
  "application/x-7z-compressed": "archive",
  "application/x-bzip2": "archive",
  "application/x-xz": "archive",
  "application/vnd.rar": "archive",
};

export function fileKind(file: { name: string; mediaType: string }): FileKind {
  const type = file.mediaType.toLowerCase().split(";")[0]!.trim();
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  const known = BY_TYPE[type];
  if (known) return known;
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  if (extension && BY_EXTENSION[extension]) return BY_EXTENSION[extension]!;
  if (extension && /^(mp3|m4a|wav|ogg|oga|opus|flac|aac|aiff?)$/.test(extension)) return "audio";
  if (extension && /^(mp4|m4v|mov|webm|mkv|avi)$/.test(extension)) return "video";
  if (type.startsWith("text/")) return "document";
  return "other";
}

/** Whether a local file can be shown as a thumbnail in the composer before sending (never an SVG, and not HEIC/HEIF which non-Safari browsers can't decode). */
export function isPreviewableImage(file: { type?: string; mediaType?: string }): boolean {
  const type = (file.type ?? file.mediaType ?? "").toLowerCase().split(";")[0]!.trim();
  return type.startsWith("image/") && type !== "image/svg+xml" && type !== "image/heic" && type !== "image/heif";
}
