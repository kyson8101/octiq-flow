// Task-first navigation: one global list of chats, with project as context.
import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type React from "react";
import { modelFromId } from "../lib/agentProviders";
import { buildChatTree, type ChatNode } from "../lib/chatTree";
import { recall, remember } from "../lib/remember";
import { latestResponse } from "../lib/chatPreview";
import { projectColor } from "../lib/projectColor";
import { isWorkerChat, ordinaryChats, EMPTY_ORCHESTRATION, type OrchestrationSnapshot } from "../lib/orchestration";
import { chatSnapshot, runSummary, workflowChatList } from "../lib/chatWorkflow";
import {
  CHAT_FILTER_LABELS, chatFilterList, chatFilterOptions, isChatDone, isChatFilter, type ChatFilter,
} from "../lib/chatFilter";
import { workerArchiveChatList, workerArchiveDisabledReason } from "../lib/workerArchive";
import { INITIAL_MOBILE_MENU_SCROLL, nextMobileMenuScroll } from "../lib/mobileMenuScroll";
import "./ChatWorkflowBar.css";
import type { Conversation } from "../lib/store";
import { isUnread } from "../lib/unread";
import { AgentLogo } from "./AgentLogo";
import { AgentAvatar } from "./AgentAvatar";
import { ChatPersonaContext } from "../lib/agentRoster";
import { DeleteCountdownIcon } from "./ChatDeleteButton";
import { ChatPreviewButton, type ChatPreviewSource } from "./ChatPreviewButton";
import { ProjectAvatar, type ProjectAppearance } from "./ProjectAvatar";
import { SidebarMenu } from "./SidebarMenu";
import "./MobileSidebar.css";
import "./SidebarArchive.css";

export type Project = ProjectAppearance & {
  primary_path?: string;
  sibling_ids?: string[];
  env?: Record<string, string>;
};

export type SidebarView = "search" | "settings" | "agents" | "projects";

const NONE: ReadonlySet<string> = new Set();
const NO_PARENTS: ReadonlyMap<string, string> = new Map();
const COLLAPSED_KEY = "octiq.chat.collapsed-agents";
const FILTER_KEY = "octiq.chat.filter";

