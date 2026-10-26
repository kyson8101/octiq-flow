export const PASTE_FILE_CHARS = 4000;
export const PASTE_FILE_LINES = 80;

export type PastedText = { text: string; lines: number };

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
