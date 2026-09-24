// Task-first navigation: one global list of chats, with project as context.
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type React from "react";
import { modelFromId } from "../lib/agentProviders";
import { buildChatTree, type ChatNode } from "../lib/chatTree";
import { recall, remember } from "../lib/remember";
import { latestResponse } from "../lib/chatPreview";
import { projectColor } from "../lib/projectColor";
import { isWorkerChat, EMPTY_ORCHESTRATION, type OrchestrationSnapshot } from "../lib/orchestration";
import { chatSnapshot, runSummary, workflowChatList } from "../lib/chatWorkflow";
import {
  CHAT_FILTERS, chatFilterCount, chatFilterList, isChatDone, isChatFilter, type ChatFilter,
} from "../lib/chatFilter";
import { workerArchiveChatList, workerArchiveDisabledReason } from "../lib/workerArchive";
import "./ChatWorkflowBar.css";
import type { Conversation } from "../lib/store";
import { isUnread } from "../lib/unread";
import { AgentLogo } from "./AgentLogo";
import { DeleteCountdownIcon } from "./ChatDeleteButton";
import { ChatPreviewButton, type ChatPreviewSource } from "./ChatPreviewButton";
import { ProjectAvatar, type ProjectAppearance } from "./ProjectAvatar";
import { SidebarMenu } from "./SidebarMenu";
import { AgentTaskBoard } from "./AgentTaskBoard";
import "./MobileSidebar.css";
import "./SidebarArchive.css";

export type Project = ProjectAppearance & {
  primary_path?: string;
  sibling_ids?: string[];
  env?: Record<string, string>;
};

export type ChatSearchHit = {
  id: string;
  excerpt: string;
  speaker: string;
  role: string;
};

const NONE: ReadonlySet<string> = new Set();
const NO_PARENTS: ReadonlyMap<string, string> = new Map();
const COLLAPSED_KEY = "octiq.chat.collapsed-agents";
const FILTER_KEY = "octiq.chat.filter";

/** Which chats the list is showing, remembered per browser. Deliberately NOT
 *  on the server: a phone catching up on what happened overnight and a laptop
 *  working through the day want different answers to the same list. */
function savedFilter(): ChatFilter {
  const value = recall(FILTER_KEY);
  return isChatFilter(value) ? value : "active";
}

