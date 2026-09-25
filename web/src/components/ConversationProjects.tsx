import type { ConversationProjectInfo } from "../lib/conversationProjects";
import type { ProjectAppearance } from "./ProjectAvatar";
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

  const destinations = info.destinations.map((destination) => ({
    id: destination.projectId,
    name: known.get(destination.projectId)?.name ?? destination.projectName ?? "Unknown project",
  }));
  const shown = destinations.slice(0, Math.max(1, limit));
  const overflow = destinations.length - shown.length;
  const unknown = info.unknownTaskCount;
  const names = destinations.map((project) => project.name);
  const detail = [
    ...names,
    ...(unknown ? [`${unknown} ${unknown === 1 ? "task has" : "tasks have"} no confirmed project`] : []),
  ].join(", ");
  const taskLabel = `${info.taskCount} ${info.taskCount === 1 ? "task" : "tasks"}`;

  return <span className="conversation-projects" title={detail} aria-label={`Work projects: ${detail}; ${taskLabel}`}>
    <span className="conversation-project-chips" aria-hidden="true">
      {shown.map((project) => <span className="conversation-project-chip" key={project.id}>{project.name}</span>)}
      {overflow > 0 && <span className="conversation-project-overflow">+{overflow}</span>}
      {unknown > 0 && <span className="conversation-project-unknown">+?</span>}
    </span>
    <span className="conversation-project-task-count" aria-hidden="true">{taskLabel}</span>
  </span>;
}
