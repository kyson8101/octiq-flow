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
  /** Study and review use a real read-only process, independently of the
   * access selected for publication and ticket-writing work. */
  access?: "read";
};

export type PrPreparedAgentChat = {
  chatId: string;
  start: () => Promise<void>;
};

export type PrTicketAgentLaunchResult = {
  kind: "started" | "existing" | "failed";
  phase: "existing" | "save" | "claim" | "start";
  workflow: PrWorkflow | null;
  chatId: string | null;
  message: string;
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

export function prAgentPrompt(action: PrAgentAction, detail: PrDetail): { title: string; prompt: string; cwd: string; access?: "read" } {
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
    access: "read",
    prompt: [
      purpose,
      "",
      pinned,
      "",
      "Inspect the pinned refs without changing repository or remote state. Do not edit files, create commits, push, merge, publish a review, post comments, or update tickets. If the live branch has moved, keep the analysis on the pinned SHAs and call out the difference.",
    ].join("\n"),
  };
}

/** The lazy patch cache belongs to an exact comparison, not just its head.
 * A user can change target branches without moving the feature branch, and
 * repositories can contain identical paths and object ids. */
export function prPatchKey(detail: PrDetail, file: Pick<PrFile, "path">): string {
  return JSON.stringify([
    detail.pr.root,
    detail.mergeBaseSha ?? detail.pr.baseSha,
    detail.pr.headSha,
    file.path,
  ]);
}

/** Complete the ticket launch transaction after pr_ticket_prepare.
 *
 * Saving the durable chat is deliberately separate from starting its process:
 * only the browser that successfully attaches that chat to the pending action
 * may start it. A competing browser either receives the winner's chat or a
 * claim error, and must never mark that winner's action failed. */
