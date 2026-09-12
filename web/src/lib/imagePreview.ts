import { useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { recall, remember } from "./remember";

export type ImagePreview = { id: string; kind?: "image" | "html"; slot: string; title: string; path: string; createdAt: number };
export type PreviewSlot = { slot: string; versions: ImagePreview[] };
export function previewSlots(images: ImagePreview[]): PreviewSlot[] {
  const slots = new Map<string, PreviewSlot>();
  for (const image of images) {
    if (!slots.has(image.slot)) slots.set(image.slot, { slot: image.slot, versions: [] });
    slots.get(image.slot)!.versions.push(image);
  }
  return [...slots.values()];
}

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
  const current = state.key === key ? state : { key, images: [], error: "", open: false };
  function setOpen(open: boolean) {
    openedOnce.current.add(key);
    remember(preferenceKey(key), open ? "1" : "0");
    setState(old => ({ ...(old.key === key ? old : current), open }));
  }
  return { ...current, setOpen };
}
