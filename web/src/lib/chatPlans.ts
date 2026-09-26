// A lead's plan, drawn in its own conversation.
//
// The card at the end of a lead's chat is the SAME plan the run panel shows,
// read from the same ledger snapshot — never a summary the agent wrote, and
// never a copy frozen into the transcript. What it shows is always the plan's
// current revision; an approval covers only the revision it names, so a plan
// that changes after it was approved comes back as a new, unapproved revision
// rather than silently inheriting the old approval.
//
// `seenPlans` is what a send tells the host the person had on screen. It is
// computed from the very list the card draws, so the two cannot disagree: a
// chat approval is honoured only for a plan, at a revision, that was there.
import type { OrchestrationRun, OrchestrationSnapshot, OrchestrationTask } from "./orchestration";

export type ChatPlan = {
  run: OrchestrationRun;
  tasks: OrchestrationTask[];
  /** "2278": what the person calls this plan in chat when several wait. */
  handle: string;
  revision: number;
  pending: boolean;
};

export type SeenPlan = { runId: string; revision: number };

const LIVE = new Set(["planning", "running", "waiting"]);

/** The first four hex digits of the run id — the host's `plan_handle`. */
export function planHandle(runId: string): string {
  return runId.replace(/^run_/, "").replace(/[^0-9a-f]/gi, "").slice(0, 4).toLowerCase();
}

/** Every plan this chat leads, waiting ones first. A plan is shown while its
 *  run is live and not archived; after that the run panel has it. */
export function chatPlans(snapshot: OrchestrationSnapshot | null | undefined, chatKey: string | null | undefined): ChatPlan[] {
  if (!snapshot || !chatKey) return [];
  return snapshot.runs
    .filter((run) => run.coordinatorChatKey === chatKey && !!run.planApproval && LIVE.has(run.status) && run.archivedAt == null)
    .map((run) => ({
      run,
      tasks: snapshot.tasks.filter((task) => task.runId === run.id),
      handle: planHandle(run.id),
      revision: run.planApproval?.revision ?? 0,
      pending: run.planApproval?.status === "pending",
    }))
    .sort((a, b) => Number(b.pending) - Number(a.pending) || a.run.createdAt - b.run.createdAt);
}

/** The plans a message sent now was written looking at. */
export function seenPlans(plans: ChatPlan[]): SeenPlan[] {
  return plans.filter((plan) => plan.pending).map((plan) => ({ runId: plan.run.id, revision: plan.revision }));
}

/** One line for an approved plan: how, and which revision. The person's own
 *  words stay behind the card's disclosure. */
export function approvalLabel(plan: ChatPlan): string {
  const consent = plan.run.planApproval?.consent;
  const how = consent?.via === "conversation" ? "Approved in chat" : "Approved";
  const revision = consent?.revision ?? plan.revision;
  return revision ? `${how} · revision ${revision}` : how;
}

/** What a pending card tells the person about approving by chat: a plain
 *  "approve this plan" works when one plan waits; with several, the handle. */
export function chatApprovalHint(plan: ChatPlan, waiting: number): string {
  return waiting > 1
    ? `Reply "approve plan ${plan.handle}" below, or ask for changes.`
    : `Reply "approve this plan" below, or ask for changes.`;
}
