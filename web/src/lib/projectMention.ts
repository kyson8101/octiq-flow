import { projectSlug } from "./projectSlug";

export type MentionableProject = {
  id: string;
  name: string;
  primary_path?: string;
  paths?: string[];
};

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

/** Text typed after an initial `@`, while the whole composer still contains
 * only that project-selection token. */
export function mentionQuery(text: string): string | undefined {
  return /^@([A-Za-z0-9_-]*)$/.exec(text)?.[1];
}

/** Whether a project remains in the completion list for the current query. */
export function mentionMatches(name: string, id: string | undefined, query: string): boolean {
  const normalized = projectSlug(query);
  if (!normalized) return true;
  return projectMentionToken(name).startsWith(normalized)
    || (id ?? "").toLowerCase().startsWith(query.toLowerCase());
}

/** Enter and Tab accept the highlighted project unless Enter carries a
 * newline modifier. */
export function mentionPicks(event: {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (event.key === "Tab") return true;
  return event.key === "Enter"
    && !event.shiftKey
    && !event.metaKey
    && !event.ctrlKey
    && !event.altKey;
}

const GENERIC_WORDS = new Set([
  "app",
  "code",
  "general",
  "main",
  "project",
  "repo",
  "src",
  "work",
]);

function words(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function compact(value: string): string {
  return words(value).join("");
}

function pathBase(value: string): string {
  return value.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) ?? "";
}

/** Infer a project only when the message contains a unique, high-confidence
 * project clue. A full project name, its compact spelling, or the basename of
 * one of its folders is strong enough. A single name/path word is accepted
 * only when it belongs to one project, so a generic phrase such as "fix the
 * API" cannot silently choose between two API projects.
 *
 * Returning null is deliberate: the caller routes that task to General. */
export function inferProjectFromText(
  text: string,
  projects: readonly MentionableProject[],
): MentionableProject | null {
  const candidates = projects.filter((project) => projectMentionToken(project.name) !== "general");
  if (!text.trim() || candidates.length === 0) return null;

  const messageWords = words(text);
  const messageWordSet = new Set(messageWords);
  const messagePhrase = messageWords.join(" ");
  const aliases = new Map<string, Set<string>>();
  const tokenOwners = new Map<string, Set<string>>();

  for (const project of candidates) {
    const projectAliases = new Set<string>();
    const names = [project.name, projectSlug(project.name)];
    const folders = [project.primary_path, ...(project.paths ?? [])]
      .filter((value): value is string => !!value)
      .map(pathBase);
    for (const value of [...names, ...folders]) {
      const alias = words(value).join(" ");
      if (!alias) continue;
      projectAliases.add(alias);
      for (const token of words(value)) {
        if (token.length < 4 || GENERIC_WORDS.has(token)) continue;
        const owners = tokenOwners.get(token) ?? new Set<string>();
        owners.add(project.id);
        tokenOwners.set(token, owners);
      }
    }
    aliases.set(project.id, projectAliases);
  }

  const scored = candidates.map((project) => {
    let score = 0;
    for (const alias of aliases.get(project.id) ?? []) {
      const aliasWords = words(alias);
      const aliasCompact = compact(alias);
      const phraseHit = (` ${messagePhrase} `).includes(` ${alias} `);
      if (phraseHit) score = Math.max(score, 100 + alias.length);
      else if (
        aliasWords.length > 1 &&
        aliasCompact.length >= 4 &&
        messageWordSet.has(aliasCompact)
      ) {
        score = Math.max(score, 90 + aliasCompact.length);
      }
      for (const token of aliasWords) {
        if (
          token.length >= 4 &&
          messageWordSet.has(token) &&
          tokenOwners.get(token)?.size === 1
        ) {
          score = Math.max(score, 40 + token.length);
        }
      }
    }
    return { project, score };
  }).sort((a, b) => b.score - a.score);

  if (!scored[0]?.score || scored[0].score === scored[1]?.score) return null;
  return scored[0].project;
}
