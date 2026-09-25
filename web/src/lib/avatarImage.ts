// Turning a picture into an agent avatar: a small square, the same way every
// time, whether it was uploaded or generated.
//
// The browser does the resizing because it already can: a 1254px PNG from the
// generator, or a phone photo, becomes a 256px WebP of a few tens of KB before
// it is stored. The server still checks what arrives (`agent_avatar.rs`):
// this is for size, not for trust.

export const AVATAR_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** What an upload may be before it is shrunk. */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
/** What the server stores (its own cap is 512 KB of data URL). */
export const MAX_AVATAR_CHARS = 500 * 1024;
const SIDE = 256;

/** Why a chosen file cannot be an avatar, or null when it can be tried. */
export function uploadProblem(file: { type: string; size: number }): string | null {
  if (!(AVATAR_TYPES as readonly string[]).includes(file.type)) {
    return "Choose a PNG, JPEG or WebP image.";
  }
  if (file.size > MAX_UPLOAD_BYTES) return "That image is larger than 8 MB.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

/** The largest centred square of a `width`×`height` picture. */
export function centreSquare(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height);
  return { sx: Math.round((width - side) / 2), sy: Math.round((height - side) / 2), side };
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The image could not be read."));
    image.src = src;
  });
}

function readFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

/** A file or a data URL, as a 256px square avatar data URL. */
export async function toAvatar(source: Blob | string): Promise<string> {
  const src = typeof source === "string" ? source : await readFile(source);
  const image = await load(src);
  const { sx, sy, side } = centreSquare(image.naturalWidth, image.naturalHeight);
  if (!side) throw new Error("The image has no size.");
  const canvas = document.createElement("canvas");
  canvas.width = SIDE;
  canvas.height = SIDE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser cannot resize images.");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, sx, sy, side, side, 0, 0, SIDE, SIDE);
  // WebP where the browser can write it; PNG otherwise (older Safari).
  let url = canvas.toDataURL("image/webp", 0.9);
  if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/png");
  if (url.length > MAX_AVATAR_CHARS) url = canvas.toDataURL("image/jpeg", 0.85);
  if (url.length > MAX_AVATAR_CHARS) throw new Error("The avatar is still too large after resizing.");
  return url;
}
