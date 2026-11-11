import { useEffect, useRef, useState } from "react";
import { ActionIcon } from "./ActionIcon";
import { createPortal } from "react-dom";
import type { LeadHistoryEntry } from "../lib/leadThreads";
import { readLeadHistory } from "../lib/leadThreadFeed";
import { chatTime } from "./Sidebar";
import "./LeadThreads.css";

export function LeadHistoryList({ entries, onOpen }: { entries: readonly LeadHistoryEntry[]; onOpen: (entry: LeadHistoryEntry) => void }) {
  return <ul className="lead-history-list">{entries.map(entry => <li key={entry.chatKey}>
    <button type="button" onClick={() => onOpen(entry)}><span className="lead-history-title">{entry.title}</span>
      <time dateTime={new Date(entry.updatedAt).toISOString()}>{chatTime(entry.updatedAt)}</time>
      <span className="lead-history-done" aria-label={entry.done ? "Done" : undefined}>{entry.done ? "✓" : ""}</span>
    </button>
  </li>)}</ul>;
}

export function LeadHistoryButton({ onClick }: { onClick: () => void }) {
  return <button className="icon-btn" type="button" aria-label="Open lead history" title="Open lead history" aria-haspopup="dialog" onClick={onClick} data-icon-action>
    <ActionIcon name="history" />
  </button>;
}

/** Owned outside ActionBar: a control behind More unmounts as soon as pressed. */
export function LeadHistoryPanel({ agentId, onOpen, onClose }: { agentId: string; onOpen: (entry: LeadHistoryEntry) => void; onClose: () => void }) {
  const [entries, setEntries] = useState<LeadHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    let alive = true;
    void readLeadHistory(agentId).then(rows => { if (alive) setEntries(rows); }, reason => {
      if (alive) setError(String((reason as Error).message ?? reason));
    });
    return () => { alive = false; };
  }, [agentId]);
  return createPortal(<dialog ref={dialog} className="lead-history-panel" aria-label="Lead history" onCancel={onClose} onClick={event => { if (event.target === dialog.current) onClose(); }}>
    <header><h2>History</h2><button type="button" onClick={onClose} aria-label="Close lead history" data-icon-action title="Close lead history">
      <ActionIcon name="cancel" />
    </button></header>
    {error ? <p role="alert">{error}</p> : entries === null ? <p role="status">Loading history…</p> : entries.length === 0 ? <p>No earlier chats.</p>
      : <LeadHistoryList entries={entries} onOpen={entry => { onClose(); onOpen(entry); }} />}
  </dialog>, document.body);
}
