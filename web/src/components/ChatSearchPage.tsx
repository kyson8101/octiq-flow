// Search chats: a main-area page, like Projects and the pull request desk.
//
// It used to be a field at the top of the sidebar, which cost a row of height
// on every screen and could only answer inside the list's current view. As a
// page it has the whole workspace for its results, searches every chat
// whatever the sidebar's Recent view says, and opens the chat a result names.
import { useEffect, useRef, useState } from "react";
import {
  chatSearchResults, isSearchable, type ChatSearchHit,
} from "../lib/chatSearch";
import type { Conversation } from "../lib/store";
import { ProjectAvatar } from "./ProjectAvatar";
import { chatTime, type Project } from "./Sidebar";
import "./ProjectsPage.css";
import "./ChatSearchPage.css";

/** How many recently active chats the page offers before anything is typed. */
const RECENT = 8;

export type ChatSearchState = "idle" | "searching" | "ready" | "error";

export function ChatSearchPage({
  conversations, projects, searchChats, onOpenChat, onClose,
  deletedCount = 0, onShowDeleted, initialQuery = "", initialState, initialHits,
}: {
  conversations: Conversation[];
  projects: Project[];
  searchChats: (query: string) => Promise<ChatSearchHit[]>;
  onOpenChat: (chat: Conversation) => void;
  onClose: () => void;
  deletedCount?: number;
  onShowDeleted?: () => void;
  /** Static-render seams for the page's tests. */
  initialQuery?: string;
  initialState?: ChatSearchState;
  initialHits?: ChatSearchHit[];
}) {
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<ChatSearchHit[]>(initialHits ?? []);
  const [state, setState] = useState<ChatSearchState>(initialState ?? "idle");
  const input = useRef<HTMLInputElement>(null);
  const trimmed = query.trim();
  const searchable = isSearchable(query);

  useEffect(() => { input.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (!searchable) {
      setHits([]);
      setState("idle");
      return;
    }
    let current = true;
    setState("searching");
    const timer = setTimeout(() => {
      void searchChats(trimmed)
        .then((found) => {
          if (!current) return;
          setHits(found);
          setState("ready");
        })
        .catch(() => {
          if (!current) return;
          setHits([]);
          setState("error");
        });
    }, 180);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [searchable, searchChats, trimmed]);

  const projectById = new Map(projects.map((project) => [project.id, project]));
  // The last answer stays on screen while the next is fetched, so typing one
  // more letter does not blank the list between keystrokes.
  const results = searchable && state !== "error" ? chatSearchResults(hits, conversations) : [];
  const recent = trimmed ? [] : [...conversations]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, RECENT);

  const row = (chat: Conversation, excerpt: string) => {
    const project = projectById.get(chat.projectId);
    const projectName = project?.name ?? "Unknown project";
    return (
      <li key={chat.id}>
        <button type="button" className="projects-task chat-search-result" onClick={() => onOpenChat(chat)}
          aria-label={`${chat.title}, ${projectName}`}>
          {project
            ? <ProjectAvatar project={project} size="medium" />
            : <span className="project-avatar is-medium" aria-hidden="true">?</span>}
          <span className="chat-search-result-text">
            <span className="projects-task-line">
              <span className="projects-task-title">{chat.title}</span>
              <time dateTime={new Date(chat.updatedAt).toISOString()}>{chatTime(chat.updatedAt)}</time>
            </span>
            <span className="chat-search-excerpt">{excerpt.replace(/\s+/g, " ")}</span>
            <span className="chat-search-project">{projectName}</span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <section className="projects-page chat-search-page" aria-label="Search chats">
      <header className="projects-page-head">
        <button type="button" className="projects-page-back" onClick={onClose} aria-label="Back to chat">
          <BackIcon /><span>Chat</span>
        </button>
        <div className="projects-page-heading">
          <h1>Search chats</h1>
          <span>Searches every chat's messages</span>
        </div>
      </header>
      <div className="projects-page-body">
        <form className="chat-search-form" role="search" onSubmit={(event) => {
          event.preventDefault();
          if (results[0]) onOpenChat(results[0].chat);
        }}>
          <SearchIcon />
          <input ref={input} type="search" value={query} placeholder="Search chats"
            aria-label="Search chats" autoComplete="off" spellCheck={false}
            aria-describedby="chat-search-status"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              if (query) setQuery("");
              else onClose();
            }} />
          {query && <button type="button" className="chat-search-clear" aria-label="Clear chat search"
            onClick={() => { setQuery(""); input.current?.focus(); }}>
            <ClearIcon />
          </button>}
        </form>

        <p id="chat-search-status" className="projects-page-count chat-search-status" role="status" aria-live="polite">
          {!searchable ? (trimmed ? "Type at least two characters." : recent.length ? "Recently active" : "")
            : state === "searching" ? "Searching chats…"
            : state === "error" ? "Chat search is unavailable. Check the connection and try again."
            : state === "ready" ? (results.length === 1 ? "1 chat" : `${results.length} chats`)
            : ""}
        </p>

        {results.length > 0 && (
          <ul className="projects-task-list" aria-label={`Chats matching ${trimmed}`}>
            {results.map(({ chat, hit }) => row(chat, `${hit.speaker}: ${hit.excerpt}`))}
          </ul>
        )}
        {searchable && state === "ready" && results.length === 0 && (
          <div className="projects-page-empty">
            <p>No chats found for “{trimmed}”.</p>
            <button type="button" onClick={() => { setQuery(""); input.current?.focus(); }}>Clear search</button>
          </div>
        )}
        {!searchable && recent.length > 0 && (
          <ul className="projects-task-list" aria-label="Recently active chats">
            {recent.map((chat) => row(chat, chat.latestResponse ?? "No response yet"))}
          </ul>
        )}
        {deletedCount > 0 && onShowDeleted && (
          <p className="chat-search-deleted">
            Deleted chats are not searched.{" "}
            <button type="button" onClick={onShowDeleted}>Deleted chats ({deletedCount})</button>
          </p>
        )}
      </div>
    </section>
  );
}

function BackIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>; }
function SearchIcon() { return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>; }
function ClearIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>; }
