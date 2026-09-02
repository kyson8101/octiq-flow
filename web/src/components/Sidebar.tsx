// Projects as folders, chats inside them.
//
// A project is a place you come back to, so it is a folder that holds its past
// chats rather than just a switch that sets the agent's working directory.
//
// The shape is a plain outline: a folder icon and a name, then its chats
// indented to start where that name starts. Each chat carries the robot for its
// saved model, and any state it has is a mark on the RIGHT, where it can be
// scanned down the edge of the list without breaking the line of text.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type React from "react";
import { modelFromId } from "../lib/agentProviders";
import type { Conversation } from "../lib/store";
import { moveProjectAt, moveProjectBy } from "../lib/projectOrder";
import { Mascot } from "./Mascot";
import { RollingNumber } from "./RollingNumber";

export type Project = {
  id: string;
  name: string;
  primary_path?: string;
  sibling_ids?: string[];
};

/** Chats shown before the list folds. Long enough to recognise the work in
 *  progress, short enough that five projects still fit on a phone. */
const SHOW_AT_FIRST = 5;

/** No row counting down — the default, shared so it is the same object every
 *  render rather than a new empty set each time. */
const NONE_DELETING: ReadonlySet<string> = new Set();

/** A delete has committed and this row is using its last frames to collapse.
 *  Kept separately from `deleting`: the latter means it can still be taken
 *  back, while this one is already gone for good. */
const NONE_LEAVING: ReadonlySet<string> = new Set();

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
  leaving = NONE_LEAVING,
  deleteMs = 2000,
  expanded,
  onToggle,
  onPickConversation,
  onNewChat,
  onDelete,
  onPin,
  onSettings,
  onNewProject,
  onReorder,
  onHide,
  onResize,
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
  /** Chats whose delete has committed but whose rows are still collapsing out
   *  of the list. They are no longer undoable or interactive. */
  leaving?: ReadonlySet<string>;
  expanded: Set<string>;
  onToggle: (projectId: string) => void;
  onPickConversation: (c: Conversation) => void;
  onNewChat: (projectId: string) => void;
  /** Delete this chat — and, pressed again on a row already counting down,
   *  take it back. One call for both, because it is one button. */
  onDelete: (id: string) => void;
  /** Pin this chat to the top of its project — or, on one already pinned,
   *  let it go back to its place by age. */
  onPin: (id: string) => void;
  onSettings: (projectId: string) => void;
  onNewProject: () => void;
  /** Persist a complete ordering of the visible project rows. */
  onReorder: (orderedIds: string[]) => void;
  /** Put the whole column away, on the screens where it IS a column. Absent
   *  below 860px, where the sidebar is a drawer that the scrim and the top
   *  bar's own title already close — a third control there would be a third
   *  way to do one thing. */
  onHide?: () => void;
  /** Start a drag of the column's right edge. Present only where the sidebar
   *  IS a column: as a drawer it is the width of the screen, and there is
   *  nothing beside it to take the space from. */
  onResize?: (e: React.PointerEvent<HTMLElement>) => void;
  /** Controls with nowhere else to be on a phone. The top bar holds four things
   *  at 390px, so the view switch (`head`) and the plan-usage meter (`foot`)
   *  come in here instead — passed in rather than rendered twice, because the
   *  meter polls an endpoint that rate-limits per account. Both are absent on a
   *  wide screen, where the bar has room for them. */
  head?: ReactNode;
  foot?: ReactNode;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; edge: "before" | "after" } | null>(
    null,
  );
  const projectRows = useRef(new Map<string, HTMLLIElement>());
  const priorProjectPositions = useRef(new Map<string, DOMRect>());
  const projectOrder = projects.map((project) => project.id).join("\u0000");
  const names = new Map([...projects, ...shelved].map((project) => [project.id, project.name]));

  // Native drag-and-drop updates the order in one DOM commit. Preserve the
  // previous rectangles, then play each moved row back to its new place so the
  // result reads as a rearrangement instead of a jump.
  useLayoutEffect(() => {
    const current = new Map<string, DOMRect>();
    for (const [id, row] of projectRows.current) current.set(id, row.getBoundingClientRect());

    if (priorProjectPositions.current.size > 0 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const [id, row] of projectRows.current) {
        const before = priorProjectPositions.current.get(id);
        const after = current.get(id);
        if (!before || !after) continue;

        const deltaY = before.top - after.top;
        if (Math.abs(deltaY) > 1) {
          row.animate(
            [
              { transform: `translateY(${deltaY}px)` },
              { transform: "translateY(0)" },
            ],
            { duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
          );
        }
      }
    }

    priorProjectPositions.current = current;
  }, [projectOrder]);

  const reorder = (next: string[]) => {
    const current = projects.map((project) => project.id);
    if (next.some((id, index) => id !== current[index])) onReorder(next);
  };

  const endDrag = () => {
    setDragging(null);
    setDropAt(null);
  };

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
            rowRef={(node) => {
              if (node) projectRows.current.set(p.id, node);
              else projectRows.current.delete(p.id);
            }}
            project={p}
            chats={conversations.get(p.id) ?? []}
            open={expanded.has(p.id)}
            current={p.id === currentProject}
            currentConversation={currentConversation}
            running={running}
            busy={busy}
            deleting={deleting}
            leaving={leaving}
            deleteMs={deleteMs}
            onToggle={onToggle}
            onPickConversation={onPickConversation}
            onNewChat={onNewChat}
            onDelete={onDelete}
            onPin={onPin}
            onSettings={onSettings}
            siblingNames={(p.sibling_ids ?? []).flatMap((id) =>
              names.has(id) ? [names.get(id)!] : [],
            )}
            dragging={dragging === p.id}
            dropEdge={dropAt?.id === p.id ? dropAt.edge : null}
            onDragStart={(e) => {
              setDragging(p.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", p.id);
            }}
            onDragOver={(e) => {
              if (!dragging || dragging === p.id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const box = e.currentTarget.getBoundingClientRect();
              setDropAt({
                id: p.id,
                edge: e.clientY < box.top + box.height / 2 ? "before" : "after",
              });
            }}
            onDrop={(e) => {
              e.preventDefault();
              const moving = dragging || e.dataTransfer.getData("text/plain");
              if (moving && moving !== p.id) {
                const box = e.currentTarget.getBoundingClientRect();
                reorder(
                  moveProjectAt(
                    projects.map((project) => project.id),
                    moving,
                    p.id,
                    e.clientY < box.top + box.height / 2 ? "before" : "after",
                  ),
                );
              }
              endDrag();
            }}
            onDragEnd={endDrag}
            onMove={(direction) =>
              reorder(moveProjectBy(projects.map((project) => project.id), p.id, direction))
            }
          />
        ))}
      </ul>

      {/* Whole-app destinations are a compact utility dock rather than three
          full-width rows. Their labels stay available on hover and to assistive
          tech; the project list gets to keep the vertical room. */}
      <div className="sidebar-utilities" aria-label="Project utilities">
        {shelved.length > 0 && (
          <button
            className="sidebar-utility"
            type="button"
            title={`Shelved projects (${shelved.length})`}
            aria-label={`Shelved projects (${shelved.length})`}
            onClick={onShowShelved}
          >
            <ArchiveIcon />
            <span className="sidebar-utility-count"><RollingNumber value={shelved.length} /></span>
          </button>
        )}

        <button
          className="sidebar-utility"
          type="button"
          title="Board"
          aria-label="Board"
          onClick={onShowBoard}
        >
          <BoardIcon />
        </button>

        <button
          className="sidebar-utility"
          type="button"
          title={`Agent · ${agentName}`}
          aria-label={`Agent · ${agentName}`}
          onClick={onShowAgents}
        >
          <AgentIcon />
        </button>
      </div>

      {foot && <div className="sidebar-slot is-foot">{foot}</div>}

      {/* Last, so it draws over the rows it sits beside. It is the dividing
          line itself, widened either side of it — a 1px target is not a
          target — and it carries no width of its own, so the list is exactly
          as wide with it as without. */}
      {onResize && (
        <span
          className="nav-resizer"
          onPointerDown={onResize}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the project column"
        />
      )}
    </nav>
  );
}

