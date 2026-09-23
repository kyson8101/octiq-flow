// What this chat is doing, and what became of it.
//
// The backend (`chat_task.rs`) hands over two kinds of fact and keeps them
// apart on purpose: what the AGENT said the task is, and what GIT says about
// where the work got to. This module turns that into the handful of words the
// status line shows, and it is pure so those words can be tested without a
// backend, a browser or a repository.
//
// Two rules run through everything below:
//
//   * **Unverified is a real answer.** `released: null` means nobody has told
//     this project how a release is recognised. It is not "no", and it must
//     never be shown as one.
//   * **The next step is what to show.** A finished chat is not interesting
//     because it finished; it is interesting because something is still owed —
//     a commit, a push, a merge, a release. The label names that, so a chat
//     read a week later says what is left rather than what happened.

export type StepState = "done" | "active" | "pending";

export type TaskStep = { title: string; state: StepState };

export type TaskReport = {
  objective: string;
  nextStep: string;
  steps: TaskStep[];
  reportedAt: number;
  reportedBy: string;
};

export type TaskTarget = { branch: string; setAt: number; setBy: string };

export type TaskWorkspace = {
  cwd: string;
  exists: boolean;
  isRepo: boolean;
  repoRoot: string;
  primaryRoot: string;
  branch: string;
  isWorktree: boolean;
  changed: number;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
};

export type TaskDelivery = {
  target: string;
  head: string;
  onTarget: boolean;
  commits: number;
  uncommitted: number;
  pushed: boolean;
  merged: boolean;
  mergedRemote: boolean;
  /** `null` is "unverified" — no release check is configured. Never "no". */
  released: boolean | null;
  releaseNote: string;
  /** True when the chat's directory is gone and this came from the primary
   *  checkout against the commit that was remembered. */
  stale: boolean;
  checkedAt: number;
};

export type TaskStatus = {
  chatId: string;
  report?: TaskReport;
  target?: TaskTarget;
  workspace?: TaskWorkspace;
  delivery?: TaskDelivery;
};

/** What is owed next, in the order the work actually goes. */
export type DeliveryStage =
  | "unverified"
  | "nothing-yet"
  | "to-commit"
  | "to-merge"
  | "to-push"
  | "to-release"
  | "released";

/** How loud a state is allowed to be.
 *
 *  `accent` is reserved for a turn that is IN FLIGHT — the one moving thing —
 *  and `warn` for something waiting on the person. Everything a chat is merely
 *  owed stays quiet: a row of amber chips across four open tabs is noise, and
 *  noise is what made the status line worth reading gone. */
export type Tone = "accent" | "warn" | "ok" | "quiet";

export const DELIVERY_LABELS: Record<DeliveryStage, string> = {
  unverified: "Unverified",
  "nothing-yet": "No changes yet",
  "to-commit": "To commit",
  "to-merge": "To merge",
  "to-push": "To push",
  "to-release": "To release",
  released: "Released",
};

/** Where the work has got to.
 *
 *  Order matters and is the order of the work itself. The one that reads
 *  backwards is `to-push`: it is NOT "this branch was never pushed" — that is
 *  part of `to-merge`, since an unmerged branch is owed a merge whatever its
 *  remote says. It is the narrower, easily-missed state of a merge that
 *  happened on this machine only, where the target branch is ahead locally and
 *  nobody else can see any of it. */
export function deliveryStage(delivery?: TaskDelivery): DeliveryStage {
  if (!delivery) return "unverified";
  if (delivery.uncommitted > 0) return "to-commit";
  if (delivery.onTarget) {
    // Working straight on the target branch: there is no merge to wait for,
    // so committed-and-pushed is as far as delivery goes before release.
    if (delivery.commits > 0 && !delivery.pushed) return "to-push";
    return releaseStage(delivery);
  }
  if (delivery.commits === 0) {
    // Nothing on this branch that the target does not already have. Either
    // nothing was done, or it has all landed — `merged` tells them apart.
    return delivery.merged ? releaseStage(delivery) : "nothing-yet";
  }
  if (!delivery.merged) return "to-merge";
  if (!delivery.mergedRemote) return "to-push";
  return releaseStage(delivery);
}

