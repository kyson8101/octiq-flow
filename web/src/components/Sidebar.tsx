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
import { useState, type ReactNode } from "react";
import type { Conversation } from "../lib/store";

export type Project = { id: string; name: string; primary_path?: string };

/** Chats shown before the list folds. Long enough to recognise the work in
 *  progress, short enough that five projects still fit on a phone. */
const SHOW_AT_FIRST = 5;

/** No row counting down — the default, shared so it is the same object every
 *  render rather than a new empty set each time. */
const NONE_DELETING: ReadonlySet<string> = new Set();

export function Sidebar({
  projects,
  shelved,
  onShowShelved,
  onShowBoard,
  onShowAgents,
  agentName,
  conversations,
  currentProject,
  currentConversation,
  running,
  busy,
  deleting = NONE_DELETING,
  deleteMs = 3000,
  expanded,
  onToggle,
  onPickProject,
  onPickConversation,
  onNewChat,
  onDelete,
  onSettings,
  onNewProject,
  onHide,
  head,
  foot,
}: {
  projects: Project[];
  /** Put away, not deleted. Listed behind a fold so they are reachable — the
   *  control that brings one back lives behind its own gear, so a shelved
   *  project that renders nowhere can never be unshelved. */
  shelved: Project[];
  /** Opens the modal that lists them, which is the only way back. */
  onShowShelved: () => void;
  /** Opens the board: every chat under what it wants from you. */
  onShowBoard: () => void;
  /** Opens the page that says which agent CLIs this machine has. */
  onShowAgents: () => void;
  /** The agent new chats start with, named on the button so the current answer
   *  is visible without opening the page. */
  agentName: string;
  conversations: Map<string, Conversation[]>;
  currentProject: string | null;
  currentConversation: string | null;
  /** Conversations with a live agent process behind them. */
  running: Set<string>;
  /** Of those, the ones mid-answer right now. */
  busy: Set<string>;
  /** The chats that were just deleted and have not gone yet. Each row stays
   *  where it is and counts down, so the way back is the button that started it
   *  rather than a bar somewhere else on screen — and a second delete on the
   *  row below leaves the first row's ring exactly where it was. */
  deleting?: ReadonlySet<string>;
  /** How long that countdown runs, in milliseconds. Drives the ring only — the
   *  clock that actually commits the delete lives with the chat list. */
  deleteMs?: number;
  expanded: Set<string>;
  onToggle: (projectId: string) => void;
  onPickProject: (projectId: string) => void;
  onPickConversation: (c: Conversation) => void;
  onNewChat: (projectId: string) => void;
  /** Delete this chat — and, pressed again on a row already counting down,
   *  take it back. One call for both, because it is one button. */
  onDelete: (id: string) => void;
  onSettings: (projectId: string) => void;
  onNewProject: () => void;
  /** Put the whole column away, on the screens where it IS a column. Absent
   *  below 860px, where the sidebar is a drawer that the scrim and the top
   *  bar's own title already close — a third control there would be a third
   *  way to do one thing. */
  onHide?: () => void;
  /** Controls with nowhere else to be on a phone. The top bar holds four things
   *  at 390px, so the view switch (`head`) and the plan-usage meter (`foot`)
   *  come in here instead — passed in rather than rendered twice, because the
   *  meter polls an endpoint that rate-limits per account. Both are absent on a
   *  wide screen, where the bar has room for them. */
  head?: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <nav className="sidebar">
      {head && <div className="sidebar-slot">{head}</div>}

      <div className="sidebar-head">
        <span className="sidebar-title">Projects</span>
        <button className="sidebar-add" type="button" title="New project" onClick={onNewProject}>
          <PlusIcon />
        </button>
        {/* Last, against the edge that goes away. The way back is the project
            name in the top bar, which gets its caret back once this is used. */}
        {onHide && (
          <button
            className="sidebar-add"
            type="button"
            title="Hide projects"
            aria-label="Hide projects"
            onClick={onHide}
          >
            <CollapseIcon />
          </button>
        )}
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
            deleting={deleting}
            deleteMs={deleteMs}
            onToggle={onToggle}
            onPickProject={onPickProject}
            onPickConversation={onPickConversation}
            onNewChat={onNewChat}
            onDelete={onDelete}
            onSettings={onSettings}
          />
        ))}
      </ul>

      {shelved.length > 0 && (
        <button className="shelf-open" type="button" onClick={onShowShelved}>
          Shelved · {shelved.length}
        </button>
      )}

      {/* The board reads across every project, so it does not belong to any
          one row above — it sits with the other whole-app routes. */}
      <button className="shelf-open" type="button" onClick={onShowBoard}>
        Board
      </button>

      {/* Same quiet treatment as the shelf: not what you came to the sidebar
          for, but the only route to the page — and it names the agent in use,
          so the answer is on screen without opening anything. */}
      <button className="shelf-open" type="button" onClick={onShowAgents}>
        Agent · {agentName}
      </button>

      {foot && <div className="sidebar-slot is-foot">{foot}</div>}
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
  deleting,
  deleteMs,
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
  deleting: ReadonlySet<string>;
  deleteMs: number;
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

  // A closed folder hides everything it holds, its chats' own marks included.
  // So the count carries that up: whether there is anything inside, and — from
  // the same pixel, since it is the row's only mark — whether any of it is
  // still running.
  const working = chats.some((c) => busy.has(c.id));
  const live = !working && chats.some((c) => running.has(c.id));

  return (
    <li className="proj-node">
      <div className={`proj ${current ? "is-on" : ""}`}>
        <button
          className="proj-btn"
          type="button"
          onClick={() => onPickProject(project.id)}
          onDoubleClick={() => onToggle(project.id)}
        >
          <span className={`proj-icon ${showing ? "is-open" : ""}`} aria-hidden="true">
            <FolderIcon />
          </span>
          <span className="proj-name">{project.name}</span>
          {/* How many chats are in here. Written at the right edge of the name,
              so the numbers line up in a column that can be read straight down
              the list — and left out entirely at zero, because an empty project
              is told from a full one fastest by there being nothing there. */}
          {chats.length > 0 && (
            <span
              className={`proj-count ${working ? "is-busy" : live ? "is-live" : ""}`}
              title={
                working
                  ? `${chats.length} chats · one still working`
                  : live
                    ? `${chats.length} chats · a session is up`
                    : `${chats.length} ${chats.length === 1 ? "chat" : "chats"}`
              }
            >
              {chats.length}
            </span>
          )}
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

      {/* Mounted whenever the project HAS chats, open or shut, because a folder
          that opens has to have something to open — a list that appears at full
          height the frame the class lands has nothing to animate from. Shut, it
          is a grid row of zero height with `visibility: hidden` over it, so it
          is out of the tab order and out of the screen reader's list exactly as
          it was when it did not exist. */}
      {chats.length > 0 && (
        <div className={`chat-fold ${showing ? "is-open" : ""}`}>
          <ul className="chat-list">
            {visible.map((c) => {
              // Deleted a moment ago and not gone yet. The row is left exactly
              // where it stood — see the countdown ring below.
              const going = deleting.has(c.id);
              return (
                <li key={c.id}>
                  <div
                    className={[
                      "chat",
                      c.id === currentConversation ? "is-on" : "",
                      running.has(c.id) ? "is-live" : "",
                      busy.has(c.id) ? "is-busy" : "",
                      going ? "is-going" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    {/* State in front of the title, where the eye starts: a dot
                        for the chat you are in, a grey one for a session that
                        is up but idle, and a pulsing green one for a chat still
                        working — which is the whole point of leaving them
                        running. It sits in the indent, on the middle of the
                        folder-icon column above, so a dot is under the folder
                        it belongs to and the titles still line up under the
                        project name whether or not a row has a mark. */}
                    <span
                      className="chat-mark"
                      aria-hidden="true"
                      title={
                        busy.has(c.id)
                          ? "working"
                          : running.has(c.id)
                            ? "session running"
                            : undefined
                      }
                    />
                    <button
                      className="chat-btn"
                      type="button"
                      onClick={() => onPickConversation(c)}
                    >
                      <span className="chat-title">{c.title}</span>
                    </button>
                    {/* The same button, twice: it deletes, and while the delete
                        is still counting down it takes it back. Nothing moves
                        between the two presses, so the second one is aimed at
                        exactly where the first one landed. */}
                    <button
                      className={`chat-del ${going ? "is-going" : ""}`}
                      type="button"
                      title={going ? "Cancel delete" : "Delete this chat"}
                      aria-label={going ? "Cancel delete" : "Delete this chat"}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(c.id);
                      }}
                    >
                      {going ? <DrainIcon ms={deleteMs} /> : <CloseIcon />}
                    </button>
                  </div>
                </li>
              );
            })}

            {chats.length > SHOW_AT_FIRST && (
              <li>
                <button className="chat-more" type="button" onClick={() => setShowAll((v) => !v)}>
                  {hidden ? "Show more" : "Show less"}
                </button>
              </li>
            )}
          </ul>
        </div>
      )}
    </li>
  );
}

