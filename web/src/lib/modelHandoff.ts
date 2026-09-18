import type { Message } from "./chat";

/** Keep a provider switch comfortably below every supported model's context
 * window while favouring the turns nearest the switch. The transcript remains
 * complete in OctiqFlow; this is only the context handed to the fresh provider
 * process. */
const MAX_HANDOFF_CHARS = 160_000;

export type ModelHandoffTurn = {
  role: "user" | "assistant";
  name?: string;
  text: string;
  attachments?: string[];
};

function handoffTurn(message: Message): ModelHandoffTurn | undefined {
  // A Task subagent's stream is evidence inside its tool card, not another
  // participant in the top-level conversation.
  if (message.parent) return undefined;
  const text = message.blocks
    .flatMap((block) => block.kind === "text" || block.kind === "compacted" ? [block.text] : [])
    .join("\n")
    .trim();
  const attachments = message.attachments?.map((attachment) => attachment.name || attachment.path);
  if (!text && !attachments?.length) return undefined;
  return {
    role: message.role,
    ...(message.speaker?.name ? { name: message.speaker.name } : {}),
    text,
    ...(attachments?.length ? { attachments } : {}),
  };
}

/** Provider-neutral history for the first request after a model switch.
 * JSON keeps role and message boundaries exact and prevents conversation text
 * from being mistaken for the wrapper that explains the handoff. */
export function modelHandoff(messages: readonly Message[]): string | undefined {
  const turns = messages.flatMap((message) => {
    const turn = handoffTurn(message);
    return turn ? [turn] : [];
  });
  if (!turns.length) return undefined;

  const kept: ModelHandoffTurn[] = [];
  let chars = 2;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const size = JSON.stringify(turns[index]).length + 1;
    if (kept.length && chars + size > MAX_HANDOFF_CHARS) break;
    kept.unshift(turns[index]);
    chars += size;
  }
  if (kept.length < turns.length) {
    kept.unshift({
      role: "assistant",
      name: "OctiqFlow",
      text: `${turns.length - kept.length} earlier turn(s) were omitted to fit the new model's context.`,
    });
  }
  return JSON.stringify(kept);
}
