import { projectSlug } from "./projectSlug";

export type MentionableProject = { id: string; name: string };

export type ProjectMention =
  | { kind: "missing" }
  | { kind: "unknown"; tag: string }
  | { kind: "project"; project: MentionableProject; text: string };

/** A project mention is a routing tag at the start of a new chat.
 *
 * Project labels are represented by the same stable, readable slug used in
 * chat URLs. Underscores are accepted as well because `@project_name` is a
 * natural way to type the gesture; both forms collapse through projectSlug.
 */
export function projectMentionToken(name: string): string {
  return projectSlug(name) || name.toLowerCase().replace(/\s+/g, "-");
}

/** Resolve the first token of a new chat to a project and remove that routing
 * tag from the words the agent receives. */
export function readProjectMention(
  text: string,
  projects: readonly MentionableProject[],
): ProjectMention {
  const found = /^@([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!found) return { kind: "missing" };

  const tag = found[1];
  const normalized = projectSlug(tag);
  const project = projects.find(
    (candidate) =>
      candidate.id.toLowerCase() === tag.toLowerCase() ||
      projectMentionToken(candidate.name) === normalized,
  );
  if (!project) return { kind: "unknown", tag };
  return { kind: "project", project, text: (found[2] ?? "").trim() };
}

