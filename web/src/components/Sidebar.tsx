// Task-first navigation: one global list of chats, with project as context.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type React from "react";
import { latestResponse } from "../lib/chatPreview";
import { projectColor } from "../lib/projectColor";
import type { Conversation } from "../lib/store";
import { DeleteCountdownIcon } from "./ChatDeleteButton";
import { ChatPreviewButton, type ChatPreviewSource } from "./ChatPreviewButton";
import { SidebarMenu } from "./SidebarMenu";
import "./MobileSidebar.css";

export type Project = {
  id: string;
  name: string;
  color?: string;
  primary_path?: string;
  sibling_ids?: string[];
  env?: Record<string, string>;
};

const NONE: ReadonlySet<string> = new Set();

export function Sidebar({
  projects, shelved, onShowShelved, deletedCount = 0, onShowDeleted,
  conversations, currentConversation, running, busy, deleting = NONE,
  leaving = NONE, deleteMs = 2000, onPickConversation, getPreviewMessages,
  loadPreview, onNewChat, onDelete, onPin, onRename, onSettings,
  onNewProject, onHide, onResize, foot,
}: {
  projects: Project[];
  shelved: Project[];
  onShowShelved: () => void;
  deletedCount?: number;
  onShowDeleted?: () => void;
  conversations: Conversation[];
  currentConversation: string | null;
  running: Set<string>;
  busy: Set<string>;
  deleting?: ReadonlySet<string>;
  leaving?: ReadonlySet<string>;
  deleteMs?: number;
  onPickConversation: (chat: Conversation) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onSettings: (projectId: string) => void;
  onNewProject: () => void;
  onHide?: () => void;
  onResize?: (event: React.PointerEvent<HTMLElement>) => void;
  foot?: ReactNode;
} & ChatPreviewSource) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [actionsId, setActionsId] = useState<string | null>(null);
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdStart = useRef({ x: 0, y: 0 });
  const held = useRef(false);
  const seenChatIds = useRef<ReadonlySet<string>>(new Set(conversations.map((chat) => chat.id)));
  const knownProjects = [...projects, ...shelved];
  const projectById = new Map(knownProjects.map((project) => [project.id, project]));

  useEffect(() => { seenChatIds.current = new Set(conversations.map((chat) => chat.id)); }, [conversations]);
  useEffect(() => () => clearTimeout(hold.current), []);
  const cancelHold = () => clearTimeout(hold.current);

  return (
    <nav className="sidebar task-sidebar" aria-label="Chats">
      <div className="sidebar-toolbar">
        <div className="sidebar-head">
          <span className="sidebar-title">Chats</span>
          <button className="sidebar-new-chat" type="button" onClick={onNewChat}>
            <PlusIcon /><span>New chat</span>
          </button>
          <SidebarMenu
            label="Chat list actions"
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={[
              { id: "new-project", label: "New project", icon: <PlusIcon />, onSelect: onNewProject },
              ...projects.map((project) => ({
                id: `settings-${project.id}`,
                label: `Project settings: ${project.name}`,
                icon: <GearIcon />,
                onSelect: () => onSettings(project.id),
              })),
              ...(shelved.length ? [{ id: "shelved", label: `Shelved projects (${shelved.length})`, icon: <ArchiveIcon />, onSelect: onShowShelved }] : []),
              ...(deletedCount && onShowDeleted ? [{ id: "trash", label: `Deleted chats (${deletedCount})`, icon: <TrashIcon />, onSelect: onShowDeleted }] : []),
              ...(onHide ? [{ id: "hide", label: "Hide chats", icon: <CollapseIcon />, onSelect: onHide }] : []),
            ]}
          />
        </div>
      </div>

      {conversations.length ? (
        <ul className="chat-list task-chat-list">
          {conversations.map((chat) => {
            const going = deleting.has(chat.id);
            const isLeaving = leaving.has(chat.id);
            const project = projectById.get(chat.projectId);
            const projectName = project?.name ?? "Unknown project";
            const latest = latestResponse(getPreviewMessages?.(chat.id) ?? chat.messages);
            const snippet = going ? "Deleting…"
              : latest?.text ?? chat.latestResponse ?? (busy.has(chat.id) ? "Working…" : "No response yet");

            return (
              <AnimatedChatRow entering={!seenChatIds.current.has(chat.id)} leaving={isLeaving} key={chat.id}>
                <div className={[
                  "chat", chat.id === currentConversation ? "is-on" : "",
                  running.has(chat.id) ? "is-live" : "", busy.has(chat.id) ? "is-busy" : "",
                  going ? "is-going" : "", isLeaving ? "is-leaving" : "",
                  chat.pinned ? "is-pinned" : "", renaming === chat.id ? "is-renaming" : "",
                ].filter(Boolean).join(" ")}>
                  {renaming === chat.id ? (
                    <form className="chat-rename" onSubmit={(event) => {
                      event.preventDefault();
                      const input = event.currentTarget.elements.namedItem("chat-title");
                      if (input instanceof HTMLInputElement && input.value.trim()) onRename(chat.id, input.value);
                      setRenaming(null);
                    }}>
                      <input name="chat-title" className="chat-rename-input" defaultValue={chat.title}
                        aria-label="Chat title" maxLength={48} autoFocus
                        onFocus={(event) => event.currentTarget.select()}
                        onBlur={(event) => {
                          if (event.currentTarget.value.trim()) onRename(chat.id, event.currentTarget.value);
                          setRenaming(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== "Escape") return;
                          event.preventDefault(); setRenaming(null);
                        }} />
                    </form>
                  ) : (
                    <ChatPreviewButton chat={chat} enabled={!going && !isLeaving && !actionsId}
                      busy={busy.has(chat.id)} getPreviewMessages={getPreviewMessages} loadPreview={loadPreview}
                      className="chat-btn" type="button" aria-label={`${chat.title}, ${projectName}`}
                      disabled={isLeaving} aria-current={chat.id === currentConversation ? "page" : undefined}
                      aria-description="Hover to preview. Hold for chat actions."
                      onPointerDown={(event) => {
                        cancelHold(); held.current = false;
                        if (event.pointerType === "mouse" || going || isLeaving || !window.matchMedia("(max-width: 859.98px), (pointer: coarse)").matches) return;
                        holdStart.current = { x: event.clientX, y: event.clientY };
                        hold.current = setTimeout(() => { held.current = true; setActionsId(chat.id); }, 500);
                      }}
                      onPointerMove={(event) => {
                        if (Math.hypot(event.clientX - holdStart.current.x, event.clientY - holdStart.current.y) > 10) cancelHold();
                      }}
                      onPointerUp={cancelHold} onPointerCancel={cancelHold}
                      onContextMenu={(event) => {
                        if (!window.matchMedia("(max-width: 859.98px), (pointer: coarse)").matches) return;
                        event.preventDefault(); cancelHold();
                        if (!going && !isLeaving) setActionsId(chat.id);
                      }}
                      onClick={() => {
                        if (held.current) { held.current = false; return; }
                        onPickConversation(chat);
                      }}>
                      <span className="chat-summary">
                        <span className="chat-heading">
                          <span className="chat-title">{chat.title}</span>
                          <time className="chat-time" dateTime={new Date(chat.updatedAt).toISOString()} title={new Date(chat.updatedAt).toLocaleString()}>{chatTime(chat.updatedAt)}</time>
                        </span>
                        <span className="chat-snippet">{snippet.replace(/\s+/g, " ")}</span>
                        <span className="chat-project">
                          <span className="chat-project-dot" style={{ background: project ? projectColor(project) : undefined }} aria-hidden="true" />
                          {projectName}
                        </span>
                      </span>
                    </ChatPreviewButton>
                  )}

                  <span className="chat-indicators">
                    {chat.pinned && <span className="chat-mobile-pin" title="Pinned" aria-label="Pinned"><PinIcon /></span>}
                    <span className="chat-mark" aria-hidden="true" title={busy.has(chat.id) ? "working" : running.has(chat.id) ? "session running" : undefined} />
                  </span>
                  {renaming !== chat.id && <SidebarMenu className="chat-actions-trigger"
                    label={`Actions for ${chat.title}`} open={actionsId === chat.id}
                    onOpenChange={(open) => setActionsId(open ? chat.id : null)} disabled={isLeaving}
                    icon={going ? <DeleteCountdownIcon ms={deleteMs} /> : undefined}
                    items={[
                      { id: "rename", label: "Rename chat", icon: <PencilIcon />, disabled: going, onSelect: () => setRenaming(chat.id) },
                      { id: "pin", label: chat.pinned ? "Unpin chat" : "Pin chat", icon: <PinIcon />, disabled: going, onSelect: () => onPin(chat.id) },
                      { id: "project", label: `Project settings: ${projectName}`, icon: <GearIcon />, disabled: going || !project, onSelect: () => onSettings(chat.projectId) },
                      { id: "delete", label: going ? "Cancel delete" : "Delete chat", icon: <TrashIcon />, danger: true, keepOpen: !going, onSelect: () => onDelete(chat.id) },
                    ]} />}
                </div>
              </AnimatedChatRow>
            );
          })}
        </ul>
      ) : (
        <div className="sidebar-empty"><span>No chats yet</span><button type="button" onClick={onNewChat}>Start your first chat</button></div>
      )}

      {foot && <div className="sidebar-slot is-foot">{foot}</div>}
      {onResize && <span className="nav-resizer" onPointerDown={onResize} role="separator"
        aria-orientation="vertical" aria-label="Resize the chat column" />}
    </nav>
  );
}

function chatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) });
}

function AnimatedChatRow({ entering, leaving, children }: { entering: boolean; leaving: boolean; children: ReactNode }) {
  const [isEntering, setIsEntering] = useState(() => entering && !(typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));
  useEffect(() => {
    if (!isEntering) return;
    const frame = requestAnimationFrame(() => setIsEntering(false));
    return () => cancelAnimationFrame(frame);
  }, [isEntering]);
  return <li className={["chat-row", isEntering ? "is-entering" : "", leaving ? "is-leaving" : ""].filter(Boolean).join(" ")}>{children}</li>;
}

function GearIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06-.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></svg>;
}
function CollapseIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18" /><path d="m16 15-3-3 3-3" /></svg>; }
function PlusIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>; }
function ArchiveIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M6 7v12h12V7" /><path d="M3 4h18v3H3z" /><path d="M10 11h4" /></svg>; }
function TrashIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m6 6 1 14h10l1-14" /><path d="M10 10v6M14 10v6" /></svg>; }
function PinIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 17v5" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" /></svg>; }
function PencilIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>; }
