// Splitting a conversation into runs of one speaker (moved verbatim from MessageList.tsx).
import type { Message } from "./chat";

/** Split the conversation into runs of one speaker. */
export function groupTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = [];
  for (const m of messages) {
    const last = turns[turns.length - 1];
    // Same side AND same voice. Role alone was right while a conversation had
    // one agent in it: think, call a tool, answer again is one reply and wants
    // one label. In a room it is wrong the moment two seats are consecutive —
    // the second seat's words would be drawn under the first seat's name.
    // A follow-up brief never joins anything, in either direction. It is drawn
    // as one line instead of as its words (see lib/relay), and a line that had
    // swallowed the message you typed just before it would put your words
    // nowhere on screen.
    // Two things you typed are two things, always. Follow-ups are a real FIFO
    // queue now for BOTH providers — the backend holds each one until the agent
    // is ready for it — and one bubble over several of them hid which was
    // which: the moment the first was picked up the combined bubble lost its
    // queued clock while the rest were still waiting, and the ✕ that takes one
    // back had no single message to name.
    //
    // This was Codex-only while Claude's messages went straight down its stdin
    // and were nobody's to hold. They are ours now — see `QueuedTurn`.
    const ownTurn = m.role === "user" && last?.[0].role === "user";
    // Those early user bubbles also mean two later Codex answers can be
    // consecutive in the stored array. Different reply targets are different
    // turns even though both are assistant messages; merging them would put the
    // second answer under the first prompt's label.
    const differentReplyTarget =
      m.replyTo?.id !== last?.[0].replyTo?.id && (!!m.replyTo || !!last?.[0].replyTo);
    const hostPlanRecord = (message?: Message) => message?.blocks.some((b) => b.kind === "planAutoApproved");
    const alone = !!last?.at(-1)?.turnEnd || !!m.relay || !!last?.[0].relay || ownTurn || differentReplyTarget || hostPlanRecord(m) || hostPlanRecord(last?.[0]);
    if (!alone && last && last[0].role === m.role && last[0].speaker?.id === m.speaker?.id)
      last.push(m);
    else turns.push([m]);
  }
  return turns;
}
