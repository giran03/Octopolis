// Turns a picture or short looping media file the user picked into a data URL fit to be a folder icon.
// Animated formats (GIF, APNG, animated WebP/AVIF) and short videos (WebM, MP4, MOV, OGG) keep their
// original bytes so animations play natively; static raster images are scaled to a 128px PNG.

export const ICON_PX = 128;
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 1_500_000;

const VIDEO_EXT = /\.(webm|mp4|m4v|mov|ogv|ogg)$/i;
const IMAGE_EXT = /\.(png|apng|jpe?g|gif|webp|avif|svg|ico|bmp)$/i;
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  apng: "image/apng",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  webm: "video/webm",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  ogv: "video/ogg",
  ogg: "video/ogg",
};

function mimeOf(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "";
}

/** Whether `file` is a supported picture or looping video for a folder icon. */
export const isImageFile = (file: File) => {
  const mime = mimeOf(file);
  return mime.startsWith("image/") || mime.startsWith("video/") || IMAGE_EXT.test(file.name) || VIDEO_EXT.test(file.name);
};

function readAsDataUrl(file: File, mimeOverride?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      let res = typeof reader.result === "string" ? reader.result : "";
      if (mimeOverride && res.startsWith("data:application/octet-stream;")) {
        res = `data:${mimeOverride};${res.slice("data:application/octet-stream;".length)}`;
      }
      if (!res) reject(new Error("Couldn't read that file."));
      else resolve(res);
    };
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

function hasAsciiTag(bytes: Uint8Array, tag: string): boolean {
  const codes = [...tag].map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - codes.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      if (bytes[i + j] !== codes[j]) continue outer;
    }
    return true;
  }
  return false;
}

async function isAnimatedOrVector(file: File, mime: string): Promise<boolean> {
  if (mime === "image/gif" || mime === "image/apng" || mime === "image/svg+xml") return true;
  if (mime === "image/png" || mime === "image/webp" || mime === "image/avif") {
    const slice = new Uint8Array(await file.slice(0, 65_536).arrayBuffer());
    if (mime === "image/png") return hasAsciiTag(slice, "acTL");
    if (mime === "image/webp") return hasAsciiTag(slice, "ANIM");
    if (mime === "image/avif") return hasAsciiTag(slice, "mvex") || hasAsciiTag(slice, "avis");
  }
  return false;
}

/**
 * Converts `file` into a data URL for `folderIcons.addImage`.
 * Animated images and videos are preserved as-is; static images are scaled to ICON_PX PNG.
 */
export async function fileToIconDataUrl(file: File): Promise<string> {
  if (!isImageFile(file)) throw new Error("That file isn't a supported image or video.");
  const mime = mimeOf(file);

  if (mime.startsWith("video/") || VIDEO_EXT.test(file.name)) {
    if (file.size > MAX_MEDIA_BYTES) throw new Error("Video icons must be 1.5 MB or smaller.");
    return readAsDataUrl(file, mime);
  }

  if (await isAnimatedOrVector(file, mime)) {
    if (file.size > MAX_MEDIA_BYTES) throw new Error("Animated or vector icons must be 1.5 MB or smaller.");
    return readAsDataUrl(file, mime);
  }

  if (file.size > MAX_SOURCE_BYTES) throw new Error("That picture is larger than 10 MB.");
  const blobUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = blobUrl;
    await img.decode().catch(() => {
      throw new Error("Couldn't read that picture.");
    });
    const w = img.naturalWidth || ICON_PX;
    const h = img.naturalHeight || ICON_PX;
    const scale = Math.min(ICON_PX / w, ICON_PX / h);
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = ICON_PX;
    canvas.height = ICON_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't read that picture.");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, Math.round((ICON_PX - dw) / 2), Math.round((ICON_PX - dh) / 2), dw, dh);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}
