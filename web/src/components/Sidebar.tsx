// Projects as folders, conversations inside them.
//
// A project is a place you come back to, so it is a folder that holds its past
// chats rather than just a switch that sets the agent's working directory. The
// open project's folder is expanded; the others stay shut until asked.
import type { Conversation } from "../lib/store";

export type Project = { id: string; name: string; primary_path?: string };

export function Sidebar({
  projects,
  conversations,
  currentProject,
  currentConversation,
  expanded,
  onToggle,
  onPickProject,
  onPickConversation,
  onNewChat,
  onDelete,
}: {
  projects: Project[];
  conversations: Map<string, Conversation[]>;
  currentProject: string | null;
  currentConversation: string | null;
  expanded: Set<string>;
  onToggle: (projectId: string) => void;
  onPickProject: (projectId: string) => void;
  onPickConversation: (c: Conversation) => void;
  onNewChat: (projectId: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <nav className="sidebar">
      <div className="sidebar-head">Projects</div>
      <ul className="proj-list">
        {projects.map((p) => {
          const chats = conversations.get(p.id) ?? [];
          const open = expanded.has(p.id);
          return (
            <li key={p.id} className="proj-node">
              <div className={`proj ${p.id === currentProject ? "is-on" : ""}`}>
                {/* The twisty only opens the folder. Clicking the row itself
                    selects the project, which is the more common intent. */}
                <button
                  className={`twisty ${open ? "is-open" : ""} ${chats.length ? "" : "is-idle"}`}
                  type="button"
                  aria-label={open ? "Hide chats" : "Show chats"}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(p.id);
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </button>

                <button className="proj-main" type="button" onClick={() => onPickProject(p.id)}>
                  <span className="proj-name">{p.name}</span>
                  {chats.length > 0 && <span className="proj-count">{chats.length}</span>}
                </button>

                <button
                  className="proj-add"
                  type="button"
                  title="New chat in this project"
                  onClick={(e) => {
                    e.stopPropagation();
                    onNewChat(p.id);
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="M12 5v14M5 12h14" />
                  </svg>
                </button>
              </div>

              {open && chats.length > 0 && (
                <ul className="chat-list">
                  {chats.map((c) => (
                    <li key={c.id}>
                      <div className={`chat ${c.id === currentConversation ? "is-on" : ""}`}>
                        <button className="chat-main" type="button" onClick={() => onPickConversation(c)}>
                          <span className="chat-title">{c.title}</span>
                          <span className="chat-when">{when(c.updatedAt)}</span>
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
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                            <path d="M18 6 6 18M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Coarse and readable: the exact minute of a chat two days ago helps nobody. */
function when(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d` : `${Math.round(days / 7)}w`;
}
