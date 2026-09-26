// The lead's plan at the end of its own chat.
//
// The same PlanReview the run panel draws, over the same ledger snapshot, so
// the two cannot disagree and an approval from either shows in both. A plan
// waiting for the person is open, with Approve and a line on how to answer in
// chat; an approved one folds to one line that names how it was approved and
// which revision, and opens to the plan it covered. A plan the lead changes
// after approval is a new revision, waiting again, never the old card.
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
  if (!plans.length) return null;
  const waiting = plans.filter((plan) => plan.pending).length;
  return (
    <div className="chat-plans">
      {plans.map((plan) => plan.pending ? (
        <div className="chat-plan" key={plan.run.id} data-pending="">
          <PlanReview run={plan.run} tasks={plan.tasks} drafting={drafting} projectName={projectName}
            chatHint={chatApprovalHint(plan, waiting)} onRequestChanges={inChat} />
        </div>
      ) : (
        <details className="chat-plan chat-plan-approved" key={`${plan.run.id}:${plan.run.planApproval?.consent?.revision ?? plan.revision}`}>
          <summary>
            <span className="chat-plan-mark" aria-hidden="true" />
            <span className="chat-plan-line">{approvalLabel(plan)}</span>
            <span className="chat-plan-id">Plan {plan.handle}</span>
            <span className="plan-task-chevron" aria-hidden="true" />
          </summary>
          {plan.run.planApproval?.consent?.words && (
            <p className="chat-plan-words">You said: “{plan.run.planApproval.consent.words}”</p>
          )}
          <PlanReview run={plan.run} tasks={plan.tasks} drafting={false} projectName={projectName}
            approved onRequestChanges={inChat} />
        </details>
      ))}
    </div>
  );
}
