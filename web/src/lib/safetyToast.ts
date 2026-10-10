// Claude's auto mode refused a call and the agent went on working. That is a
// thing to know, not a thing to answer: Claude Code's own terminal says it in
// a line at the bottom for a few seconds. So does this page — a short notice
// over the foot of the transcript, and one folded line in the transcript that
// holds the card. The full card is kept for the refusal the agent stopped on.
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { requestConversation } from "./pendingRequests";
import type { SafetyBlockNotice } from "../components/SafetyBlock";

/** The one sentence the notice and the folded line both open with. */
export const AUTO_MODE_BLOCKED = "Auto mode blocked an action";
/** The notice's answer to "did anything happen?". */
export const NOTHING_RAN = "nothing ran";

/**
 * A refusal Claude's auto mode JUDGED. An outage card (the classifier gave no
 * verdict) offers a retry and Codex's card offers an approval, so both wait
 * on the person and stay cards whatever the agent is doing.
 */
export function isAutoModeRefusal(block: Pick<SafetyBlockNotice, "provider" | "kind">): boolean {
  return block.provider === "claude" && block.kind !== "outage";
}

/**
 * Which of a chat's safety cards fold into the transcript, and which stay
 * cards above the prompt box. A judged refusal folds only while the turn it
 * happened in is still running: once the turn is over with the refusal still
 * unanswered, the agent has stopped and the person is the next to move.
 */
export function splitSafety<T extends Pick<SafetyBlockNotice, "provider" | "kind">>(
  blocks: readonly T[],
  turnRunning: boolean,
): { folded: T[]; cards: T[] } {
  if (!turnRunning) return { folded: [], cards: [...blocks] };
  return {
    folded: blocks.filter(isAutoModeRefusal),
    cards: blocks.filter((block) => !isAutoModeRefusal(block)),
  };
}

export type SafetyToastState = {
  chatId: string;
  /** The newest refusal: the one the notice describes and Details opens. */
  blockId: string;
  /** Why it was refused, in the classifier's few words. May be empty. */
  reason: string;
  /** Every refusal this notice has stood for, so one announced twice counts once. */
  seen: string[];
};

/**
 * A refusal arriving while a notice is up joins it: the notice describes the
 * newest and counts the rest, rather than stacking a second line. The same
 * card announced again changes nothing, so it does not restart the clock.
 */
export function stackToast(
  before: SafetyToastState | null,
  chatId: string,
  block: Pick<SafetyBlockNotice, "id" | "summary">,
): SafetyToastState {
  const reason = block.summary?.trim() ?? "";
  if (!before || before.chatId !== chatId) return { chatId, blockId: block.id, reason, seen: [block.id] };
  if (before.seen.includes(block.id)) return before;
  return { chatId, blockId: block.id, reason, seen: [...before.seen, block.id] };
}

/**
 * The notice for the chat on screen. It is raised only by a refusal that
 * arrives LIVE — the host's list of what is pending, read on connect and on
 * reopening a chat, never raises one — and only while `running` says that
 * chat's turn is still in flight. Leaving the chat drops it.
 */
export function useSafetyToast(conversationId: string | null, running: boolean) {
  const [toast, setToast] = useState<SafetyToastState | null>(null);
  const now = useRef({ conversationId, running });
  now.current = { conversationId, running };

  useEffect(() => bridge.on<SafetyBlockNotice>("safety-blocked", (block) => {
    const chatId = block ? requestConversation(block) : null;
    if (!chatId || !block.id || !isAutoModeRefusal(block)) return;
    if (chatId !== now.current.conversationId || !now.current.running) return;
    setToast((before) => stackToast(before, chatId, block));
  }), []);

  useEffect(() => setToast(null), [conversationId]);

  const clear = useCallback(() => setToast(null), []);
  return { toast: toast && toast.chatId === conversationId ? toast : null, clear };
}
