// Agents mode: where a new task RUNS, decided without asking.
//
// The compact composer has no project, branch, worktree or sandbox controls on
// show. Something still has to choose them, and it is this — a pure rule, so
// the choice is the same on every device and every rule is a test:
//
//   * The head (the CTO) coordinates from the person's HOME workspace. It is
//     never given a code checkout of its own: every task it hands out is
//     routed by the host to a registered project and repository, and gets its
//     own environment when the plan is approved. So no git is prepared, and
//     no sandbox is started for the conversation itself.
//   * A lead in a project starts in a NEW WORKTREE of that project, based on
//     the branch the project is on. The primary checkout is where the person
//     and other chats work; a lead that does the work itself must not write
//     there. The host resolves the base branch and makes the worktree, and a
//     folder that turns out not to be a repository simply runs in place.
//   * A lead with no project coordinates from home, like the head.
//
// Advanced overrides are the person's: any field they set wins, and the plan
// says it was theirs. The result is recorded on the chat (the index's
// `launch`) as the PLAN; what actually happened is verified with git.
export type ExecutionProject = {
  id: string;
  name: string;
  primary_path?: string;
};

export type ExecutionRepo = {
  isRepo: boolean;
  current: string;
  loading?: boolean;
  error?: string;
};

/** Only the fields the person actually changed under Advanced. */
export type ExecutionOverrides = {
  projectId?: string | null;
  branch?: string;
  newWorktree?: boolean;
  useSandbox?: boolean;
};

export type ExecutionPlan = {
  /** `home`: the coordination home (General unless configured). */
  target: "home" | "project";
  projectId: string | null;
  /** Ask the host to prepare git (branch / worktree) before the first turn. */
  prepare: boolean;
  /** The base branch; "" lets the host use the branch the project is on. */
  branch: string;
  newWorktree: boolean;
  useSandbox: boolean;
  chosenBy: "auto" | "advanced";
  /** One line for the details, in the person's words. */
  reason: string;
};

export function isHomeName(name: string | undefined): boolean {
  return (name ?? "").trim().toLowerCase() === "general";
}

export function autoExecution(input: {
  toHead: boolean;
  project: ExecutionProject | null;
  /** The coordination home's id, when one is configured and exists. */
  homeId?: string | null;
  repo?: ExecutionRepo | null;
  sandboxDefault: boolean;
  overrides?: ExecutionOverrides | null;
}): ExecutionPlan {
  const { toHead, project, homeId, repo, sandboxDefault } = input;
  const overrides = input.overrides ?? {};
  const overridden = Object.values(overrides).some((value) => value !== undefined);

  if (toHead) {
    // The head's conversation is never re-pointed by Advanced: it is the
    // coordination conversation, and its tasks carry their own destinations.
    return {
      target: "home",
      projectId: homeId ?? null,
      prepare: false,
      branch: "",
      newWorktree: false,
      useSandbox: false,
      chosenBy: "auto",
      reason: "Coordinates from your home workspace. Each task it hands out runs where the host routes it.",
    };
  }

  const projectId = overrides.projectId !== undefined ? overrides.projectId : project?.id ?? null;
  const atHome = !projectId || projectId === homeId
    || (projectId === project?.id && isHomeName(project?.name));
  if (atHome) {
    return {
      target: "home",
      projectId: projectId ?? homeId ?? null,
      prepare: false,
      branch: "",
      newWorktree: false,
      useSandbox: overrides.useSandbox ?? false,
      chosenBy: overridden ? "advanced" : "auto",
      reason: "No code project: works from your home workspace.",
    };
  }

  const repoKnown = !!repo && !repo.loading && !repo.error;
  const branch = overrides.branch ?? (repoKnown && repo.isRepo ? repo.current : "");
  const newWorktree = overrides.newWorktree ?? true;
  const useSandbox = overrides.useSandbox ?? sandboxDefault;
  const base = branch || "the project's current branch";
  const reason = overridden
    ? "Chosen under Advanced."
    : repoKnown && !repo.isRepo
      ? "Not a Git repository: works in the project folder."
      : `New worktree from ${base}, so the primary checkout stays untouched.`;
  return {
    target: "project",
    projectId,
    prepare: true,
    branch,
    newWorktree,
    useSandbox,
    chosenBy: overridden ? "advanced" : "auto",
    reason,
  };
}