/** Which chats the list is showing, remembered per browser. Deliberately NOT
 *  on the server: a phone catching up on what happened overnight and a laptop
 *  working through the day want different answers to the same list. A saved
 *  view this build no longer offers (the old `pinned`) reads as `active`. */
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
  projects, shelved, deletedCount = 0, onShowDeleted,
  conversations: everyChat, currentConversation, running, busy, deleting = NONE,
  leaving = NONE, deleteMs = 2000, onPickConversation, getPreviewMessages,
  loadPreview, onNewChat, newLabel = "New chat", onDelete, onPin, onToggleDone, onRename, onArchiveWorker,
  branches = {}, chatParents = NO_PARENTS, onResize, onCollapse,
  onSearch, onSettings, onAgents, onProjects, activeView = null,
}: {
  orchestration?: OrchestrationSnapshot;
  projects: Project[];
  /** Only read to name a shelved project's chats; the shelf itself lives on
   *  the Projects page. */
  shelved: Project[];
  /** The deleted chats, offered from the Recent menu beside the other views
   *  of the chat list. */
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
  /** "New task" in agents mode. */
  newLabel?: string;
  onDelete: (id: string) => void;
  onPin: (id: string) => void;
  /** Tick a chat off by hand, or take the tick back. */
  onToggleDone: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onArchiveWorker?: (attemptId: string, archived: boolean) => Promise<void>;
  branches?: Readonly<Record<string, string>>;
  chatParents?: ReadonlyMap<string, string>;
  onResize?: (event: React.PointerEvent<HTMLElement>) => void;
  /** Put the column away. Only given where the sidebar is a column. */
  onCollapse?: () => void;
  /** The app-level places, listed straight under New task. Each is drawn only
   *  when it is given: Agents exists in agents mode alone. */
  onSearch?: () => void;
  onSettings?: () => void;
  onAgents?: () => void;
  onProjects?: () => void;
  /** Which of those places the main area is showing, for `aria-current`. */
  activeView?: SidebarView | null;
} & ChatPreviewSource) {
  // Run workers are never rows here — not pinned, not in any Recent view, not
  // archived, not even while one is the chat on screen. The main chat's row
  // leads to them through its run (see lib/orchestration `ordinaryChats`).
  const conversations = useMemo(() => ordinaryChats(everyChat, chatParents), [everyChat, chatParents]);
  const [collapsed, setCollapsed] = useState(savedCollapsed);
  const [filter, setFilter] = useState<ChatFilter>(savedFilter);
  const [keptMarked, setKeptMarked] = useState<ReadonlySet<string>>(() => new Set());
  const [filterOpen, setFilterOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [actionsId, setActionsId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [menuScroll, setMenuScroll] = useState(INITIAL_MOBILE_MENU_SCROLL);
  const personaOf = useContext(ChatPersonaContext);
  const toolbar = useRef<HTMLDivElement | null>(null);
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
  // A later message can make a done chat active again. Stop retaining that
  // row then, so a future mark from another device follows the live filter.
  useEffect(() => {
    setKeptMarked((before) => {
      const next = new Set(before);
      for (const id of before) {
        const chat = conversationById.get(id);
        if (!chat || (filter === "active" ? !isChatDone(chat) : filter === "done" ? isChatDone(chat) : true)) {
          next.delete(id);
        }
      }
      return next.size === before.size ? before : next;
    });
  }, [conversations, filter]);
  // The views live in one dropdown beside the Recent heading, so every view is
  // always offered: a menu costs no row height, and a fixed set is easier to
  // find again than one that grows as chats are ticked. The other ways of
  // looking at the chat list — archived workers, deleted chats — sit in the
  // same menu, under the views.
  const listedConversations = showArchived ? archivedConversations
    : chatFilterList(activeConversations, filter, currentConversation, keptMarked);

  // Filtered on the way OUT of `workflowChatList`, never on the way in: it
  // decides which older attempts to fold away by looking at who is present,
  // and handing it a thinned list would unfold every superseded worker under a
  // coordinator that had merely been ticked off.
  const workflowList = useMemo(
    () => workflowChatList(conversations, orchestration, currentConversation),
    [conversations, orchestration, currentConversation],
  );
  const tree = useMemo(
    () => buildChatTree(chatFilterList(workflowList, filter, currentConversation, keptMarked), chatParents),
    [workflowList, chatParents, currentConversation, filter, keptMarked],
  );
  // Pins are not a view. A pinned chat is listed under Pinned whatever Recent
  // is showing — ticked off or not — so switching Recent to Done never makes a
  // pin disappear, and Recent never lists it twice.
  const fullTree = useMemo(() => buildChatTree(workflowList, chatParents), [workflowList, chatParents]);
  const hasPin = (node: ChatNode) => !!node.chat.pinned || node.descendants.some((chat) => chat.pinned);
  const pinnedNodes = showArchived ? [] : fullTree.filter(hasPin);
  const recentNodes = showArchived
    ? archivedConversations.map((chat): ChatNode => ({ chat, children: [], descendants: [] }))
    : tree.filter((node) => !hasPin(node));
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
  const cancelHold = () => clearTimeout(hold.current);
  const archiveWorker = async (attemptId: string, archived: boolean) => {
    if (!onArchiveWorker || archiving) return;
    setArchiving(true);
    setArchiveError(null);
    try { await onArchiveWorker(attemptId, archived); }
    catch (error) { setArchiveError(error instanceof Error ? error.message : String(error)); }
    finally { setArchiving(false); }
  };
  const chooseFilter = (next: ChatFilter) => {
    setKeptMarked(new Set());
    setFilter(next);
  };
  const toggleDone = (chat: Conversation) => {
    const done = isChatDone(chat);
    const wouldLeave = (filter === "active" && !done) || (filter === "done" && done);
    setKeptMarked((before) => {
      const next = new Set(before);
      if (wouldLeave) next.add(chat.id);
      else next.delete(chat.id);
      return next;
    });
    onToggleDone(chat.id);
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
    const ownsRun = !showArchived && workflow.runs.length > 0;
    // A run's worker chats are not listed here. Its task list opens beside the
    // chat list when this row is picked, and stays while a worker is open, so
    // that list IS the way to them; a second copy here was the same tasks twice.
    const runChatKeys = new Set(workflow.attempts.map((item) => item.workerChatKey));
    const otherChildren = ownsRun ? children.filter((child) => !runChatKeys.has(`chat:${child.chat.id}`)) : children;
    const hasChildren = otherChildren.length > 0;
    const openWorker = ownsRun && runChatKeys.has(`chat:${currentConversation}`);
    const workflowLabel = task ? `${task.title} · ${archived ? "archived" : attempt?.status}` : run ? runSummary(workflow, run) : null;
    const branch = attempt?.branch || (parent ? "" : branches[chat.projectId]);
    const projectContext = branch ? `${projectName} | ${branch}` : projectName;
    const model = modelFromId(chat.modelId ?? null);
    // Agents mode: a chat handed to a registered agent is named for the agent,
    // not the model it runs on; the model stays in the tooltip.
    const persona = personaOf(`chat:${chat.id}`);
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
          unread ? "is-unread" : "", done ? "is-done" : "", openWorker ? "is-worker-on" : "",
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
              aria-label={`${unread ? "Unread, " : ""}${chat.title}, ${projectName}${branch ? `, branch ${branch}` : ""}${persona ? `, with ${persona.name}` : model ? `, ${model.name} ${model.model}` : ""}${busy.has(chat.id) ? ", working" : running.has(chat.id) ? ", session running" : ""}${done ? ", done" : ""}${chat.pinned ? ", pinned" : ""}`}
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
                  {persona ? (
                    <span className="chat-model chat-persona" title={`${persona.name}${model ? ` · ${model.name} ${model.model}` : ""}`}>
                      <AgentAvatar name={persona.name} avatar={persona.avatar} id={persona.id ?? persona.name} size={14} removed={persona.removed} decorative />
                      <span>{persona.name}</span>
                    </span>
                  ) : model && (
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
                toggleDone(chat);
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
              aria-label={`${expanded ? "Collapse" : "Expand"} agent chats for ${chat.title}`}
              aria-expanded={expanded} aria-controls={childListId}
              disabled={isLeaving}
              onClick={() => setCollapsed((before) => {
                const next = new Set(before);
                if (next.has(chat.id)) next.delete(chat.id);
                else next.add(chat.id);
                return next;
              })}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
              <span>{`${otherChildren.length} ${otherChildren.length === 1 ? "agent" : "agents"}`}</span>
              {workingCount > 0 && <span className="chat-children-working">{workingCount} working</span>}
              {unreadCount > 0 && <span className="chat-children-unread">{unreadCount} unread</span>}
            </button>
          )}
        </div>
        {hasChildren && (
          <div id={childListId} hidden={!expanded}>
            {expanded && otherChildren.length > 0 && <ul className="chat-children" aria-label={`Agent chats for ${chat.title}`}>
              {otherChildren.map(renderChat)}
            </ul>}
          </div>
        )}
      </AnimatedChatRow>
    );
  };

  const closeArchived = () => { setShowArchived(false); setKeptMarked(new Set()); };
  const recentMenu = [
    ...chatFilterOptions(activeConversations, filter).map((option) => ({
      id: option.filter, label: option.label, checked: !showArchived && option.checked,
      onSelect: () => { closeArchived(); chooseFilter(option.filter); },
    })),
    ...(archivedConversations.length || showArchived ? [{
      id: "archived", label: `Archived workers (${archivedConversations.length})`, icon: <ArchiveIcon />,
      checked: showArchived, separator: true,
      onSelect: () => { setShowArchived(true); setKeptMarked(new Set()); },
    }] : []),
    ...(deletedCount && onShowDeleted ? [{
      id: "trash", label: `Deleted chats (${deletedCount})`, icon: <TrashIcon />,
      separator: !(archivedConversations.length || showArchived), onSelect: onShowDeleted,
    }] : []),
  ];
  const recentLabel = showArchived ? "Archived" : CHAT_FILTER_LABELS[filter];

  return (
    <nav className="sidebar task-sidebar" aria-label="Chats">
      <div className="task-chat-scroll" onScroll={(event) => {
        const scroller = event.currentTarget;
        const preserve = !!toolbar.current?.contains(document.activeElement);
        setMenuScroll((state) => nextMobileMenuScroll(
          state,
          scroller.scrollTop,
          toolbar.current?.offsetHeight ?? 0,
          preserve,
        ));
      }}>
        <div
          ref={toolbar}
          id="chats-navigation"
          className={`sidebar-toolbar${menuScroll.floating ? " is-floating" : ""}${menuScroll.hidden ? " is-hidden" : ""}`}
          onFocusCapture={() => setMenuScroll((state) => ({ ...state, hidden: false, direction: null, travel: 0 }))}
        >
          {/* The column is the full height of the window, so its first row sits
              level with the top bar beside it and carries the name of the app —
              the one place it does. The top bar beside it names the page. */}
          <div className="sidebar-head">
            <img className="sidebar-logo" src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" aria-hidden="true" />
            <span className="sidebar-title">OctiqFlow <span className="sidebar-version">v{__APP_VERSION__}</span></span>
            {onCollapse && <button className="sidebar-collapse" type="button" onClick={onCollapse}
              aria-label="Hide sidebar" title="Hide sidebar">
              <CollapseIcon />
            </button>}
          </div>
          <ul className="sidebar-places" aria-label="App">
            <li><button className="sidebar-place sidebar-new-chat" type="button" onClick={onNewChat}>
              <NewChatIcon /><span>{newLabel}</span>
            </button></li>
            {onSearch && <li><button className="sidebar-place" type="button" onClick={onSearch}
              aria-current={activeView === "search" ? "page" : undefined}>
              <SearchIcon /><span>Search chats</span>
            </button></li>}
            {onProjects && <li><button className="sidebar-place" type="button" onClick={onProjects}
              aria-current={activeView === "projects" ? "page" : undefined}>
              <ProjectsIcon /><span>Projects</span>
            </button></li>}
            {onAgents && <li><button className="sidebar-place" type="button" onClick={onAgents}
              aria-current={activeView === "agents" ? "page" : undefined}>
              <AgentsIcon /><span>Agents</span>
            </button></li>}
            {onSettings && <li><button className="sidebar-place" type="button" onClick={onSettings}
              aria-current={activeView === "settings" ? "page" : undefined}>
              <SettingsIcon /><span>Settings</span>
            </button></li>}
          </ul>
        </div>

        {archiveError && <div className="sidebar-archive-error" role="alert">{archiveError}<button type="button" onClick={() => setArchiveError(null)}>Dismiss</button></div>}
        {conversations.length > 0 || showArchived ? (
          <div className="task-chat-content">
            {pinnedNodes.length > 0 && <section className="sidebar-chat-section" aria-labelledby="sidebar-pinned-heading">
              <h2 id="sidebar-pinned-heading" className="sidebar-section-heading">Pinned</h2>
              <ul className="chat-list task-chat-list">{pinnedNodes.map(renderChat)}</ul>
            </section>}
            {/* The heading stays whenever there are chats, even with nothing
                under it: it carries the only way to change the view. */}
            <section className="sidebar-chat-section" aria-labelledby="sidebar-recent-heading">
              <div className="sidebar-section-head">
                <h2 id="sidebar-recent-heading" className="sidebar-section-heading">{showArchived ? "Archived workers" : "Recent"}</h2>
                <SidebarMenu className="sidebar-filter-trigger"
                  label={`Show chats: ${recentLabel}`}
                  open={filterOpen} onOpenChange={setFilterOpen}
                  icon={<><span>{recentLabel}</span><ChevronIcon /></>}
                  items={recentMenu} />
              </div>
              {recentNodes.length > 0 ? <ul className="chat-list task-chat-list">{recentNodes.map(renderChat)}</ul> : emptyRecent()}
            </section>
          </div>
        ) : (
          <div className="sidebar-empty"><span>No chats yet</span><button type="button" onClick={onNewChat}>Start your first chat</button></div>
        )}
      </div>

      {onResize && <span className="nav-resizer" onPointerDown={onResize} role="separator"
        aria-orientation="vertical" aria-label="Resize the chat column" />}
    </nav>
  );

  function emptyRecent(): ReactNode {
    if (showArchived) {
      return <div className="sidebar-empty" role="status">
        <span>No archived workers.</span>
        <button type="button" onClick={closeArchived}>Show active chats</button>
      </div>;
    }
    // An empty list under a filter is not an empty app, and offering to start
    // a first chat to somebody with forty of them is how a filter gets
    // mistaken for a loss.
    if (filter !== "active") {
      return <div className="sidebar-empty" role="status">
        <span>{filter === "done" ? "No chats are ticked off." : "Every chat is pinned."}</span>
        <button type="button" onClick={() => chooseFilter("active")}>Show active chats</button>
      </div>;
    }
    const ticked = activeConversations.some((chat) => isChatDone(chat) && !chat.pinned);
    return ticked && !listedConversations.some((chat) => !chat.pinned)
      ? <div className="sidebar-empty" role="status">
        <span>Every chat is ticked off.</span>
        <button type="button" onClick={() => chooseFilter("done")}>Show done chats</button>
      </div>
      : <div className="sidebar-empty" role="status">
        <span>{pinnedNodes.length > 0 ? "Every active chat is pinned." : "No active chats."}</span>
      </div>;
  }
}

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

export function chatTime(timestamp: number): string {
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
function CollapseIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M15 10l-2 2 2 2" /></svg>; }
function NewChatIcon() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 12.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5.5" /><path d="m12 12 7.5-7.5a2.12 2.12 0 0 1 3 3L15 15l-4 1 1-4Z" /></svg>; }
function ArchiveIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M6 7v12h12V7" /><path d="M3 4h18v3H3z" /><path d="M10 11h4" /></svg>; }
function TrashIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m6 6 1 14h10l1-14" /><path d="M10 10v6M14 10v6" /></svg>; }
function PinIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 17v5" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" /></svg>; }
function ChevronIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>; }
function SettingsIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>; }
function AgentsIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="3" y="16" width="6" height="5" rx="1" /><rect x="15" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M6 16v-2h12v2" /></svg>; }
function ProjectsIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>; }
function PencilIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>; }
