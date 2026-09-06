import { useMemo } from "react";
import { selectAttention, type AttentionInput } from "./attention";

export function useAttentionInbox(input: AttentionInput) {
  const entries = useMemo(() => selectAttention(input), [input]);
  return { entries };
}
