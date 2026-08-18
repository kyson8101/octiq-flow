// Projects as folders, chats inside them.
//
// A project is a place you come back to, so it is a folder that holds its past
// chats rather than just a switch that sets the agent's working directory.
//
// The shape is a plain outline: a folder icon and a name, then its chats
// indented to start where that name starts. Chats carry no bullet of their own
// — the indent already says what they are — and any state they have is a mark
// on the RIGHT, where it can be scanned down the edge of the list without
// breaking the line of text.
import { useState } from "react";
import type { Conversation } from "../lib/store";

export type Project = { id: string; name: string; primary_path?: string };

/** Chats shown before the list folds. Long enough to recognise the work in
 *  progress, short enough that five projects still fit on a phone. */
const SHOW_AT_FIRST = 5;

export function Sidebar({
  projects,
  conversations,
  currentProject,
  currentConversation,
  running,
  busy,
  expanded,
  onToggle,
  onPickProject,
  onPickConversation,
  onNewChat,
  onDelete,
  onSettings,
  onNewProject,
}: {
  projects: Project[];
  conversations: Map<string, Conversation[]>;
  currentProject: string | null;
  currentConversation: string | null;
  /** Conversations with a live agent process behind them. */
  running: Set<string>;
  /** Of those, the ones mid-answer right now. */
  busy: Set<string>;
  expanded: Set<string>;
  onToggle: (projectId: string) => void;
  onPickProject: (projectId: string) => void;
  onPickConversation: (c: Conversation) => void;
  onNewChat: (projectId: string) => void;
  onDelete: (id: string) => void;
  onSettings: (projectId: string) => void;
  onNewProject: () => void;
}) {
  return (
    <nav className="sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">Projects</span>
        <button className="sidebar-add" type="button" title="New project" onClick={onNewProject}>
          <PlusIcon />
        </button>
      </div>

      <ul className="proj-list">
        {projects.map((p) => (
          <ProjectNode
            key={p.id}
            project={p}
            chats={conversations.get(p.id) ?? []}
            open={expanded.has(p.id)}
            current={p.id === currentProject}
            currentConversation={currentConversation}
            running={running}
            busy={busy}
            onToggle={onToggle}
            onPickProject={onPickProject}
            onPickConversation={onPickConversation}
            onNewChat={onNewChat}
            onDelete={onDelete}
            onSettings={onSettings}
          />
        ))}
      </ul>
    </nav>
  );
}

function ProjectNode({
  project,
  chats,
  open,
  current,
  currentConversation,
  running,
  busy,
  onToggle,
  onPickProject,
  onPickConversation,
  onNewChat,
  onDelete,
  onSettings,
}: {
  project: Project;
  chats: Conversation[];
  open: boolean;
  current: boolean;
  currentConversation: string | null;
  running: Set<string>;
  busy: Set<string>;
  onToggle: (id: string) => void;
  onPickProject: (id: string) => void;
  onPickConversation: (c: Conversation) => void;
  onNewChat: (id: string) => void;
  onDelete: (id: string) => void;
  onSettings: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const showing = open && chats.length > 0;
  const hidden = showAll ? 0 : Math.max(0, chats.length - SHOW_AT_FIRST);
  const visible = hidden ? chats.slice(0, SHOW_AT_FIRST) : chats;

  return (
    <li className="proj-node">
      <div className={`proj ${current ? "is-on" : ""}`}>
        <button
          className="proj-btn"
          type="button"
          onClick={() => onPickProject(project.id)}
          onDoubleClick={() => onToggle(project.id)}
        >
          <span className="proj-icon" aria-hidden="true">
            <FolderIcon open={showing} />
          </span>
          <span className="proj-name">{project.name}</span>
        </button>
        <button
          className="proj-add"
          type="button"
          title="Project settings"
          onClick={(e) => {
            e.stopPropagation();
            onSettings(project.id);
          }}
        >
          <GearIcon />
        </button>
        <button
          className="proj-add"
          type="button"
          title="New chat in this project"
          onClick={(e) => {
            e.stopPropagation();
            onNewChat(project.id);
          }}
        >
          <PlusIcon />
        </button>
      </div>

      {showing && (
        <ul className="chat-list">
          {visible.map((c) => (
            <li key={c.id}>
              <div
                className={[
                  "chat",
                  c.id === currentConversation ? "is-on" : "",
                  running.has(c.id) ? "is-live" : "",
                  busy.has(c.id) ? "is-busy" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {/* State in front of the title, where the eye starts: a dot for
                    the chat you are in, a green one for a session that is up,
                    and a pulsing green one for a chat still working — which is
                    the whole point of leaving them running. It sits in the
                    indent, so the titles stay lined up under the project name
                    whether or not a row has a mark. */}
                <span
                  className="chat-mark"
                  aria-hidden="true"
                  title={
                    busy.has(c.id) ? "working" : running.has(c.id) ? "session running" : undefined
                  }
                />
                <button className="chat-btn" type="button" onClick={() => onPickConversation(c)}>
                  <span className="chat-title">{c.title}</span>
                </button>
                <button
                  className="chat-del"
                  type="button"
                  title="Delete this chat"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(c.id);
                  }}
                >
                  <CloseIcon />
                </button>
              </div>
            </li>
          ))}

          {chats.length > SHOW_AT_FIRST && (
            <li>
              <button className="chat-more" type="button" onClick={() => setShowAll((v) => !v)}>
                {hidden ? "Show more" : "Show less"}
              </button>
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

function FolderIcon({ open }: { open: boolean }) {
  return open ? (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v1" />
      <path d="M3.5 20h15.3a1.5 1.5 0 0 0 1.45-1.1l1.35-5A1.5 1.5 0 0 0 20.15 12H5.6a1.5 1.5 0 0 0-1.45 1.1l-1.6 5.9" />
    </svg>
  ) : (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v0a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
