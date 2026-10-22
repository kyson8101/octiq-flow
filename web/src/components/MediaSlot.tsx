// Where a player's element is drawn. The element is `lib/nowPlaying`'s, not
// React's, so it can leave with the person when they go to another chat and
// come back still playing; this is the span it is put into while its chat is
// on screen.
import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { nowPlaying, type MediaKind, type MediaLike, type MediaSource } from "../lib/nowPlaying";

/** Which chat a transcript is (`MessageList`): the chat its players belong to.
 *  Null outside a chat, where a player never floats. */
export const MediaChatContext = createContext<string | null>(null);
export const MediaReplyContext = createContext("");

export const useMediaChat = () => useContext(MediaChatContext);
export const useMediaReply = () => useContext(MediaReplyContext);

/** Whether the store holds this chat's file detached, so its slot should be
 *  drawn now rather than wait to be near the screen. */
export function useHeldMedia(chat: string | null, path: string, reply: string) {
  return useSyncExternalStore(nowPlaying.subscribe, () => nowPlaying.holds(chat, path, reply), () => false);
}

/** A new player element, as the browser's own controls draw it. Pointed at
 *  `/file` directly so it streams in ranges; `preload="metadata"` asks for the
 *  length and the first frame, not the whole file. */
export function createMedia(kind: MediaKind, url: string, label: string): HTMLMediaElement {
  const el = document.createElement(kind);
  el.src = url;
  el.controls = true;
  el.preload = "metadata";
  el.setAttribute("aria-label", label);
  if (kind === "video") (el as HTMLVideoElement).playsInline = true;
  return el;
}

/** The slot's ref. `bind` is called with each element the slot is given (its
 *  own, or the one coming back from another chat) and returns its unbind. */
export function useMediaSlot<E extends HTMLMediaElement>(source: MediaSource, url: string, bind: (el: E) => () => void) {
  const holder = useRef<HTMLSpanElement>(null);
  const latest = useRef({ source, url, bind });
  latest.current = { source, url, bind };
  const { chat, reply, path, kind, name } = source;
  useLayoutEffect(() => {
    const slot = holder.current;
    if (!slot) return;
    return nowPlaying.mount(
      slot,
      { chat, reply, path, kind, name },
      () => createMedia(kind, latest.current.url, name) as unknown as MediaLike,
      (el) => latest.current.bind(el as unknown as E),
    );
  }, [chat, reply, path, kind, name]);
  return holder;
}
