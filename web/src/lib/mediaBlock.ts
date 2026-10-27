// One local media file beside the words explaining it. Untrusted JSON stays
// text; only a closed, whole, valid fence becomes a reply block.
import { isAudio, isImage, isVideo } from "./files";
import type { MediaKind } from "./questionMedia";

export const MEDIA_LANG = "octiq-media";
export const MEDIA_LIMITS = { title: 80, text: 1_200, caption: 120, path: 4_096, source: 16_000 } as const;
export type MediaBlockData = { path: string; kind: MediaKind; title?: string; text: string; caption?: string };

const KEYS = new Set(["path", "kind", "title", "text", "caption"]);
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
function words(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit * 2 && [...value].length <= limit && !controls.test(value);
}

/** String fields already written, including the current value's safe prefix.
 * Only used for unseen height reservation, never to repair a reply block. */
function fields(source: string) {
  const values: Record<string, string> = {};
  const keys = new Set<string>();
  let duplicate = false;
  let depth = 0;
  let key: string | null = null;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{" || char === "[") { depth++; continue; }
    if (char === "}" || char === "]") { depth--; continue; }
    if (char !== '"') continue;
    const start = i++;
    let safeEnd = i;
    for (; i < source.length; i++) {
      if (source[i] === '"') break;
      if (source[i] === "\\") {
        const width = source[i + 1] === "u" ? 6 : 2;
        if (i + width > source.length) { i = source.length; break; }
        i += width - 1;
      }
      safeEnd = i + 1;
    }
    if (depth !== 1) continue;
    let value: string;
    try { value = JSON.parse(source.slice(start, safeEnd) + '"'); } catch { continue; }
    if (source.slice(i + 1).trimStart().startsWith(":")) {
      key = value;
      if (keys.has(key)) duplicate = true;
      keys.add(key);
    } else if (key !== null) {
      values[key] = value;
      key = null;
    }
  }
  return { values, duplicate };
}

export function parseMediaBlock(source: string): MediaBlockData | null {
  if (typeof source !== "string" || source.length > MEDIA_LIMITS.source) return null;
  let raw: unknown;
  try { raw = JSON.parse(source); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const bag = raw as Record<string, unknown>;
  if (Object.keys(bag).some((key) => !KEYS.has(key)) || fields(source).duplicate) return null;
  if (!words(bag.path, MEDIA_LIMITS.path) || /[\r\n\t]/.test(bag.path)) return null;
  // POSIX, Windows drive and UNC paths; never a URL, relative path or file URI.
  if (!/^(?:\/(?!\/)|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(bag.path)) return null;
  const kind = isImage(bag.path) ? "image" : isVideo(bag.path) ? "video" : isAudio(bag.path) ? "audio" : null;
  if (!kind || (bag.kind !== undefined && bag.kind !== kind)) return null;
  if (!words(bag.text, MEDIA_LIMITS.text) || !bag.text.trim()) return null;
  for (const name of ["title", "caption"] as const) {
    if (bag[name] !== undefined && !words(bag[name], MEDIA_LIMITS[name])) return null;
  }
  return { path: bag.path, kind, text: bag.text,
    ...(bag.title !== undefined ? { title: bag.title as string } : {}),
    ...(bag.caption !== undefined ? { caption: bag.caption as string } : {}) };
}

export function mediaFence(block: string): { body: string; closed: boolean } | null {
  const first = block.charCodeAt(0);
  if (first !== 96 && first !== 126 && first !== 32) return null;
  const lines = block.split("\n");
  const open = /^ {0,3}(`{3,}|~{3,})[ \t]*octiq-media[ \t]*\r?$/.exec(lines[0]);
  if (!open) return null;
  for (let i = 1; i < lines.length; i++) {
    const close = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(lines[i]);
    if (close && close[1][0] === open[1][0] && close[1].length >= open[1].length) {
      if (lines.slice(i + 1).some((line) => line.trim())) return null;
      return { body: lines.slice(1, i).join("\n"), closed: true };
    }
  }
  return { body: lines.slice(1).join("\n"), closed: false };
}

export function partialMedia(body: string): MediaBlockData | null {
  if (body.length > MEDIA_LIMITS.source) return null;
  const { values, duplicate } = fields(body);
  if (duplicate || Object.keys(values).some((key) => !KEYS.has(key))) return null;
  return parseMediaBlock(JSON.stringify({ path: "/media.png", ...values, text: values.text?.trim() ? values.text : "…" }));
}

export function mediaBlock(block: string, writing: boolean):
  { kind: "media"; media: MediaBlockData } | { kind: "pending"; media: MediaBlockData | null } | null {
  const fence = mediaFence(block);
  if (!fence) return null;
  if (fence.closed) {
    const media = parseMediaBlock(fence.body);
    return media ? { kind: "media", media } : null;
  }
  return writing ? { kind: "pending", media: partialMedia(fence.body) } : null;
}
