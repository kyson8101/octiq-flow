import { emptyChat, type ChatState } from "./chat";
import type { CatchUp } from "./catchUp";
import { forgetChatCheckpoint } from "./chatCache";
import type { ChatHistory } from "./chatHistory";
import type { ChatWindowCache } from "./chatWindowCache";

export type ChatRecordHead = { lastSeq: number; generation: string };

/** A record reset invalidates the entire projection, including local prompts.
 * The caller cancels its active read before handling a host reset event. */
export function invalidateChatRecord(options: {
  id: string; key: string; catchUp: CatchUp; history?: ChatHistory;
  recent?: ChatWindowCache; getState: () => ChatState; publish: (state: ChatState) => void;
}): void {
  const { id, key, catchUp, history, recent, getState, publish } = options;
  recent?.forget(id);
  catchUp.forget(key);
  history?.forget(id);
  void forgetChatCheckpoint(id);
  const { sessionId, cwd } = getState();
  publish({ ...emptyChat(), sessionId, cwd });
}