export async function launchPrTicketAgent(
  launch: PrTicketLaunch,
  request: PrAgentLaunch,
  operations: {
    prepareChat: (request: PrAgentLaunch) => Promise<PrPreparedAgentChat>;
    attach: (actionId: string, chatId: string) => Promise<PrWorkflow>;
    fail: (actionId: string, message: string) => Promise<PrWorkflow>;
    reload: () => Promise<PrWorkflow | null>;
  },
): Promise<PrTicketAgentLaunchResult> {
  const preparedAction = launch.workflow.ticketAction;
  if (preparedAction?.id === launch.actionId
    && (preparedAction.status === "running" || preparedAction.status === "confirmed")) {
    if (preparedAction.chatId) {
      return {
        kind: "existing",
        phase: "existing",
        workflow: launch.workflow,
        chatId: preparedAction.chatId,
        message: preparedAction.status === "confirmed"
          ? "This ticket update was already confirmed."
          : "This ticket update already has an agent chat.",
      };
    }
    return {
      kind: "failed",
      phase: "claim",
      workflow: launch.workflow,
      chatId: null,
      message: "This ticket action is already running but has no chat to open. Mark it failed before retrying.",
    };
  }

  let prepared: PrPreparedAgentChat;
  try {
    prepared = await operations.prepareChat(request);
  } catch (error) {
    return {
      kind: "failed",
      phase: "save",
      workflow: launch.workflow,
      chatId: null,
      message: `Could not save the ticket agent chat: ${errorMessage(error)}`,
    };
  }

  let claimed: PrWorkflow;
  try {
    claimed = await operations.attach(launch.actionId, prepared.chatId);
  } catch (error) {
    // Attach can reject after another browser claims the action or after fresh
    // PR evidence revokes it. Never restore the snapshot from before the claim.
    let current: PrWorkflow | null;
    try {
      current = await operations.reload();
    } catch (reloadError) {
      return {
        kind: "failed",
        phase: "claim",
        workflow: null,
        chatId: null,
        message: `Could not claim the ticket action: ${errorMessage(error)}. Refresh tracking to recover its current state: ${errorMessage(reloadError)}`,
      };
    }
    const winner = current?.ticketAction;
    if (current?.completion.state === "completed"
      && winner?.id === launch.actionId && winner.chatId
      && (winner.status === "running" || winner.status === "confirmed")) {
      return {
        kind: "existing",
        phase: "existing",
        workflow: current,
        chatId: winner.chatId,
        message: "Another browser already claimed this ticket action. Open its existing chat to continue.",
      };
    }
    return {
      kind: "failed",
      phase: "claim",
      workflow: current,
      chatId: null,
      message: `Could not claim the ticket action: ${errorMessage(error)}`,
    };
  }

  const claimedAction = claimed.ticketAction;
  if (claimedAction?.id !== launch.actionId
    || claimedAction.chatId !== prepared.chatId
    || claimedAction.status !== "running") {
    if (claimedAction?.chatId
      && (claimedAction.status === "running" || claimedAction.status === "confirmed")) {
      return {
        kind: "existing",
        phase: "existing",
        workflow: claimed,
        chatId: claimedAction.chatId,
        message: "Another browser already claimed this ticket action. Open its existing chat to continue.",
      };
    }
    return {
      kind: "failed",
      phase: "claim",
      workflow: claimed,
      chatId: null,
      message: "The ticket action was not claimed by this chat, so its agent was not started.",
    };
  }

  try {
    await prepared.start();
    return {
      kind: "started",
      phase: "start",
      workflow: claimed,
      chatId: prepared.chatId,
      message: "Ticket completion agent started. Confirm the ticket only after checking its result.",
    };
  } catch (error) {
    const startMessage = `Could not start ticket completion: ${errorMessage(error)}`;
    let failed = claimed;
    let message = startMessage;
    try {
      failed = await operations.fail(launch.actionId, startMessage);
    } catch (recordError) {
      message = `${startMessage} The claimed action could not be marked failed: ${errorMessage(recordError)}`;
    }
    return {
      kind: "failed",
      phase: "start",
      workflow: failed,
      chatId: prepared.chatId,
      message,
    };
  }
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
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;
  return raw.map((line) => {
    if (/^diff --(?:git|cc|combined) /.test(line)) {
      oldLine = null;
      newLine = null;
      oldRemaining = 0;
      newRemaining = 0;
      inHunk = false;
      return { kind: "meta", text: line, oldLine: null, newLine: null };
    }
    const hunk = /^@@ -([0-9]+)(?:,([0-9]+))? \+([0-9]+)(?:,([0-9]+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = hunk[2] == null ? 1 : Number(hunk[2]);
      newRemaining = hunk[4] == null ? 1 : Number(hunk[4]);
      inHunk = oldRemaining > 0 || newRemaining > 0;
      return { kind: "hunk", text: line, oldLine: null, newLine: null };
    }
    if (inHunk && line.startsWith("\\ No newline at end of file")) {
      return { kind: "meta", text: line, oldLine: null, newLine: null };
    }
    if (inHunk && oldLine != null && newLine != null && line.startsWith("+")) {
      const row = { kind: "add" as const, text: line, oldLine: null, newLine };
      newLine += 1;
      newRemaining = Math.max(0, newRemaining - 1);
      if (oldRemaining === 0 && newRemaining === 0) inHunk = false;
      return row;
    }
    if (inHunk && oldLine != null && newLine != null && line.startsWith("-")) {
      const row = { kind: "delete" as const, text: line, oldLine, newLine: null };
      oldLine += 1;
      oldRemaining = Math.max(0, oldRemaining - 1);
      if (oldRemaining === 0 && newRemaining === 0) inHunk = false;
      return row;
    }
    if (inHunk && oldLine != null && newLine != null && (line.startsWith(" ") || line === "")) {
      const row = { kind: "context" as const, text: line, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      oldRemaining = Math.max(0, oldRemaining - 1);
      newRemaining = Math.max(0, newRemaining - 1);
      if (oldRemaining === 0 && newRemaining === 0) inHunk = false;
      return row;
    }
    return { kind: "meta", text: line, oldLine: null, newLine: null };
  });
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message ?? error);
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

/** Save/prepare/confirm results and their notices are separate state channels,
 * but a view change or unmount invalidates both as one operation. */
export function createPrMutationGates() {
  const workflow = createRequestGate();
  const launch = createRequestGate();
  return {
    workflow,
    launch,
    invalidate(): void {
      workflow.cancel();
      launch.cancel();
    },
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