/** Both folders, stacked, one fading out as the other fades in.
 *
 *  Swapping which SVG is mounted is instant, and an instant swap sitting next
 *  to a list that takes a quarter of a second to open reads as two separate
 *  events rather than one folder opening. Which is on top is decided in CSS,
 *  off `.proj-icon.is-open` — see the cross-fade there. */
function FolderIcon() {
  return (
    <>
      <svg className="folder-shut" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      </svg>
      <svg className="folder-open" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 8V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.7.9l.8 1.2a2 2 0 0 0 1.7.9H19a2 2 0 0 1 2 2v1" />
        <path d="M3.5 20h15.3a1.5 1.5 0 0 0 1.45-1.1l1.35-5A1.5 1.5 0 0 0 20.15 12H5.6a1.5 1.5 0 0 0-1.45 1.1l-1.6 5.9" />
      </svg>
    </>
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

function CollapseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 15-3-3 3-3" />
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

/** How long is left before a deleted chat actually goes, drawn as a ring that
 *  empties around the × that started it.
 *
 *  It is a loader that is also a clock: it says the delete is under way, and
 *  how much of it is left to take back. Mounted only while the row is counting,
 *  so a row deleted, taken back, and deleted again starts a fresh ring rather
 *  than inheriting the first one's remaining seconds.
 *
 *  The ring is CSS, not a ticking timer. The clock that actually commits the
 *  delete lives with the chat list; two clocks counting the same three seconds
 *  would sooner or later disagree on screen. This one is not load-bearing — it
 *  runs out a moment either side of the real one and nothing depends on which. */
function DrainIcon({ ms }: { ms: number }) {
  return (
    <svg className="chat-drain" width="17" height="17" viewBox="0 0 16 16" aria-hidden="true">
      <circle className="chat-drain-track" cx="8" cy="8" r="6.6" />
      <circle
        className="chat-drain-arc"
        cx="8"
        cy="8"
        r="6.6"
        style={{ animationDuration: `${ms}ms` }}
      />
      <path className="chat-drain-x" d="M9.9 6.1 6.1 9.9M6.1 6.1l3.8 3.8" />
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
