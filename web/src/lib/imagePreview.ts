import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { recall, remember } from "./remember";

export type ImagePreview = { id: string; kind?: "image" | "html"; slot: string; title: string; path: string; createdAt: number };
export type PreviewSlot = { slot: string; versions: ImagePreview[] };
/** Slots newest first, by each slot's latest version; versions stay oldest →
 *  newest. The backend lists images oldest first, so a tie on `createdAt`
 *  goes to the slot whose latest version came later in that list. */
export function previewSlots(images: ImagePreview[]): PreviewSlot[] {
  const slots = new Map<string, PreviewSlot & { last: number }>();
  images.forEach((image, i) => {
    if (!slots.has(image.slot)) slots.set(image.slot, { slot: image.slot, versions: [], last: i });
    const slot = slots.get(image.slot)!;
    slot.versions.push(image);
    slot.last = i;
  });
  return [...slots.values()]
    .sort((a, b) => (b.versions.at(-1)!.createdAt - a.versions.at(-1)!.createdAt) || b.last - a.last)
    .map(({ slot, versions }) => ({ slot, versions }));
}

/** Snapshots are immutable — a new version is a new file named by its id — so
 *  a fetched one is good forever. Without this every panel open, chat switch
 *  and thumbnail re-downloaded every full-size image. Bounded by bytes; the
 *  least recently used go first. */
const FILE_CACHE_BYTES = 96 * 1024 * 1024;
type CachedFile = { blob: Promise<Blob>; size: number; url?: string };
const files = new Map<string, CachedFile>();

function evict() {
  let total = 0;
  for (const entry of files.values()) total += entry.size;
  for (const [path, entry] of files) {
    if (total <= FILE_CACHE_BYTES || files.size <= 1) break;
    files.delete(path);
    total -= entry.size;
    if (entry.url) URL.revokeObjectURL(entry.url);
  }
}

function cachedFile(path: string): CachedFile {
  let entry = files.get(path);
  if (entry) { files.delete(path); files.set(path, entry); return entry; }
  const fresh: CachedFile = { size: 0, blob: bridge.fetchFile(path) };
  fresh.blob.then(blob => { fresh.size = blob.size; evict(); }, () => files.delete(path));
  files.set(path, fresh);
  return fresh;
}

export const previewBlob = (path: string): Promise<Blob> => cachedFile(path).blob;

export async function previewObjectUrl(path: string): Promise<string> {
  const entry = cachedFile(path);
  const blob = await entry.blob;
  entry.url ??= URL.createObjectURL(blob);
  return entry.url;
}

/** The URL already made for `path`, so a remount paints in the first frame. */
export const readyObjectUrl = (path: string): string => files.get(path)?.url ?? "";

/** The last list each chat returned, so coming back to a chat shows its
 *  previews at once while the refresh runs behind them. */
const lists = new Map<string, ImagePreview[]>();

const preferenceKey = (key: string) => `octiq.preview.${key}.open`;
type State = { key: string; images: ImagePreview[]; error: string; open: boolean };
export function useImagePreviews(key: string, busy: boolean) {
  const openedOnce = useRef(new Set<string>());
  const [state, setState] = useState<State>({ key: "", images: [], error: "", open: false });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    let pending = false;
    async function refresh() {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const images = await bridge.invoke<ImagePreview[]>("image_preview_list", { key });
        if (!alive) return;
        lists.set(key, images);
        const pref = recall(preferenceKey(key));
        const first = pref === null && images.length > 0 && !openedOnce.current.has(key);
        if (first) {
          openedOnce.current.add(key);
          remember(preferenceKey(key), "1");
        }
        setState(old => {
          const open = old.key === key ? old.open : pref === "1";
          if (old.key === key && !old.error && !first && old.images.length === images.length && old.images.every((image, i) => image.id === images[i].id)) return old;
          return { key, images, error: "", open: first || open };
        });
      } catch (e) {
        if (alive) setState(old => ({ key, images: old.key === key ? old.images : [], open: old.key === key ? old.open : recall(preferenceKey(key)) === "1", error: e instanceof Error ? e.message : "Previews could not be loaded." }));
      } finally { pending = false; }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), busy ? 1200 : 8000);
    document.addEventListener("visibilitychange", refresh);
    return () => { alive = false; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [key, busy]);
  const current = state.key === key ? state
    : { key, images: lists.get(key) ?? [], error: "", open: !!key && recall(preferenceKey(key)) === "1" };
  function setOpen(open: boolean) {
    openedOnce.current.add(key);
    remember(preferenceKey(key), open ? "1" : "0");
    setState(old => ({ ...(old.key === key ? old : current), open }));
  }
  return { ...current, setOpen };
}
