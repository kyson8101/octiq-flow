// The lead's plan at the end of its own chat, while it waits for the person.
//
// The same PlanReview the run panel draws, over the same ledger snapshot, so
// the two cannot disagree and an approval from either shows in both. A plan
// waiting for the person is open, with Approve and a line on how to answer in
// chat. Once the host records the decision the card leaves the chat: a
// settled plan above the message box is a row of nothing to do. The record of
// how it was approved stays in the run panel (`ApprovedPlan`). A plan the lead
// changes after approval is a new revision, waiting again, and comes back.
import { approvalLabel, chatApprovalHint, type ChatPlan } from "../lib/chatPlans";
import { PlanReview } from "./PlanReview";
import "./ChatPlanCards.css";

/** Changes are asked for in the message box under the card, so the card's
 *  own change box is not drawn and never called. */
const inChat = () => {};

export function ChatPlanCards({ plans, drafting, projectName }: {
  plans: ChatPlan[];
  /** The lead is mid-turn. */
  drafting: boolean;
  projectName?: (id: string) => string | undefined;
}) {
  const pending = plans.filter((plan) => plan.pending);
  if (!pending.length) return null;
  return (
    <div className="chat-plans">
      {pending.map((plan) => (
        <div className="chat-plan" key={plan.run.id} data-pending="">
          <PlanReview run={plan.run} tasks={plan.tasks} drafting={drafting} projectName={projectName}
            chatHint={chatApprovalHint(plan, pending.length)} onRequestChanges={inChat} surface="chat" />
        </div>
      ))}
    </div>
  );
}

/** An approved plan, folded to one line that names how it was approved and
 *  which revision, opening to the plan it covered. Drawn in the run panel,
 *  where the run's history lives. */
export function ApprovedPlan({ plan, projectName }: {
  plan: ChatPlan;
  projectName?: (id: string) => string | undefined;
}) {
  const consent = plan.run.planApproval?.consent;
  return (
    <details className="chat-plan chat-plan-approved" key={`${plan.run.id}:${consent?.revision ?? plan.revision}`}>
      <summary>
        <span className="chat-plan-mark" aria-hidden="true" />
        <span className="chat-plan-line">{approvalLabel(plan)}</span>
        <span className="chat-plan-id">Plan {plan.handle}</span>
        <span className="plan-task-chevron" aria-hidden="true" />
      </summary>
      {consent?.words && <p className="chat-plan-words">You said: “{consent.words}”</p>}
      <PlanReview run={plan.run} tasks={plan.tasks} drafting={false} projectName={projectName}
        approved onRequestChanges={inChat} />
    </details>
  );
}
