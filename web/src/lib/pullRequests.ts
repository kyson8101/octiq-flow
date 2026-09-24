export type PrSource = "local" | "github";
export type PrRemoteState = "open" | "closed" | "merged" | "all";

export type PrRepository = {
  root: string;
  name: string;
  branches: string[];
  defaultBase: string;
};

export type PrSummary = {
  id: string;
  source: PrSource;
  root: string;
  title: string;
  number: number | null;
  url: string | null;
  state: "local" | "open" | "draft" | "closed" | "merged";
  branch: string;
  base: string;
  headSha: string;
  baseSha: string;
  author: string;
  updatedAt: string;
  commitCount: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  approved: boolean;
  worktreePath: string | null;
};

export type PrList = { items: PrSummary[]; warnings: string[] };

export type PrFile = {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string | null;
  patchUnavailable: string | null;
};

export type PrCommit = { sha: string; title: string; author: string };

export type PrDetail = {
  pr: PrSummary;
  body: string;
  files: PrFile[];
  commits: PrCommit[];
  mergeBaseSha: string | null;
  warnings: string[];
};

export type PrPatch = { text: string; binary: boolean; tooLarge: boolean };

export type PrTicketLink = { reference: string; url: string | null };
export type PrTicketAction = {
  id: string;
  headSha: string;
  status: "pending" | "running" | "confirmed" | "failed";
  chatId: string | null;
  message: string;
  updatedAt: number;
};
export type PrCompletion = {
  state: "pending" | "completed";
  trigger: "approved" | "merged";
  headSha: string;
  completedAt: number | null;
  note: string;
};
export type PrWorkflow = {
  root: string;
  number: number;
  url: string;
  headSha: string;
  baseSha: string;
  chatId: string | null;
  ticket: PrTicketLink | null;
  completeOn: "approved" | "merged";
  completion: PrCompletion;
  ticketAction: PrTicketAction | null;
  updatedAt: number;
};
export type PrTicketLaunch = {
  workflow: PrWorkflow;
  actionId: string;
  prompt: string;
  cwd: string;
  title: string;
};

export type PrAgentAction = "study" | "review" | "publish";
export type PrAgentLaunch = {
  projectId: string;
  cwd: string;
  title: string;
  prompt: string;
};

export function prKey(pr: Pick<PrSummary, "source" | "number" | "branch" | "base">): string {
  return pr.source === "github" ? `github:${pr.number}` : `local:${pr.branch}:${pr.base}`;
}

export function shortSha(sha: string): string {
  return sha ? sha.slice(0, 8) : "unknown";
}

export function filterPullRequests(items: readonly PrSummary[], query: string): PrSummary[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((item) => {
    const haystack = [
      item.title,
      item.branch,
      item.base,
      item.author,
      item.number == null ? "" : `#${item.number} ${item.number}`,
      item.state,
      item.reviewDecision,
    ].join(" ").toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export function prAgentPrompt(action: PrAgentAction, detail: PrDetail): { title: string; prompt: string; cwd: string } {
  const { pr } = detail;
  const cwd = pr.worktreePath || pr.root;
  const identity = pr.number == null ? `${pr.branch} → ${pr.base}` : `#${pr.number} ${pr.title}`;
  const pinned = [
    `Repository root: ${pr.root}`,
    `Working directory: ${cwd}`,
    `Source: ${pr.source}`,
    `Branch: ${pr.branch}`,
    `Base branch: ${pr.base}`,
    `Pinned head SHA: ${pr.headSha}`,
    `Pinned base SHA: ${pr.baseSha}`,
    `Pinned merge-base SHA: ${detail.mergeBaseSha ?? "unavailable"}`,
    `Pull request URL: ${pr.url ?? "not published"}`,
  ].join("\n");

  if (action === "publish") {
    return {
      cwd,
      title: `Publish ${pr.branch}`,
      prompt: [
        `Create a GitHub pull request for the local branch ${identity}.`,
        "",
        pinned,
        "",
        "The user explicitly chose Create GitHub PR for this branch. Verify that the branch and base still resolve to the pinned SHAs before performing any external write. If either moved, stop and explain the mismatch. Use the repository's normal PR template and non-interactive gh commands, target the named base branch, and report the created URL. Do not merge the pull request, modify files, create commits, or update tickets.",
      ].join("\n"),
    };
  }

  const purpose = action === "review"
    ? "Review this exact pull request snapshot. Return findings first, ordered by severity, with file and line references. Check correctness, regressions, tests, security boundaries, and maintainability."
    : "Study this exact pull request snapshot. Explain its intent, architecture, important changes, risks, and the most useful verification steps.";
  return {
    cwd,
    title: `${action === "review" ? "Review" : "Study"} ${identity}`,
    prompt: [
      purpose,
      "",
      pinned,
      "",
      "Inspect the pinned refs without changing repository or remote state. Do not edit files, create commits, push, merge, publish a review, post comments, or update tickets. If the live branch has moved, keep the analysis on the pinned SHAs and call out the difference.",
    ].join("\n"),
  };
}

export type UnifiedDiffLine = {
  kind: "context" | "add" | "delete" | "hunk" | "meta";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

/** Turn a unified patch into display rows while preserving the original text.
 * Numbering is based only on hunk ranges: headers and file metadata never
 * consume a source line, and additions/deletions advance only their side. */
export function parseUnifiedDiff(text: string): UnifiedDiffLine[] {
  const raw = text.split("\n");
  if (raw.length > 1 && raw.at(-1) === "") raw.pop();
  let oldLine: number | null = null;
  let newLine: number | null = null;
  return raw.map((line) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { kind: "hunk", text: line, oldLine: null, newLine: null };
    }
    if (oldLine != null && newLine != null && line.startsWith("+") && !line.startsWith("+++")) {
      const row = { kind: "add" as const, text: line, oldLine: null, newLine };
      newLine += 1;
      return row;
    }
    if (oldLine != null && newLine != null && line.startsWith("-") && !line.startsWith("---")) {
      const row = { kind: "delete" as const, text: line, oldLine, newLine: null };
      oldLine += 1;
      return row;
    }
    if (oldLine != null && newLine != null && (line.startsWith(" ") || line === "")) {
      const row = { kind: "context" as const, text: line, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return row;
    }
    return { kind: "meta", text: line, oldLine: null, newLine: null };
  });
}

/** Small sequence guard used by selector-driven requests. A late response can
 * be identified without cancelling the command or coupling it to React. */
export function createRequestGate() {
  let current = 0;
  return {
    next(): number { current += 1; return current; },
    current(token: number): boolean { return token === current; },
    cancel(): void { current += 1; },
  };
}

export function completionLabel(workflow: PrWorkflow): string {
  const completion = workflow.completion;
  if (completion.state === "completed") {
    return completion.trigger === "approved" ? "Completed by current-head approval" : "Completed by merge";
  }
  return completion.note || (completion.trigger === "approved" ? "Waiting for current-head approval" : "Waiting for merge");
}

export function ticketActionLabel(action: PrTicketAction | null): string {
  if (!action) return "Not started";
  if (action.status === "confirmed") return "User confirmed updated";
  if (action.status === "running") return "Agent working — confirmation required";
  if (action.status === "pending") return "Preparing agent chat";
  return action.message || "Update failed — ready to retry";
}