function ProjectNode({
  rowRef,
  project,
  chats,
  open,
  current,
  currentConversation,
  running,
  busy,
  deleting,
  leaving,
  deleteMs,
  onToggle,
  onPickConversation,
  onNewChat,
  onDelete,
  onPin,
  onSettings,
  siblingNames,
  dragging,
  dropEdge,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onMove,
}: {
  rowRef: (node: HTMLLIElement | null) => void;
  project: Project;
  chats: Conversation[];
  open: boolean;
  current: boolean;
  currentConversation: string | null;
  running: Set<string>;
  busy: Set<string>;
  deleting: ReadonlySet<string>;
  leaving: ReadonlySet<string>;
  deleteMs: number;
  onToggle: (id: string) => void;
  onPickConversation: (c: Conversation) => void;
  onNewChat: (id: string) => void;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  onSettings: (id: string) => void;
  siblingNames: string[];
  dragging: boolean;
  dropEdge: "before" | "after" | null;
  onDragStart: (event: React.DragEvent<HTMLButtonElement>) => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  // The chats present on this project's first paint are already here — making
  // all of history slide in every time the sidebar mounts would be noise. A
  // later id is a new row, and gets the short expand transition below.
  const seenChatIds = useRef<ReadonlySet<string>>(new Set(chats.map((c) => c.id)));
  useEffect(() => {
    seenChatIds.current = new Set(chats.map((c) => c.id));
  }, [chats]);
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
    <li
      ref={rowRef}
      className={[
        "proj-node",
        dragging ? "is-dragging" : "",
        dropEdge ? `is-drop-${dropEdge}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className={`proj ${current ? "is-on" : ""}`} onDragOver={onDragOver} onDrop={onDrop}>
        <button
          className="proj-drag"
          type="button"
          draggable
          title="Drag or use the arrow keys to reorder"
          aria-label={`Reorder ${project.name}`}
          aria-keyshortcuts="ArrowUp ArrowDown"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            onMove(event.key === "ArrowUp" ? -1 : 1);
          }}
        >
          <GripIcon />
        </button>
        <button
          className="proj-btn"
          type="button"
          aria-expanded={showing}
          onClick={() => onToggle(project.id)}
        >
          <span className={`proj-icon ${showing ? "is-open" : ""}`} aria-hidden="true">
            <FolderIcon />
          </span>
          <span className="proj-name">{project.name}</span>
          {siblingNames.length > 0 && (
            <span
              className="proj-siblings"
              title={`Sibling ${siblingNames.length === 1 ? "project" : "projects"}: ${siblingNames.join(", ")}`}
            >
              <LinkIcon />
            </span>
          )}
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
              <RollingNumber value={chats.length} />
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
              const isLeaving = leaving.has(c.id);
              const isEntering = !seenChatIds.current.has(c.id);
              return (
                <AnimatedChatRow entering={isEntering} leaving={isLeaving} key={c.id}>
                  <div
                    className={[
                      "chat",
                      c.id === currentConversation ? "is-on" : "",
                      running.has(c.id) ? "is-live" : "",
                      busy.has(c.id) ? "is-busy" : "",
                      going ? "is-going" : "",
                      isLeaving ? "is-leaving" : "",
                      c.pinned ? "is-pinned" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <button
                      className="chat-btn"
                      type="button"
                      disabled={isLeaving}
                      onClick={() => onPickConversation(c)}
                    >
                      <Mascot
                        robot={modelFromId(c.modelId ?? null)?.composerStyle}
                        mood="still"
                        size={16}
                      />
                      <span className="chat-title">{c.title}</span>
                    </button>
                    {/* The pin, in a slot of its own before the trailing one. A
                        pinned chat wears it all the time — it is the reason the
                        row sits above newer ones — and any other row offers it
                        on hover. Its own fixed box, so the title never
                        re-measures when the pointer arrives. */}
                    <button
                      className={`chat-pin ${c.pinned ? "is-pinned" : ""}`}
                      type="button"
                      title={c.pinned ? "Unpin this chat" : "Pin this chat to the top"}
                      aria-label={c.pinned ? "Unpin this chat" : "Pin this chat to the top"}
                      aria-pressed={!!c.pinned}
                      disabled={isLeaving}
                      onClick={(e) => {
                        e.stopPropagation();
                        onPin(c.id);
                      }}
                    >
                      <PinIcon />
                    </button>
                    <span className="chat-tail">
                      {/* State follows the title: a dot for the chat you are
                          in, a grey one for a session that is up but idle, and
                          a pulsing green one for a chat still working. On hover
                          it gives this same slot to the delete control. */}
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
                      {/* The same button, twice: it deletes, and while the
                          delete is still counting down it takes it back. */}
                      <button
                        className={`chat-del ${going ? "is-going" : ""}`}
                        type="button"
                        title={going ? "Cancel delete" : "Delete this chat"}
                        aria-label={going ? "Cancel delete" : "Delete this chat"}
                        disabled={isLeaving}
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete(c.id);
                        }}
                      >
                        {going ? <DrainIcon ms={deleteMs} /> : <CloseIcon />}
                      </button>
                    </span>
                  </div>
                </AnimatedChatRow>
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

/** A newly added chat gets the inverse of a delete: it starts at zero height,
 *  then opens on the next frame. Existing history skips this entirely; see the
 *  `seenChatIds` ref above. */
function AnimatedChatRow({
  entering,
  leaving,
  children,
}: {
  entering: boolean;
  leaving: boolean;
  children: ReactNode;
}) {
  const [isEntering, setIsEntering] = useState(
    () =>
      entering &&
      !(
        typeof window !== "undefined" &&
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ),
  );

  useEffect(() => {
    if (!isEntering) return;
    const frame = requestAnimationFrame(() => setIsEntering(false));
    return () => cancelAnimationFrame(frame);
  }, [isEntering]);

  return (
    <li
      className={["chat-row", isEntering ? "is-entering" : "", leaving ? "is-leaving" : ""]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
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

function GripIcon() {
  return (
    <svg width="12" height="14" viewBox="0 0 12 14" fill="currentColor" aria-hidden="true">
      <circle cx="3" cy="3" r="1" />
      <circle cx="9" cy="3" r="1" />
      <circle cx="3" cy="7" r="1" />
      <circle cx="9" cy="7" r="1" />
      <circle cx="3" cy="11" r="1" />
      <circle cx="9" cy="11" r="1" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.1 1.1" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.1-1.1" />
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

function ArchiveIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16" />
      <path d="M6 7v12h12V7" />
      <path d="M3 4h18v3H3z" />
      <path d="M10 11h4" />
    </svg>
  );
}

function BoardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4M9 12h.01M15 12h.01M9 16h6" />
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
 *  delete lives with the chat list; two clocks counting the same two seconds
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

/** A pin, drawn as an outline. The pinned state fills it in from CSS. */
function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 17v5" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}
