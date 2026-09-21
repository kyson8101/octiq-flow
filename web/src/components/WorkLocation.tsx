import { projectSlug } from "../lib/projectSlug";

export type WorkLocationProject = {
  id: string;
  name: string;
};

export type WorkLocationBranches = {
  isRepo: boolean;
  current: string;
  branches: string[];
  isWorktree: boolean;
  loading?: boolean;
  error?: string;
};

const EMPTY: WorkLocationBranches = {
  isRepo: false,
  current: "",
  branches: [],
  isWorktree: false,
};

/** The execution context chosen before a new chat starts. */
export function WorkLocation({
  projects,
  projectId,
  onProject,
  branch,
  branches = EMPTY,
  onBranch,
  newWorktree,
  onNewWorktree,
}: {
  projects: readonly WorkLocationProject[];
  projectId: string | null;
  onProject: (id: string | null) => void;
  branch: string;
  branches?: WorkLocationBranches;
  onBranch: (branch: string) => void;
  newWorktree: boolean;
  onNewWorktree: (enabled: boolean) => void;
}) {
  const offeredProjects = projects.filter((project) => projectSlug(project.name) !== "general");
  const branchOptions = branch && !branches.branches.includes(branch)
    ? [branch, ...branches.branches]
    : branches.branches;
  const branchText = branches.loading
    ? "Finding branches…"
    : branches.error
      ? "Branches unavailable"
      : !branches.isRepo
        ? "No Git repository"
        : branch || branches.current || "No branch";

  return (
    <div className="work-location" aria-label="Work location">
      <label className="work-location-field" title="Project">
        <FolderIcon />
        <span className="sr-only">Project</span>
        <select
          aria-label="Project"
          value={projectId ?? ""}
          onChange={(event) => onProject(event.target.value || null)}
        >
          <option value="">General</option>
          {offeredProjects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </label>

      <span className="work-location-divider" aria-hidden="true" />

      <label
        className={`work-location-field is-branch ${!branches.isRepo ? "is-muted" : ""}`}
        title={newWorktree ? "Base branch" : "Branch"}
      >
        <BranchIcon />
        <span className="sr-only">{newWorktree ? "Base branch" : "Branch"}</span>
        <select
          aria-label={newWorktree ? "Base branch" : "Branch"}
          value={branch}
          disabled={branches.loading || !branches.isRepo}
          onChange={(event) => onBranch(event.target.value)}
        >
          {!branchOptions.length && <option value="">{branchText}</option>}
          {branchOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>

      <span className="work-location-spacer" />

      <label
        className={`worktree-choice ${branches.isWorktree ? "is-active" : ""}`}
        title={branches.isWorktree ? "This chat runs in a linked worktree" : "Create a task branch in a new linked worktree"}
      >
        <input
          type="checkbox"
          checked={newWorktree}
          disabled={!branches.isRepo}
          onChange={(event) => onNewWorktree(event.target.checked)}
        />
        <WorktreeIcon />
        <span>New worktree</span>
      </label>

      {branches.error && <span className="work-location-error" role="status">{branches.error}</span>}
    </div>
  );
}

function FolderIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7.5h7l2 2h9v9.5H3z" /><path d="M3 7.5V5h7l2 2h9v2.5" /></svg>;
}

function BranchIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="2" /><circle cx="18" cy="7" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M8 10h4a6 6 0 0 0 6-1" /></svg>;
}

function WorktreeIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="12" cy="18" r="2" /><path d="M6 8v2a4 4 0 0 0 4 4h2M18 8v2a4 4 0 0 1-4 4h-2v2" /></svg>;
}
