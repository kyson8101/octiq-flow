// The Projects page: every project, and under one of them every chat it holds.
//
// A main-area view like the pull request desk — the chat stays mounted behind
// it. The task list is the project's whole history, never the sidebar's Recent
// view (see lib/projectTasks). Everything about projects as such lives here
// too: New project, and the shelf — what was put away, and the way back.
import { useEffect, useRef, useState } from "react";
import { isChatDone } from "../lib/chatFilter";
import { projectTaskCounts, projectTasks } from "../lib/projectTasks";
import type { Conversation } from "../lib/store";
import { ProjectAvatar } from "./ProjectAvatar";
import { chatTime, type Project } from "./Sidebar";
import "./ProjectsPage.css";

export function ProjectsPage({
  projects, shelved, conversations, selectedProjectId, busy, chatParents,
  onSelectProject, onOpenChat, onNewTask, onNewProject, onProjectSettings, onClose,
  onShowShelved, onRestoreProject,
}: {
  projects: Project[];
  shelved: Project[];
  conversations: Conversation[];
  /** The project whose tasks are listed, or null for the project list. */
  selectedProjectId: string | null;
  busy: ReadonlySet<string>;
  chatParents: ReadonlyMap<string, string>;
  onSelectProject: (projectId: string | null) => void;
  onOpenChat: (chat: Conversation) => void;
  onNewTask: (projectId: string) => void;
  onNewProject: () => void;
  onProjectSettings: (projectId: string) => void;
  onClose: () => void;
  /** The shelf sheet, to bring several projects back at once. */
  onShowShelved?: () => void;
  /** Take one project off the shelf. */
  onRestoreProject?: (projectId: string) => Promise<void>;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  // Moving between the list and a project replaces the whole page, so focus
  // follows to its heading instead of falling back to <body>.
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    heading.current?.focus({ preventScroll: true });
    setRestoreError(null);
  }, [selectedProjectId]);

  const known = [...projects, ...shelved];
  const selected = selectedProjectId === null ? null : known.find((project) => project.id === selectedProjectId) ?? null;

  if (selectedProjectId !== null) {
    const tasks = selected ? projectTasks(conversations, selected.id) : [];
    const isShelved = !!selected && shelved.some((project) => project.id === selected.id);
    return (
      <section className="projects-page" aria-label={selected ? `${selected.name} tasks` : "Project"}>
        <header className="projects-page-head">
          <button type="button" className="projects-page-back" onClick={() => onSelectProject(null)}>
            <BackIcon /><span>Projects</span>
          </button>
          {selected && <ProjectAvatar project={selected} size="medium" />}
          <div className="projects-page-heading">
            <h1 ref={heading} tabIndex={-1}>{selected?.name ?? "Project unavailable"}</h1>
            {selected && <span title={selected.primary_path}>{selected.primary_path ?? (isShelved ? "Shelved" : "")}</span>}
          </div>
          {selected && <div className="projects-page-actions">
            <button type="button" className="projects-page-secondary" onClick={() => onProjectSettings(selected.id)}>Project settings</button>
            {isShelved && onRestoreProject && <button type="button" className="projects-page-primary" disabled={restoring}
              onClick={async () => {
                setRestoring(true);
                setRestoreError(null);
                try { await onRestoreProject(selected.id); }
                catch (error) { setRestoreError(error instanceof Error ? error.message : String(error)); }
                finally { setRestoring(false); }
              }}>
              <span>{restoring ? "Restoring…" : "Restore project"}</span>
            </button>}
            {!isShelved && <button type="button" className="projects-page-primary" onClick={() => onNewTask(selected.id)}>
              <PlusIcon /><span>New task</span>
            </button>}
          </div>}
        </header>
        {restoreError && <p className="projects-page-error" role="alert">{restoreError}</p>}
        <div className="projects-page-body">
          {!selected ? (
            <div className="projects-page-empty" role="status">
              <p>This project was removed or is no longer in this profile.</p>
              <button type="button" onClick={() => onSelectProject(null)}>Show all projects</button>
            </div>
          ) : tasks.length === 0 ? (
            <div className="projects-page-empty" role="status">
              <p>No tasks in {selected.name} yet.</p>
              {!isShelved && <button type="button" onClick={() => onNewTask(selected.id)}>Start a task</button>}
            </div>
          ) : (
            <>
              <h2 className="projects-page-count">{tasks.length === 1 ? "1 task" : `${tasks.length} tasks`}</h2>
              <ul className="projects-task-list" aria-label={`Tasks in ${selected.name}`}>
                {tasks.map((chat) => {
                  const working = busy.has(chat.id);
                  const done = isChatDone(chat);
                  const agent = chatParents.has(chat.id);
                  const states = [working && "Working", done && "Done", chat.pinned && "Pinned", agent && "Agent"]
                    .filter((state): state is string => !!state);
                  return (
                    <li key={chat.id}>
                      <button type="button" className="projects-task" onClick={() => onOpenChat(chat)}
                        aria-label={[chat.title, ...states].join(", ")}>
                        <span className="projects-task-line">
                          <span className="projects-task-title">{chat.title}</span>
                          <time dateTime={new Date(chat.updatedAt).toISOString()}>{chatTime(chat.updatedAt)}</time>
                        </span>
                        <span className="projects-task-line">
                          <span className="projects-task-snippet">{(chat.latestResponse ?? (working ? "Working…" : "No response yet")).replace(/\s+/g, " ")}</span>
                          {states.length > 0 && <span className="projects-task-states" aria-hidden="true">
                            {states.map((state) => <span key={state} className={`is-${state.toLowerCase()}`}>{state}</span>)}
                          </span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      </section>
    );
  }

  const counts = projectTaskCounts(conversations);
  const row = (project: Project) => {
    const count = counts.get(project.id) ?? 0;
    return (
      <li key={project.id}>
        <button type="button" className="projects-row" onClick={() => onSelectProject(project.id)}
          aria-label={`${project.name}, ${count === 1 ? "1 task" : `${count} tasks`}`}>
          <ProjectAvatar project={project} size="medium" />
          <span className="projects-row-text">
            <span className="projects-row-name">{project.name}</span>
            {project.primary_path && <span className="projects-row-path">{project.primary_path}</span>}
          </span>
          <span className="projects-row-count" aria-hidden="true">{count}</span>
          <ForwardIcon />
        </button>
      </li>
    );
  };

  return (
    <section className="projects-page" aria-label="Projects">
      <header className="projects-page-head">
        <button type="button" className="projects-page-back" onClick={onClose} aria-label="Back to chat">
          <BackIcon /><span>Chat</span>
        </button>
        <div className="projects-page-heading">
          <h1 ref={heading} tabIndex={-1}>Projects</h1>
          <span>{projects.length === 1 ? "1 project" : `${projects.length} projects`}</span>
        </div>
        <div className="projects-page-actions">
          <button type="button" className="projects-page-primary" onClick={onNewProject}>
            <PlusIcon /><span>New project</span>
          </button>
        </div>
      </header>
      <div className="projects-page-body">
        {known.length === 0 ? (
          <div className="projects-page-empty" role="status">
            <p>No projects yet.</p>
            <button type="button" onClick={onNewProject}>Add a project</button>
          </div>
        ) : <>
          {projects.length > 0 && <ul className="projects-list" aria-label="Projects">{projects.map(row)}</ul>}
          {shelved.length > 0 && <>
            <div className="projects-page-subhead">
              <h2 className="projects-page-count">Shelved</h2>
              {onShowShelved && <button type="button" className="projects-page-link" onClick={onShowShelved}>
                Restore shelved projects
              </button>}
            </div>
            <ul className="projects-list" aria-label="Shelved projects">{shelved.map(row)}</ul>
          </>}
        </>}
      </div>
    </section>
  );
}

function BackIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>; }
function ForwardIcon() { return <svg className="projects-row-go" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>; }
function PlusIcon() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>; }
