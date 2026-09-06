import { PermissionAsk, type Ask } from "./PermissionAsk";
import { SafetyBlock, type SafetyBlockNotice } from "./SafetyBlock";
import { UserQuestion, type Question } from "./UserQuestion";

/** Keep each request mounted under its own identity while new requests arrive. */
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
  return (
    <>
      {asks.map((ask) => (
        <PermissionAsk key={ask.id} ask={ask} onAnswered={onPermissionAnswered} />
      ))}
      {safetyBlocks.map((block) => (
        <SafetyBlock key={block.id} block={block} onContinue={onContinue} onAnswered={onSafetyAnswered} />
      ))}
      {questions.length > 0 && (
        <UserQuestion key={questions[0].id} questions={questions} onDone={onQuestionsAnswered} />
      )}
    </>
  );
}