function savedCollapsed(): Set<string> {
  try {
    const value: unknown = JSON.parse(recall(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export function Sidebar({
  orchestration = EMPTY_ORCHESTRATION,
  projects, shelved, onShowShelved, deletedCount = 0, onShowDeleted, onFeedback,
  conversations, currentConversation, running, busy, deleting = NONE,
  leaving = NONE, deleteMs = 2000, onPickConversation, getPreviewMessages,
  loadPreview, onNewChat, onDelete, onPin, onToggleDone, onRename, onArchiveWorker,
  onNewProject, searchChats, branches = {}, chatParents = NO_PARENTS, onResize, foot,
}: {
  orchestration?: OrchestrationSnapshot;
  projects: Project[];
  shelved: Project[];
  onShowShelved: () => void;
  deletedCount?: number;
  onShowDeleted?: () => void;
  onFeedback?: () => void;
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
  /** Tick a chat off by hand, or take the tick back. */
  onToggleDone: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchiveWorker?: (attemptId: string, archived: boolean) => Promise<void>;
  onNewProject: () => void;
  searchChats: (query: string) => Promise<ChatSearchHit[]>;
  branches?: Readonly<Record<string, string>>;
  chatParents?: ReadonlyMap<string, string>;
  onResize?: (event: React.PointerEvent<HTMLElement>) => void;
  foot?: ReactNode;
} & ChatPreviewSource) {
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const [filter, setFilter] = useState<ChatFilter>(savedFilter);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [actionsId, setActionsId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [searchHits, setSearchHits] = useState<ChatSearchHit[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "searching" | "ready" | "error">("idle");
  const hold = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const holdStart = useRef({ x: 0, y: 0 });
  const held = useRef(false);
  const badgeTap = useRef<{ chatId: string; at: number } | null>(null);
  const seenChatIds = useRef<ReadonlySet<string>>(new Set(conversations.map((chat) => chat.id)));
  const knownProjects = [...projects, ...shelved];
  const projectById = new Map(knownProjects.map((project) => [project.id, project]));
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const archivedConversations = workerArchiveChatList(conversations, orchestration, true);
  const activeConversations = workerArchiveChatList(conversations, orchestration);
  // What each view would hold. A view is offered only once it has something in
  // it, so somebody who has never ticked or pinned a chat sees no filter row at
  // all, and the row never grows a chip reading zero.
  const doneTotal = chatFilterCount(activeConversations, "done");
  const pinnedTotal = chatFilterCount(activeConversations, "pinned");
  const offered = CHAT_FILTERS.filter((option) =>
    option === "active" || option === "all" || filter === option
    || (option === "done" ? doneTotal : pinnedTotal) > 0);
  const filtering = !showArchived && offered.length > 2;
  const listedConversations = showArchived ? archivedConversations
    : chatFilterList(activeConversations, filter, currentConversation);
  const listedIds = new Set(listedConversations.map((chat) => chat.id));
  const trimmedQuery = query.trim();
  const searchActive = [...trimmedQuery].length >= 2;
  const hitById = new Map(searchHits.map((hit) => [hit.id, hit]));
  const visibleConversations = searchActive && searchState === "ready"
    ? searchHits.flatMap((hit) => {
      const conversation = conversationById.get(hit.id);
      return conversation && listedIds.has(conversation.id) ? [conversation] : [];
    })
    : searchActive ? [] : listedConversations;

  // Filtered on the way OUT of `workflowChatList`, never on the way in: it
  // decides which older attempts to fold away by looking at who is present,
  // and handing it a thinned list would unfold every superseded worker under a
  // coordinator that had merely been ticked off.
  const tree = useMemo(
    () => buildChatTree(
      chatFilterList(
        workflowChatList(conversations, orchestration, currentConversation),
        filter,
        currentConversation,
      ),
      chatParents,
    ),
    [conversations, chatParents, orchestration, currentConversation, filter],
  );
  const visibleNodes = searchActive || showArchived
    ? visibleConversations.map((chat): ChatNode => ({ chat, children: [], descendants: [] }))
    : tree;
  const ancestors = new Set<string>();
  let ancestor = currentConversation ? chatParents.get(currentConversation) : undefined;
  while (ancestor && !ancestors.has(ancestor)) {
    ancestors.add(ancestor);
    ancestor = chatParents.get(ancestor);
  }
  const ancestorKey = JSON.stringify([...ancestors]);
  useEffect(() => {
    const ids = JSON.parse(ancestorKey) as string[];
    setCollapsed((before) => {
      if (!ids.some((id) => before.has(id))) return before;
      return new Set([...before].filter((id) => !ids.includes(id)));
    });
  }, [currentConversation, ancestorKey]);
  useEffect(() => { remember(COLLAPSED_KEY, JSON.stringify([...collapsed])); }, [collapsed]);
  useEffect(() => { remember(FILTER_KEY, filter); }, [filter]);

  useEffect(() => { seenChatIds.current = new Set(conversations.map((chat) => chat.id)); }, [conversations]);
  useEffect(() => () => clearTimeout(hold.current), []);
  useEffect(() => {
    if (!searchActive) {
      setSearchHits([]);
      setSearchState("idle");
      return;
    }
    let current = true;
    setSearchHits([]);
    setSearchState("searching");
    const timer = setTimeout(() => {
      void searchChats(trimmedQuery)
        .then((hits) => {
          if (!current) return;
          setSearchHits(hits);
          setSearchState("ready");
        })
        .catch(() => {
          if (!current) return;
          setSearchHits([]);
          setSearchState("error");
        });
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [searchActive, searchChats, trimmedQuery]);
  const cancelHold = () => clearTimeout(hold.current);
  const archiveWorker = async (attemptId: string, archived: boolean) => {
    if (!onArchiveWorker || archiving) return;
    setArchiving(true);
    setArchiveError(null);
    try { await onArchiveWorker(attemptId, archived); }
    catch (error) { setArchiveError(error instanceof Error ? error.message : String(error)); }
    finally { setArchiving(false); }
  };

  const renderChat = ({ chat, children, descendants }: ChatNode): ReactNode => {
    const expanded = !collapsed.has(chat.id);
    const workingCount = descendants.filter((child) => busy.has(child.id)).length;
    const unreadCount = descendants.filter((child) => isUnread(child, currentConversation)).length;
    const childListId = `chat-agents-${chat.id}`;
    const parent = conversationById.get(chatParents.get(chat.id) ?? "");
    const going = deleting.has(chat.id);
    const isLeaving = leaving.has(chat.id);
    const unread = isUnread(chat, currentConversation);
    const done = isChatDone(chat);
    const project = projectById.get(chat.projectId);
    const chatTintStyle = project
      ? ({ "--chat-project-color": projectColor(project) } as CSSProperties)
      : undefined;
    const projectName = project?.name ?? "Unknown project";
    const attempt = orchestration.attempts.find((item) => item.workerChatKey === `chat:${chat.id}`);
    const task = attempt && orchestration.tasks.find((item) => item.id === attempt.taskId);
    const archived = attempt?.archivedAt != null;
    const archiveReason = attempt && !archived ? workerArchiveDisabledReason(orchestration, attempt) : null;
    const workflow = chatSnapshot(orchestration, `chat:${chat.id}`);
    const run = workflow.runs[0];
    const ownsRun = !searchActive && !showArchived && workflow.runs.length > 0;
    // Worker chats stay folded into this compact status board even when the
    // full run dashboard is visible beside the conversation. The two answer
    // different questions: this is navigation and at-a-glance status; the
    // dashboard owns checklists, briefs and workspace detail.
    const hasTaskBoard = ownsRun;
    const boardChatKeys = new Set(workflow.attempts.map((item) => item.workerChatKey));
    const otherChildren = ownsRun ? children.filter((child) => !boardChatKeys.has(`chat:${child.chat.id}`)) : children;
    const hasChildren = otherChildren.length > 0 || hasTaskBoard;
    const workflowLabel = task ? `${task.title} · ${archived ? "archived" : attempt?.status}` : run && !hasTaskBoard ? runSummary(workflow, run) : null;
    const branch = attempt?.branch || (parent ? "" : branches[chat.projectId]);
    const projectContext = branch ? `${projectName} | ${branch}` : projectName;
    const model = modelFromId(chat.modelId ?? null);
    const searchHit = searchActive ? hitById.get(chat.id) : undefined;
    const latest = latestResponse(getPreviewMessages?.(chat.id) ?? chat.messages);
    const snippet = going ? "Deleting…"
      : searchHit ? `${searchHit.speaker}: ${searchHit.excerpt}`
      : latest?.text ?? chat.latestResponse ?? (busy.has(chat.id) ? "Working…" : "No response yet");

    return (
      <AnimatedChatRow entering={!seenChatIds.current.has(chat.id)} leaving={isLeaving} key={chat.id}>
        <div className={[
          "chat", chat.id === currentConversation ? "is-on" : "",
          running.has(chat.id) ? "is-live" : "", busy.has(chat.id) ? "is-busy" : "",
          going ? "is-going" : "", isLeaving ? "is-leaving" : "",
          chat.pinned ? "is-pinned" : "", renaming === chat.id ? "is-renaming" : "",
          unread ? "is-unread" : "", done ? "is-done" : "",
        ].filter(Boolean).join(" ")} style={chatTintStyle}>
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
              className="chat-btn" type="button"
              aria-label={`${unread ? "Unread, " : ""}${chat.title}, ${projectName}${branch ? `, branch ${branch}` : ""}${model ? `, ${model.name} ${model.model}` : ""}${busy.has(chat.id) ? ", working" : running.has(chat.id) ? ", session running" : ""}${done ? ", done" : ""}${chat.pinned ? ", pinned" : ""}`}
              disabled={isLeaving} aria-current={chat.id === currentConversation ? "page" : undefined}
              aria-description={`${parent ? `Agent chat under ${parent.title}. ` : ""}Hover to preview. Hold for chat actions.`}
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
                  {unread && <span className="chat-unread-dot" aria-hidden="true" />}
                  <span className="chat-title">{chat.title}</span>
                  <time className="chat-time" dateTime={new Date(chat.updatedAt).toISOString()} title={new Date(chat.updatedAt).toLocaleString()}>{chatTime(chat.updatedAt)}</time>
                </span>
                <span className="chat-snippet">{snippet.replace(/\s+/g, " ")}</span>
                {workflowLabel && <span className="chat-workflow-status">{workflowLabel}</span>}
                <span className="chat-meta">
                  <span className="chat-project">
                    <span className="chat-project-name" title={projectContext}>{projectContext}</span>
                  </span>
                  {model && (
                    <span className="chat-model" title={`Active model: ${model.name} · ${model.model}`}>
                      <AgentLogo agent={model.agent} size={10} />
                      <span>{model.model}</span>
                    </span>
                  )}
                </span>
              </span>
            </ChatPreviewButton>
          )}

          {/* One slot on the left, answering three questions at once: whose
              project this is, whether it is running, and whether you are
              finished with it. They were three separate marks before —
              a letter tile down in the meta line, a coloured dot and a pin in
              a 14px gutter — none of them big enough to read and all of them
              competing for the same corner.

              So the project logo IS the control. A ring runs around it while a
              turn is in flight; a tick badge sits on it once the chat has been
              ticked off; and under the pointer the logo gives way to the tick
              itself, which is what double-tapping does. Nothing moves when it
              changes: every state is drawn inside the same 30px square. */}
          <button className="chat-badge" type="button" aria-pressed={done}
            title={done ? "Double-click or double-tap to mark not done" : "Double-click or double-tap to mark done"}
            aria-label={`${done ? "Mark not done" : "Mark done"}: ${chat.title}`}
            aria-description="Double-click or double-tap. With a keyboard, press Enter or Space."
            disabled={going || isLeaving}
            onBlur={() => { badgeTap.current = null; }}
            onClick={(event) => {
              event.stopPropagation();
              const previous = badgeTap.current;
              badgeTap.current = null;
              // Touch browsers need not emit dblclick. Count clicks on the
              // same badge; detail 0 preserves keyboard and assistive activation.
              if (event.detail === 0 || (previous?.chatId === chat.id && event.timeStamp - previous.at <= 500)) {
                onToggleDone(chat.id);
              } else {
                badgeTap.current = { chatId: chat.id, at: event.timeStamp };
              }
            }}>
            {project
              ? <ProjectAvatar project={project} size="medium" />
              : <span className="project-avatar is-medium" aria-hidden="true">?</span>}
            {/* Three strokes on one path, all of them always rendered and
                transparent at rest: a ring that appeared by mounting would
                arrive a frame late and jump. The track is the still ring; the
                snake and the pellet only have a colour while a turn is in
                flight. */}
            <svg className="chat-badge-ring" viewBox="0 0 32 32" aria-hidden="true">
              <rect className="chat-badge-track" x="1" y="1" width="30" height="30" rx="8" />
              <rect className="chat-badge-snake" x="1" y="1" width="30" height="30" rx="8" />
              <rect className="chat-badge-pellet" x="1" y="1" width="30" height="30" rx="8" />
            </svg>
            <span className="chat-badge-tick" aria-hidden="true"><TickIcon done={done} /></span>
            {done && <span className="chat-badge-check" aria-hidden="true"><CheckIcon /></span>}
            {chat.pinned && <span className="chat-badge-pin" aria-hidden="true"><PinIcon /></span>}
          </button>
          {renaming !== chat.id && <SidebarMenu className="chat-actions-trigger"
            label={`Actions for ${chat.title}`} open={actionsId === chat.id}
            onOpenChange={(open) => setActionsId(open ? chat.id : null)} disabled={isLeaving}
            icon={going ? <DeleteCountdownIcon ms={deleteMs} /> : undefined}
            items={[
              { id: "rename", label: "Rename chat", icon: <PencilIcon />, disabled: going, onSelect: () => setRenaming(chat.id) },
              { id: "pin", label: chat.pinned ? "Unpin chat" : "Pin chat", icon: <PinIcon />, disabled: going, onSelect: () => onPin(chat.id) },
              ...(attempt && onArchiveWorker ? [{ id: "archive", label: archived ? "Restore worker" : "Archive worker", icon: <ArchiveIcon />,
                disabled: archiving || !!archiveReason || (!archived && busy.has(chat.id)),
                title: archiveReason ?? (archived ? "Return this worker to the chat list." : "Hide this worker; its chat and task history are kept."),
                onSelect: () => void archiveWorker(attempt.id, !archived) }] : []),
              ...(!isWorkerChat(chat.id, chatParents) ? [{ id: "delete", label: going ? "Cancel delete" : "Delete chat", icon: <TrashIcon />, danger: true, keepOpen: !going, onSelect: () => onDelete(chat.id) }] : []),
            ]} />}
          {hasChildren && (
            <button className="chat-children-toggle" type="button"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${hasTaskBoard ? "task board" : "agent chats"} for ${chat.title}`}
              aria-expanded={expanded} aria-controls={childListId}
              disabled={isLeaving}
              onClick={() => setCollapsed((before) => {
                const next = new Set(before);
                if (next.has(chat.id)) next.delete(chat.id);
                else next.add(chat.id);
                return next;
              })}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
              <span>{hasTaskBoard ? `${workflow.tasks.length} tasks` : `${descendants.length} ${descendants.length === 1 ? "agent" : "agents"}`}</span>
              {workingCount > 0 && <span className="chat-children-working">{workingCount} working</span>}
              {unreadCount > 0 && <span className="chat-children-unread">{unreadCount} unread</span>}
            </button>
          )}
        </div>
        {hasChildren && (
          <div id={childListId} hidden={!expanded}>
            {expanded && hasTaskBoard && <AgentTaskBoard snapshot={workflow} conversations={conversationById}
              currentConversation={currentConversation} onOpenChat={onPickConversation} />}
            {expanded && otherChildren.length > 0 && <ul className="chat-children" aria-label={`Agent chats for ${chat.title}`}>
              {otherChildren.map(renderChat)}
            </ul>}
          </div>
        )}
      </AnimatedChatRow>
    );
  };

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
              ...(archivedConversations.length || showArchived ? [{ id: "archived", label: showArchived ? "Active chats" : `Archived workers (${archivedConversations.length})`, icon: <ArchiveIcon />,
                onSelect: () => { setShowArchived(!showArchived); setQuery(""); } }] : []),
              ...(shelved.length ? [{ id: "shelved", label: `Shelved projects (${shelved.length})`, icon: <ArchiveIcon />, onSelect: onShowShelved }] : []),
              ...(deletedCount && onShowDeleted ? [{ id: "trash", label: `Deleted chats (${deletedCount})`, icon: <TrashIcon />, onSelect: onShowDeleted }] : []),
            ]}
          />
        </div>
        <div className="sidebar-search-wrap">
          <label className="sidebar-search">
            <SearchIcon />
            <input
              type="search"
              value={query}
              placeholder="Search chats"
              aria-label="Search chats"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !query) return;
                event.preventDefault();
                setQuery("");
              }}
            />
            {query && (
              <button type="button" aria-label="Clear chat search" onClick={() => setQuery("")}>
                <ClearIcon />
              </button>
            )}
          </label>
        </div>
        {/* Offered only once there is something to hide. Ticking the first
            chat off is what reveals it, which is also the moment it first
            means anything. */}
        {filtering && (
          <div className="sidebar-filter" role="group" aria-label="Show chats">
            {offered.map((option) => {
              const total = option === "done" ? doneTotal : option === "pinned" ? pinnedTotal : 0;
              return (
                <button key={option} type="button" aria-pressed={filter === option}
                  className={filter === option ? "is-on" : ""}
                  onClick={() => setFilter(option)}>
                  {FILTER_LABELS[option]}
                  {total > 0 && <span>{total}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {showArchived && <div className="sidebar-archive-view">
        <div><strong>Archived workers</strong><span>{archivedConversations.length}</span></div>
        <button type="button" onClick={() => { setShowArchived(false); setQuery(""); }}>Back to active chats</button>
      </div>}
      {archiveError && <div className="sidebar-archive-error" role="alert">{archiveError}<button type="button" onClick={() => setArchiveError(null)}>Dismiss</button></div>}
      {!listedConversations.length ? (
        showArchived ? <div className="sidebar-empty" role="status"><span>No archived workers.</span></div> :
        // An empty list under a filter is not an empty app, and offering to
        // start a first chat to somebody with forty of them is how a filter
        // gets mistaken for a loss.
        filter !== "active" ? <div className="sidebar-empty" role="status">
          <span>{filter === "done" ? "No chats are ticked off."
            : filter === "pinned" ? "No chats are pinned."
            : "No chats yet"}</span>
          <button type="button" onClick={() => setFilter("active")}>Show active chats</button>
        </div> :
        conversations.length ? <div className="sidebar-empty" role="status">
          <span>Every chat is ticked off.</span>
          <button type="button" onClick={() => setFilter("done")}>Show done chats</button>
        </div> :
        <div className="sidebar-empty"><span>No chats yet</span><button type="button" onClick={onNewChat}>Start your first chat</button></div>
      ) : searchActive && searchState !== "ready" ? (
        <div className="sidebar-empty" role="status" aria-live="polite">
          <span>{searchState === "error" ? "Chat search is unavailable." : "Searching chats…"}</span>
          {searchState === "error" && <button type="button" onClick={() => setQuery("")}>Clear search</button>}
        </div>
      ) : visibleConversations.length ? (
        <ul className="chat-list task-chat-list">
          {visibleNodes.map(renderChat)}
        </ul>
      ) : (
        <div className="sidebar-empty" role="status" aria-live="polite">
          <span>No chats found for “{trimmedQuery}”.</span>
          <button type="button" onClick={() => setQuery("")}>Clear search</button>
        </div>
      )}

      {onFeedback && <button type="button" className="feedback-launch" onClick={onFeedback}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 4h16v13H9l-5 4V4Z" /><path d="M8 8h8M8 12h5" /></svg>
        Feedback inbox
      </button>}
      {foot && <div className="sidebar-slot is-foot">{foot}</div>}
      {onResize && <span className="nav-resizer" onPointerDown={onResize} role="separator"
        aria-orientation="vertical" aria-label="Resize the chat column" />}
    </nav>
  );
}

const FILTER_LABELS: Record<ChatFilter, string> = {
  active: "Active", pinned: "Pinned", done: "Done", all: "All",
};

/** What double-tapping the logo will do: an empty ring, or a ticked one to take the
 *  tick back. A ring rather than a box because the logo behind it is already
 *  square, and a stroke rather than a fill — the accent is a tint here, never
 *  a block of colour. */
function TickIcon({ done }: { done: boolean }) {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={done ? 2.4 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" />
    {done && <path d="m8 12 2.8 2.8L16 9.6" />}
  </svg>;
}

/** The small mark left ON the logo of a chat already ticked off — what says so
 *  when the pointer is somewhere else entirely. */
function CheckIcon() {
  return <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7" />
  </svg>;
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
  return <li className={["chat-row", isEntering ? "is-entering" : "", leaving ? "is-leaving" : ""].filter(Boolean).join(" ")}><div className="chat-row-content">{children}</div></li>;
}

function SearchIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>; }
function ClearIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>; }
function PlusIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>; }
function ArchiveIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M6 7v12h12V7" /><path d="M3 4h18v3H3z" /><path d="M10 11h4" /></svg>; }
function TrashIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m6 6 1 14h10l1-14" /><path d="M10 10v6M14 10v6" /></svg>; }
function PinIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 17v5" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" /></svg>; }
function PencilIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>; }
