export const PASTE_FILE_CHARS = 4000;
export const PASTE_FILE_LINES = 80;
export const PASTE_FILE_MAX_BYTES = 12 * 1024 * 1024;

export type PastedText = { text: string; lines: number };

/** Check UTF-8 bytes before upload or inline fallback. An oversized paste
 *  cannot become an attachment, and putting it in a textarea can freeze it. */
export function pastedTextSizeError(text: string): string | null {
  // Every UTF-16 code unit needs at most three UTF-8 bytes.
  if (text.length <= PASTE_FILE_MAX_BYTES / 3) return null;
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes <= PASTE_FILE_MAX_BYTES) return null;
  return `This paste is ${(bytes / (1024 * 1024)).toFixed(1)} MB, over the 12 MB limit for a pasted file. Nothing was added; it is still on your clipboard.`;
}

export function pastedTextLines(text: string): number {
  return text.split(/\r\n|\r|\n/).length;
}

/** Count code points, so an emoji does not use two characters of the limit. */
export function shouldSaveAsFile(text: string): boolean {
  if (pastedTextLines(text) >= PASTE_FILE_LINES) return true;
  let characters = 0;
  for (const _character of text) {
    if (++characters >= PASTE_FILE_CHARS) return true;
  }
  return false;
}

export function pastedTextName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `pasted-text-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;
}

export function pastedTextLabel(text: string): string {
  const lines = pastedTextLines(text);
  return `Pasted text · ${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"}`;
}
