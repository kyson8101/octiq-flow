import type { WorkspaceGitStatus } from "./workspaceContext";

/** One event for every view that annotates project or repository state. */
export const PROJECT_GIT_CHANGED_EVENT = "octiq-git-changed";

export type ProjectGitSource = {
  id: string;
  primary_path?: string;
  paths?: string[];
};

/** Every folder the shared backend watcher must cover, without duplicates. */
export function projectGitPaths(projects: readonly ProjectGitSource[]): string[] {
  const paths = new Set<string>();
  for (const project of projects) {
    for (const path of [project.primary_path, ...(project.paths ?? [])]) {
      if (path?.trim()) paths.add(path);
    }
  }
  return [...paths];
}

/** The paths chats actually start in. These alone answer which branch to show. */
export function projectPrimaryPaths(projects: readonly ProjectGitSource[]): string[] {
  return [...new Set(projects.flatMap((project) => project.primary_path?.trim() ? [project.primary_path] : []))];
}

/** Match each project to the checked-out branch of its primary path. */
export function branchesByProject(
  projects: readonly ProjectGitSource[],
  statuses: readonly WorkspaceGitStatus[],
): Record<string, string> {
  const byPath = new Map(statuses.map((status) => [status.path, status]));
  const branches: Record<string, string> = {};
  for (const project of projects) {
    if (!project.primary_path) continue;
    const status = byPath.get(project.primary_path);
    if (status?.is_repo && status.branch) branches[project.id] = status.branch;
  }
  return branches;
}
