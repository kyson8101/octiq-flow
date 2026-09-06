import { useEffect, useMemo, useState } from "react";
import { emptyAttentionObservation, observeAttention, selectAttention, type AttentionInput } from "./attention";

export function useAttentionInbox(input: AttentionInput) {
  const [observation, setObservation] = useState(emptyAttentionObservation);
  const { conversations, chats, connected, liveKnown, currentConversationId, running, activeRounds } = input;
  useEffect(() => {
    setObservation((previous) => observeAttention(previous, {
      conversations, chats, connected, liveKnown, currentConversationId,
      projects: [], running, activeRounds,
    }));
  }, [conversations, chats, connected, liveKnown, currentConversationId, running, activeRounds]);
  const entries = useMemo(() => selectAttention(input, observation.completed), [input, observation.completed]);
  function dismissCompletion(id: string) {
    setObservation((previous) => {
      if (!previous.completed.has(id)) return previous;
      const completed = new Set(previous.completed);
      completed.delete(id);
      return { ...previous, completed };
    });
  }
  return { entries, dismissCompletion };
}
