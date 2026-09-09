import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { createPortal } from "react-dom";
import type { Message } from "../lib/chat";
import type { Conversation } from "../lib/store";
import { previewMessages } from "../lib/chatPreview";
import "./ChatPreviewButton.css";

export type ChatPreviewSource = {
  getPreviewMessages?: (id: string) => Message[] | undefined;
  loadPreview?: (chat: Conversation, cancelled: () => boolean) => Promise<Message[]>;
};

export function ChatPreviewButton({ chat, enabled, busy, getPreviewMessages, loadPreview, ...props }:
  ComponentProps<"button"> & ChatPreviewSource & { chat: Conversation; enabled: boolean; busy: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const id = useId();
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; };
  const close = () => { clear(); setOpen(false); };
  const enter = () => {
    clear();
    if (enabled) timer.current = setTimeout(() => setOpen(true), 1500);
  };
  const leave = () => { clear(); timer.current = setTimeout(() => setOpen(false), 160); };
  useEffect(() => {
    if (!enabled) { clearTimeout(timer.current); setOpen(false); }
    return () => clearTimeout(timer.current);
  }, [enabled]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    if (open) document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [open]);

  return <>
    <button {...props} ref={anchor} aria-describedby={open && enabled ? id : undefined}
      onPointerEnter={event => { if (event.pointerType === "mouse") enter(); }}
      onPointerLeave={leave}
      onFocus={event => { if (event.currentTarget.matches(":focus-visible")) enter(); }}
      onBlur={close}
      onClick={event => { close(); props.onClick?.(event); }}
    />
    {open && enabled && <ChatPreview key={chat.id} id={id} chat={chat} anchor={anchor.current!}
      messages={getPreviewMessages?.(chat.id)} loadPreview={loadPreview} busy={busy}
      onEnter={clear} onLeave={leave} onClose={close} />}
  </>;
}

function ChatPreview({ id, chat, anchor, messages, loadPreview, busy, onEnter, onLeave, onClose }: {
  id: string; chat: Conversation; anchor: HTMLButtonElement; messages?: Message[];
  loadPreview: ChatPreviewSource["loadPreview"]; busy: boolean;
  onEnter: () => void; onLeave: () => void; onClose: () => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(chat.messages);
  const [status, setStatus] = useState(messages === undefined && loadPreview ? "loading" : "ready");
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const hasLive = messages !== undefined;
  useEffect(() => {
    if (hasLive || !loadPreview) { setStatus("ready"); return; }
    let cancelled = false;
    setStatus("loading");
    const timeout = setTimeout(() => { cancelled = true; setStatus("error"); }, 8000);
    void loadPreview(chat, () => cancelled).then(next => {
      if (!cancelled) { setLoaded(next); setStatus("ready"); }
    }).catch(() => { if (!cancelled) setStatus("error"); })
      .finally(() => clearTimeout(timeout));
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [chat.id, hasLive, loadPreview]);

  useLayoutEffect(() => {
    const place = () => {
      const row = (anchor.closest(".chat") ?? anchor).getBoundingClientRect();
      const box = panel.current!.getBoundingClientRect();
      const right = row.right + 12;
      const left = right + box.width <= window.innerWidth - 12 ? right : row.left - box.width - 12;
      setPosition({
        left: Math.max(12, Math.min(left, window.innerWidth - box.width - 12)),
        top: Math.max(12, Math.min(row.top, window.innerHeight - box.height - 12)),
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel.current!);
    window.addEventListener("resize", onClose);
    // A scrolled-away row must not leave its preview floating over another chat.
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("scroll", scroll, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onClose);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [anchor, onClose]);

  const snippets = previewMessages(messages ?? loaded);
  return createPortal(<div ref={panel} id={id} role="tooltip" className="chat-preview" style={position}
    onPointerEnter={onEnter} onPointerLeave={onLeave}>
    <div className="chat-preview-head"><strong>{chat.title}</strong>{busy && <span>Working…</span>}</div>
    <div className="chat-preview-label">Latest conversation</div>
    {snippets.map(message => <div className="chat-preview-message" key={message.id}>
      <span>{message.speaker}</span><p>{message.text}</p>
    </div>)}
    {status === "loading" && <p className="chat-preview-note">Loading latest messages…</p>}
    {status === "error" && <p className="chat-preview-note">Preview unavailable. Open the chat to try again.</p>}
    {status === "ready" && !snippets.length && <p className="chat-preview-note">No messages yet.</p>}
    <div className="chat-preview-foot">Click chat to open · Double-click to rename</div>
  </div>, document.body);
}
