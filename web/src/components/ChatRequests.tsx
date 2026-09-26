import { PermissionAsk, type Ask } from "./PermissionAsk";
import { SafetyBlock, type SafetyBlockNotice } from "./SafetyBlock";
import { UserQuestion, type Question } from "./UserQuestion";
import "./PendingActionBadge.css";

/** Keep each request mounted under its own identity while new requests arrive.
 *  Each card carries the pending-action keys (lib/pendingActions) it answers,
 *  so a badge in the chat list can find it; the wrapper draws no box. */
export function ChatRequests({
  asks, safetyBlocks, questions, onPermissionAnswered, onSafetyAnswered,
  onQuestionsAnswered, onContinue,
}: {
  asks: Ask[];
  safetyBlocks: SafetyBlockNotice[];
  questions: Question[];
  onPermissionAnswered: (id: string) => void;
  onSafetyAnswered: (id: string) => void;
  onQuestionsAnswered: (ids: string[]) => void;
  onContinue: (message: string) => Promise<void>;
}) {
  // One card answers every batch of this chat's questions.
  const questionKeys = [...new Set(questions.map((q) => `question:${q.batch || q.id}`))].join(" ");
  return (
    <>
      {asks.map((ask) => (
        <div key={ask.id} className="pending-target" data-pending-keys={`permission:${ask.id}`}>
          <PermissionAsk ask={ask} onAnswered={onPermissionAnswered} />
        </div>
      ))}
      {safetyBlocks.map((block) => (
        <div key={block.id} className="pending-target" data-pending-keys={`safety:${block.id}`}>
          <SafetyBlock block={block} onContinue={onContinue} onAnswered={onSafetyAnswered} />
        </div>
      ))}
      {questions.length > 0 && (
        <div key={questions[0].id} className="pending-target" data-pending-keys={questionKeys}>
          <UserQuestion questions={questions} onDone={onQuestionsAnswered} />
        </div>
      )}
    </>
  );
}
