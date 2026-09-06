import { reduceChat, type ChatState } from "./chat";
import type { Frame } from "./catchUp";

/** Yield between short batches so a cold, large replay leaves the page usable.
 * The caller keeps live events buffered until the whole replay commits. */
export async function replayChat(
  state: ChatState,
  frames: Frame[],
  after: number,
  cancelled: () => boolean,
): Promise<ChatState> {
  let deadline = performance.now() + 8;
  for (const frame of frames) {
    if (cancelled()) throw new Error("Chat read cancelled");
    if (frame.seq <= after) continue;
    state = reduceChat(state, frame.event);
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      deadline = performance.now() + 8;
    }
  }
  return state;
}