function releaseStage(delivery: TaskDelivery): DeliveryStage {
  if (delivery.released === null || delivery.released === undefined) return "unverified";
  return delivery.released ? "released" : "to-release";
}

export function deliveryTone(stage: DeliveryStage): Tone {
  if (stage === "released") return "ok";
  return "quiet";
}

/** The live half: what the CHAT is doing, which outranks what it is owed.
 *
 *  A chat mid-turn says so; a chat holding a question says so louder. Only
 *  when neither is true is the delivery state the most useful thing the line
 *  can carry. */
export function phaseOf(
  status: TaskStatus | undefined,
  live: { busy?: boolean; waiting?: boolean } = {},
): { label: string; tone: Tone; stage: DeliveryStage } {
  const stage = deliveryStage(status?.delivery);
  if (live.waiting) return { label: "Needs you", tone: "warn", stage };
  if (live.busy) return { label: "Working", tone: "accent", stage };
  return { label: DELIVERY_LABELS[stage], tone: deliveryTone(stage), stage };
}

/** "2/4", or nothing when the agent reported no plan. Counting is the whole
 *  of the progress claim — the app cannot check a step and does not pretend
 *  to. */
export function stepProgress(report?: TaskReport): string {
  const steps = report?.steps ?? [];
  if (steps.length === 0) return "";
  return `${steps.filter((step) => step.state === "done").length}/${steps.length}`;
}

/** Primary checkout, task worktree, or a folder that is not a repository at
 *  all — the distinction the person asks about by name. */
export function locationOf(workspace?: TaskWorkspace): string {
  if (!workspace) return "Unknown";
  if (!workspace.exists) return workspace.isWorktree ? "Task worktree (removed)" : "Directory removed";
  if (!workspace.isRepo) return "Not a Git repository";
  return workspace.isWorktree ? "Task worktree" : "Primary checkout";
}

/** The working tree in one line. */
export function gitStateOf(workspace?: TaskWorkspace): string {
  if (!workspace || !workspace.isRepo) return "Unknown";
  if (!workspace.exists) return "Directory removed";
  const parts: string[] = [];
  parts.push(workspace.changed === 0 ? "Clean" : `${workspace.changed} changed`);
  if (workspace.ahead > 0) parts.push(`${workspace.ahead} to push`);
  if (workspace.behind > 0) parts.push(`${workspace.behind} behind`);
  if (!workspace.hasUpstream) parts.push("no upstream");
  return parts.join(" · ");
}

/** What the merge row says, in the words of the check behind it. */
export function mergeLine(delivery?: TaskDelivery): string {
  if (!delivery) return "Unverified";
  if (delivery.onTarget) return `Working directly on ${delivery.target}`;
  if (delivery.mergedRemote) return `In origin/${delivery.target}`;
  if (delivery.merged) return `In ${delivery.target} locally — not pushed`;
  if (delivery.commits === 0) return `Nothing committed to merge into ${delivery.target} yet`;
  return `Not in ${delivery.target}`;
}

export function commitLine(delivery?: TaskDelivery): string {
  if (!delivery) return "Unverified";
  const bits: string[] = [];
  if (delivery.commits > 0) bits.push(`${delivery.commits} commit${delivery.commits === 1 ? "" : "s"}`);
  if (delivery.uncommitted > 0) bits.push(`${delivery.uncommitted} uncommitted`);
  if (bits.length === 0) return "Nothing committed for this task";
  if (delivery.pushed && delivery.commits > 0) bits.push("pushed");
  return bits.join(" · ");
}

export function releaseLine(delivery?: TaskDelivery): string {
  if (!delivery) return "Unverified";
  if (delivery.released === true) return "Released";
  if (delivery.released === false) return "Not in the released build";
  return "Unverified";
}

/** A time as a person reads it, computed once per render.
 *
 *  Deliberately coarse. A status line is not a stopwatch, and a number that
 *  changes every second is a thing moving on screen for no reason. */
export function agoLabel(then: number, now: number): string {
  if (!then) return "never";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** How the progress half is introduced when the agent never reported.
 *
 *  The app will not infer an objective from the transcript: a guessed
 *  objective that is nearly right is worse than an honest blank, because it
 *  is the line everything else is read against. */
export const NOT_REPORTED = "Not reported by the agent";
