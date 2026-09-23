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
import { workerArchiveChatList, workerArchiveDisabledReason } from "../lib/workerArchive";
import "./ChatWorkflowBar.css";
import type { Conversation } from "../lib/store";
import { isUnread } from "../lib/unread";
import { AgentLogo } from "./AgentLogo";
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

export type ChatSearchHit = {
  id: string;
  excerpt: string;
  speaker: string;
  role: string;
};

const NONE: ReadonlySet<string> = new Set();
const NO_PARENTS: ReadonlyMap<string, string> = new Map();
const COLLAPSED_KEY = "octiq.chat.collapsed-agents";

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
  projects, shelved, onShowShelved, deletedCount = 0, onShowDeleted,
  conversations, currentConversation, running, busy, deleting = NONE,
  leaving = NONE, deleteMs = 2000, onPickConversation, getPreviewMessages,
  loadPreview, onNewChat, onDelete, onPin, onRename, onArchiveWorker,
  onNewProject, searchChats, branches = {}, chatParents = NO_PARENTS, onResize, foot,
}: {
  orchestration?: OrchestrationSnapshot;
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
  onArchiveWorker?: (attemptId: string, archived: boolean) => Promise<void>;
  onNewProject: () => void;
  searchChats: (query: string) => Promise<ChatSearchHit[]>;
  branches?: Readonly<Record<string, string>>;
  chatParents?: ReadonlyMap<string, string>;
  onResize?: (event: React.PointerEvent<HTMLElement>) => void;
  foot?: ReactNode;
} & ChatPreviewSource) {
  const [collapsed, setCollapsed] = useState(savedCollapsed);
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
  const seenChatIds = useRef<ReadonlySet<string>>(new Set(conversations.map((chat) => chat.id)));
  const knownProjects = [...projects, ...shelved];
  const projectById = new Map(knownProjects.map((project) => [project.id, project]));
  const conversationById = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const archivedConversations = workerArchiveChatList(conversations, orchestration, true);
  const listedConversations = showArchived ? archivedConversations : workerArchiveChatList(conversations, orchestration);
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

  const tree = useMemo(() => buildChatTree(workflowChatList(conversations, orchestration, currentConversation), chatParents), [conversations, chatParents, orchestration, currentConversation]);
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
    const workflowLabel = task ? `${task.title} · ${archived ? "archived" : attempt?.status}` : run ? runSummary(workflow, run) : null;
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
          unread ? "is-unread" : "",
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
              aria-label={`${unread ? "Unread, " : ""}${chat.title}, ${projectName}${branch ? `, branch ${branch}` : ""}${model ? `, ${model.name} ${model.model}` : ""}`}
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
                    {project
                      ? <ProjectAvatar project={project} size="tiny" />
                      : <span className="project-avatar is-tiny" aria-hidden="true">?</span>}
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
              ...(attempt && onArchiveWorker ? [{ id: "archive", label: archived ? "Restore worker" : "Archive worker", icon: <ArchiveIcon />,
                disabled: archiving || !!archiveReason || (!archived && busy.has(chat.id)),
                title: archiveReason ?? (archived ? "Return this worker to the chat list." : "Hide this worker; its chat and task history are kept."),
                onSelect: () => void archiveWorker(attempt.id, !archived) }] : []),
              ...(!isWorkerChat(chat.id, chatParents) ? [{ id: "delete", label: going ? "Cancel delete" : "Delete chat", icon: <TrashIcon />, danger: true, keepOpen: !going, onSelect: () => onDelete(chat.id) }] : []),
            ]} />}
          {children.length > 0 && (
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
              <span>{descendants.length} {descendants.length === 1 ? "agent" : "agents"}</span>
              {workingCount > 0 && <span className="chat-children-working">{workingCount} working</span>}
              {unreadCount > 0 && <span className="chat-children-unread">{unreadCount} unread</span>}
            </button>
          )}
        </div>
        {children.length > 0 && (
          <ul className="chat-children" id={childListId} aria-label={`Agent chats for ${chat.title}`} hidden={!expanded}>
            {expanded && children.map(renderChat)}
          </ul>
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
      </div>

      {showArchived && <div className="sidebar-archive-view">
        <div><strong>Archived workers</strong><span>{archivedConversations.length}</span></div>
        <button type="button" onClick={() => { setShowArchived(false); setQuery(""); }}>Back to active chats</button>
      </div>}
      {archiveError && <div className="sidebar-archive-error" role="alert">{archiveError}<button type="button" onClick={() => setArchiveError(null)}>Dismiss</button></div>}
      {!listedConversations.length ? (
        showArchived ? <div className="sidebar-empty" role="status"><span>No archived workers.</span></div> :
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
  return <li className={["chat-row", isEntering ? "is-entering" : "", leaving ? "is-leaving" : ""].filter(Boolean).join(" ")}><div className="chat-row-content">{children}</div></li>;
}

function SearchIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>; }
function ClearIcon() { return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>; }
function PlusIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>; }
function ArchiveIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16" /><path d="M6 7v12h12V7" /><path d="M3 4h18v3H3z" /><path d="M10 11h4" /></svg>; }
function TrashIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="m6 6 1 14h10l1-14" /><path d="M10 10v6M14 10v6" /></svg>; }
function PinIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 17v5" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" /></svg>; }
function PencilIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg>; }
