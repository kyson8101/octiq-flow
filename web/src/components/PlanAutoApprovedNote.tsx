import type { PlanAutoApproved } from "../lib/planAutoApproved";
import { FoldBody, FoldLine, useFold } from "./CardFold";
import "./AutoPlan.css";

export function PlanAutoApprovedNote({ record, startOpen = false }: { record: PlanAutoApproved; startOpen?: boolean }) {
  const fold = useFold(record.id, { startOpen });
  const n = record.taskIds.length;
  return <div className="auto-plan-approved" role="group" aria-label="Plan auto-approved">
    <FoldLine fold={fold} labels={[`Plan auto-approved · revision ${record.revision} · ${n} task${n === 1 ? "" : "s"}`]} what="the task titles" />
    <FoldBody fold={fold} bounded={false}>
      <ul className="auto-plan-titles">{record.taskTitles.map((title, i) => <li key={i}>{title}</li>)}</ul>
    </FoldBody>
  </div>;
}
