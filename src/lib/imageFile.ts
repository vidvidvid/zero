/**
 * Which files the editor shows as a picture instead of as text, and what to
 * call them when it does.
 *
 * The MIME type matters here in a way it usually doesn't: the bytes arrive over
 * IPC with no name attached, so the Blob's declared type is the only thing
 * telling WebKit how to decode them. Everything in this list is a format
 * WebKit decodes natively — including `.ico` and `.tiff`, which browsers built
 * on other engines generally don't, and `.heic`, which it gets from macOS.
 */
const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/vnd.microsoft.icon",
  cur: "image/vnd.microsoft.icon",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  // An SVG in an <img> is inert — no scripts, no external loads — which is the
  // only reason it can be treated as an image rather than as the document it is.
  svg: "image/svg+xml",
};

export function imageType(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? null;
}

export const isImage = (path: string) => imageType(path) !== null;

/** file size the way a file manager writes it */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}
