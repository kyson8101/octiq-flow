import { PermissionAsk, type Ask } from "./PermissionAsk";
import { AccessRequestCard, type AnswerAccess } from "./AccessRequestCard";
import type { AccessRequest } from "../lib/accessRequest";
import { SafetyBlock, type Continue, type SafetyBlockNotice } from "./SafetyBlock";
import { useLateKeys } from "../lib/useArrival";
import { Arrive } from "./Arrive";
import "./PendingActionBadge.css";

/** Keep each request mounted under its own identity while new requests arrive.
 *  Each card carries the pending-action keys (lib/pendingActions) it answers,
 *  so a badge in the chat list can find it; the wrapper draws no box.
 *
 *  A question is not among them: it is drawn in the transcript, where it was
 *  asked (`components/InlineQuestions`). */
export function ChatRequests({
  asks, safetyBlocks, onPermissionAnswered, onSafetyAnswered,
  onContinue, accessRequests = [], onAccessAnswer, scope = "", agent,
}: {
  asks: Ask[];
  safetyBlocks: SafetyBlockNotice[];
  onPermissionAnswered: (id: string) => void;
  onSafetyAnswered: (id: string) => void;
  onContinue: Continue;
  /** Asks for a higher access level: the agent's own, and the one an
   *  Antigravity refusal makes. Drawn only with a way to answer them. */
  accessRequests?: AccessRequest[];
  onAccessAnswer?: AnswerAccess;
  /** The chat these belong to. A card that turns up after its chat was drawn
   *  comes in (`components/Arrive`); one already waiting when the chat opens,
   *  or when you come back to it, is drawn in place. */
  scope?: string;
  agent?: string;
}) {
  const shownAccess = onAccessAnswer ? accessRequests : [];
  const late = useLateKeys(scope, [
    ...asks.map((ask) => `permission:${ask.id}`),
    ...shownAccess.map((request) => `access:${request.id}`),
    ...safetyBlocks.map((block) => `safety:${block.id}`),
  ]);
  return (
    <>
      {asks.map((ask) => (
        <Arrive key={ask.id} late={late.has(`permission:${ask.id}`)}>
          <div className="pending-target" data-pending-keys={`permission:${ask.id}`}>
            <PermissionAsk ask={ask} agent={agent} onAnswered={onPermissionAnswered} />
          </div>
        </Arrive>
      ))}
      {onAccessAnswer && accessRequests.map((request) => (
        <Arrive key={request.id} late={late.has(`access:${request.id}`)}>
          <div className="pending-target"
            data-pending-keys={request.local ? undefined : `access:${request.id}`}>
            <AccessRequestCard request={request} onAnswer={onAccessAnswer} />
          </div>
        </Arrive>
      ))}
      {safetyBlocks.map((block) => (
        <Arrive key={block.id} late={late.has(`safety:${block.id}`)}>
          <div className="pending-target" data-pending-keys={`safety:${block.id}`}>
            <SafetyBlock block={block} onContinue={onContinue} onAnswered={onSafetyAnswered} />
          </div>
        </Arrive>
      ))}
    </>
  );
}

/** Auto-mode refusals the agent carried on past (`lib/safetyToast`), as lines
 *  at the end of the transcript. Each still carries its card's pending key, so
 *  a badge finds the line exactly as it would the card. `reveal` names the
 *  line the notice's Details asked for; its `n` changes on every ask. */
export function SafetyLines({
  blocks, reveal, onSafetyAnswered, onContinue, late,
}: {
  /** The `safety:<id>` keys that turned up after the chat was drawn. */
  late?: ReadonlySet<string>;
  blocks: SafetyBlockNotice[];
  reveal?: { id: string; n: number } | null;
  onSafetyAnswered: (id: string) => void;
  onContinue: Continue;
}) {
  if (!blocks.length) return null;
  return (
    <div className="safety-lines">
      {blocks.map((block) => (
        <Arrive key={block.id} late={!!late?.has(`safety:${block.id}`)}>
          <div className="pending-target" data-pending-keys={`safety:${block.id}`}>
            <SafetyBlock block={block} folded reveal={reveal?.id === block.id ? reveal.n : undefined}
              onContinue={onContinue} onAnswered={onSafetyAnswered} />
          </div>
        </Arrive>
      ))}
    </div>
  );
}
