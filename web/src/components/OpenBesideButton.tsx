import { useEffect, useRef, useState } from "react";
import { openBeside } from "../lib/chatLayout";
import type { Conversation } from "../lib/store";
import type { Project } from "./Sidebar";
import "./ChatLayout.css";

export function SplitIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>;
}
export function OpenBesideButton({ chats, projects, current }: { chats: Conversation[]; projects: Project[]; current: string }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const choices = chats.filter(chat => chat.id !== current).map(chat => ({ chat, project: projects.find(project => project.id === chat.projectId)?.name ?? "Unknown project" }))
    .filter(({ chat, project }) => `${project} ${chat.title}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <button type="button" className="icon-btn open-beside-trigger" title="Open chat beside" aria-label="Open chat beside" onClick={() => { setQuery(""); setOpen(true); }}><SplitIcon/><span className="topbar-action-label">Open beside</span></button>
    {open && <dialog ref={dialog} className="beside-picker" aria-label="Open chat beside" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header><strong>Open chat beside</strong><button type="button" onClick={() => setOpen(false)} aria-label="Close chat picker">×</button></header>
      <input autoFocus placeholder="Search chats and projects…" aria-label="Search chats and projects" value={query} onChange={event => setQuery(event.target.value)}/>
      <div className="beside-picker-list">{choices.map(({ chat, project }) => <button type="button" key={chat.id} onClick={() => { openBeside(chat.id); setOpen(false); }}><small>{project}</small>{chat.title}</button>)}{choices.length === 0 && <p>No other chats found.</p>}</div>
    </dialog>}
  </>;
}
