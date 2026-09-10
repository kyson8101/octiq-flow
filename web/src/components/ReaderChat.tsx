import { useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import "./ReaderChat.css";

export type ReaderChatSize = "closed" | "half" | "large";

/** Reuse the mounted conversation: changing portal targets would remount the
 * composer and lose its draft, attachments and pending agent questions. */
export function useReaderChat(open: boolean, path: string) {
  const [size, setSize] = useState<ReaderChatSize>("closed");
  const [chat, setChat] = useState<HTMLElement | null>(null);
  const startY = useRef<number | null>(null);
  const dragged = useRef(false);
  const returnRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => setSize("closed"), [path]);

  useLayoutEffect(() => {
    const dock = document.getElementById("dock");
    const main = dock?.querySelector<HTMLElement>(".main:not([hidden])");
    const shell = dock?.closest<HTMLElement>(".app");
    const phone = window.matchMedia("(max-width: 700px)");
    if (!dock || !main || !open) { setChat(null); return; }
    const originalInert = main.inert;
    const viewport = window.visualViewport;
    const fit = () => {
      if (phone.matches && viewport) {
        shell?.style.setProperty("--reader-viewport-height", `${viewport.height}px`);
      }
    };
    const sync = () => {
      setChat(phone.matches ? main : null);
      if (phone.matches) {
        dock.dataset.readerChat = size;
        shell?.classList.add("is-file-reading");
        main.inert = size === "closed";
        fit();
      } else {
        delete dock.dataset.readerChat;
        shell?.classList.remove("is-file-reading");
        main.inert = originalInert;
      }
    };
    sync();
    phone.addEventListener("change", sync);
    viewport?.addEventListener("resize", fit);
    return () => {
      phone.removeEventListener("change", sync);
      viewport?.removeEventListener("resize", fit);
      main.inert = originalInert;
      delete dock.dataset.readerChat;
      shell?.classList.remove("is-file-reading");
      shell?.style.removeProperty("--reader-viewport-height");
    };
  }, [open, size]);

  function show() {
    // The quote focuses the existing composer in the same user gesture. It
    // must already be visible and non-inert when iOS receives that focus.
    if (chat) flushSync(() => setSize("half"));
  }

  function collapse() {
    if (document.activeElement instanceof HTMLElement && chat?.contains(document.activeElement)) {
      document.activeElement.blur();
    }
    flushSync(() => setSize("closed"));
    returnRef.current?.focus({ preventScroll: true });
  }

  const controls = chat && size !== "closed" ? createPortal(
    <header className="reader-chat-head">
      <button
        className="reader-chat-resize"
        type="button"
        aria-label={size === "large" ? "Make chat smaller" : "Expand chat"}
        aria-expanded={size === "large"}
        onClick={() => {
          if (dragged.current) { dragged.current = false; return; }
          setSize(size === "large" ? "half" : "large");
        }}
        onPointerDown={(e) => {
          dragged.current = false;
          startY.current = e.clientY;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerUp={(e) => {
          const delta = e.clientY - (startY.current ?? e.clientY);
          startY.current = null;
          if (Math.abs(delta) < 30) return;
          dragged.current = true;
          // Prevent the synthetic click from toggling again after a drag.
          e.preventDefault();
          if (delta > 0) collapse();
          else setSize("large");
        }}
        onPointerCancel={() => { startY.current = null; }}
      ><span className="reader-chat-grip" />Chat</button>
      <button type="button" onClick={collapse}>Continue reading <span aria-hidden="true">⌄</span></button>
    </header>, chat,
  ) : null;

  const launcher = chat && size === "closed" ? (
    <button ref={returnRef} className="reader-chat-launch" type="button" onClick={show}>
      <span>Ask agent / discuss this file</span><span aria-hidden="true">⌃</span>
    </button>
  ) : null;

  return { show, collapse, size, controls, launcher };
}
