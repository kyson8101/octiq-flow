import type { CSSProperties } from "react";
import {
  conversationColorProjectId, conversationProjectSummary, type ConversationProjectInfo,
} from "../lib/conversationProjects";
import { projectColor } from "../lib/projectColor";
import { ProjectAvatar, type ProjectAppearance } from "./ProjectAvatar";
import "./ConversationProjects.css";

type NamedProject = ProjectAppearance & { name: string };

/** Compact, truthful work-project context for a conversation row. */
export function ConversationProjects({ info, projects, limit = 2 }: {
  info: ConversationProjectInfo;
  projects: readonly NamedProject[];
  limit?: number;
}) {
  const known = new Map(projects.map((project) => [project.id, project]));
  if (info.status === "loading") {
    return <span className="conversation-projects is-quiet" aria-label="Work projects loading">Projects loading…</span>;
  }
  if (info.status === "discussion") {
    return <span className="conversation-projects is-quiet">Discussion</span>;
  }
  if (info.status === "unknown") {
    return <span className="conversation-projects is-quiet">Project unknown</span>;
  }
  if (info.status !== "projects") return null;

  const destinations = info.destinations.map((destination) => {
    const project = known.get(destination.projectId);
    return {
      id: destination.projectId,
      name: project?.name ?? destination.projectName ?? "Unknown project",
      // A project no longer registered has no colour of its own to show.
      style: project ? ({ "--conversation-project-color": projectColor(project) } as CSSProperties) : undefined,
    };
  });
  const shown = destinations.slice(0, Math.max(1, limit));
  const overflow = destinations.length - shown.length;
  const unknown = info.unknownTaskCount;
  const detail = conversationProjectSummary(info, (id, fallback) => known.get(id)?.name ?? fallback ?? "Unknown project");
  const taskLabel = `${info.taskCount} ${info.taskCount === 1 ? "task" : "tasks"}`;

  return <span className="conversation-projects" title={detail} aria-label={`Work projects: ${detail}`}>
    <span className="conversation-project-chips" aria-hidden="true">
      {shown.map((project) => <span className={`conversation-project-chip${project.style ? " is-registered" : ""}`}
        key={project.id} style={project.style}>{project.name}</span>)}
      {overflow > 0 && <span className="conversation-project-overflow">+{overflow}</span>}
      {unknown > 0 && <span className="conversation-project-unknown">+?</span>}
    </span>
    <span className="conversation-project-task-count" aria-hidden="true">{taskLabel}</span>
  </span>;
}

/**
 * The project mark at the head of a conversation row: the one registered
 * project the row is coloured by, otherwise a neutral tile — stacked for work
 * across several projects, "?" for a project unknown or since removed, and
 * blank while the ledger loads or before a discussion has any tasks.
 */
export function ConversationProjectAvatar({ info, projects }: {
  info: ConversationProjectInfo;
  projects: readonly NamedProject[];
}) {
  const known = new Map(projects.map((project) => [project.id, project]));
  const projectId = conversationColorProjectId(info, (id) => known.has(id));
  const project = projectId ? known.get(projectId) : undefined;
  if (project) return <ProjectAvatar project={project} size="medium" />;
  const several = info.status === "projects" && info.destinations.length > 1;
  const pending = info.status === "loading" || info.status === "discussion";
  return <span className={`project-avatar is-medium is-neutral${several ? " is-several" : ""}`} aria-hidden="true">
    {several ? <SeveralIcon /> : pending ? null : "?"}
  </span>;
}

/** The row's colour, as the custom property the chat-list rows tint from. */
export function conversationTintStyle(info: ConversationProjectInfo, projects: readonly NamedProject[]): CSSProperties | undefined {
  const projectId = conversationColorProjectId(info, (id) => projects.some((item) => item.id === id));
  const project = projects.find((item) => item.id === projectId);
  return project ? ({ "--chat-project-color": projectColor(project) } as CSSProperties) : undefined;
}

function SeveralIcon() {
  return <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.5"
    strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="5.5" width="8" height="8" rx="2" />
    <path d="M5.5 3.5V3a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5h-.5" />
  </svg>;
}
