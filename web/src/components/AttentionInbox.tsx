import { useEffect, useId, useRef, useState } from "react";
import type { AttentionEntry } from "../lib/attention";
import type { Conversation } from "../lib/store";
import "./AttentionInbox.css";

export type AttentionInboxProps = {
  entries: readonly AttentionEntry[];
  connected: boolean;
  onOpen: (conversation: Conversation) => void;
};

/** Separate from the disclosure so the readable panel can also be rendered
 * in a larger surface without duplicating its navigation or empty state. */
export function AttentionInboxPanel({ entries, connected, onOpen }: AttentionInboxProps) {
  return <>
    <h2>Needs your attention</h2>
    {!connected && <p className="attention-note" role="status">Disconnected. Live requests will update after reconnecting.</p>}
    {entries.length === 0
      ? <p className="attention-note">No known items need attention. Unopened history is not checked.</p>
      : <ul className="attention-list">{entries.map((entry) => (
        <li key={entry.conversation.id} className={`attention-row attention-${entry.kind}`}>
          <button type="button" className="attention-open" onClick={() => onOpen(entry.conversation)}>
            <span className="attention-project">{entry.projectName}</span>
            <span className="attention-title">{entry.conversation.title || "Untitled chat"}</span>
            <span className="attention-reason">{entry.reason}{entry.stale ? " · last known" : ""}</span>
          </button>
        </li>
      ))}</ul>}
  </>;
}

export function AttentionInbox(props: AttentionInboxProps) {
  return props.entries.length > 0 ? <AttentionInboxDisclosure {...props} /> : null;
}

function AttentionInboxDisclosure(props: AttentionInboxProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="attention-inbox" ref={root} onKeyDown={(event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  }}>
    <button ref={trigger} type="button" className="attention-trigger"
      aria-label={`Attention inbox, ${props.entries.length} ${props.entries.length === 1 ? "item" : "items"}`}
      aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 4h16v16H4zM4 14h5l1 3h4l1-3h5" /></svg>
      <span>Attention</span>
      {props.entries.length > 0 && <span className="attention-count">{props.entries.length}</span>}
    </button>
    {open && <section id={panelId} className="attention-panel" aria-label="Attention inbox">
      <AttentionInboxPanel {...props} onOpen={(conversation) => { setOpen(false); props.onOpen(conversation); }} />
    </section>}
  </div>;
}
