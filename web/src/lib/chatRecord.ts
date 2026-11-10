import { emptyChat, type ChatState } from "./chat";
import type { CatchUp } from "./catchUp";
import { forgetChatCheckpoint } from "./chatCache";
import type { ChatHistory } from "./chatHistory";
import type { ChatWindowCache } from "./chatWindowCache";
import { once, IN_FLIGHT } from "./inFlight";

export type ChatRecordHead = { lastSeq: number; generation: string };

/** A tab receives both its forget reply and the host's broadcast, in either
 * order. Defer its own broadcast until the save answers, then reset once.
 * Re-read after committing (or a late broadcast) to recover new record events
 * that may have raced the reply while the old sequence mark was still held. */
export class ChatRecordClears {
  private acknowledgements = new Map<string, { notified: boolean; committed: boolean; refresh: () => void }>();

  forgotten(key: string): boolean {
    const own = this.acknowledgements.get(key);
    if (!own) return false;
    own.notified = true;
    if (own.committed) {
      this.acknowledgements.delete(key);
      own.refresh();
    }
    return true;
  }

  /** Old hosts send no broadcast. Bound their receipts, and never carry one
   * across a disconnect into a different host's record reset. */
  disconnected(): void { this.acknowledgements.clear(); }

  async clear(options: {
    key: string; forget: () => Promise<unknown>; clearAgent: () => void;
    reset: () => void; refresh: () => void;
  }): Promise<boolean> {
    const result = await once(`chat-clear:${options.key}`, async () => {
      const own = { notified: false, committed: false, refresh: options.refresh };
      this.acknowledgements.set(options.key, own);
      try {
        await options.forget();
      } catch (error) {
        if (this.acknowledgements.get(options.key) === own) this.acknowledgements.delete(options.key);
        throw error;
      }
      options.clearAgent();
      options.reset();
      own.committed = true;
      if (own.notified) this.acknowledgements.delete(options.key);
      while (this.acknowledgements.size > 64) {
        this.acknowledgements.delete(this.acknowledgements.keys().next().value!);
      }
      options.refresh();
      return true;
    });
    return result !== IN_FLIGHT;
  }
}

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
