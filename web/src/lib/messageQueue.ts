import type { ChatState, Message } from "./chat";
import { reconcileUnsentMessages, type ChatQueueState } from "./recovery";

export type QueueAction = "start" | "cancel";

/** One in-flight mutation per message, shared by every control in this client.
 * An RPC response is not a provider acknowledgement. Refresh on a stale click
 * instead of leaving the same impossible action on screen. */
export class MessageQueueActions {
  private pending = new Set<string>();

  isPending(chatId: string, turnId: string): boolean {
    return this.pending.has(`${chatId}/${turnId}`);
  }

  async run(options: {
    chatId: string;
    turnId: string;
    action: QueueAction;
    read: () => ChatState;
    patch: (update: (state: ChatState) => ChatState) => void;
    invoke: (command: string) => Promise<unknown>;
    refresh: () => Promise<void>;
    reclaim: (message: Message) => void;
  }): Promise<void> {
    const { chatId, turnId, action, read, patch, invoke, refresh, reclaim } = options;
    const key = `${chatId}/${turnId}`;
    const message = read().messages.find((m) => m.turnId === turnId);
    if (this.pending.has(key) || !message || message.delivery !== "queued"
      || message.echo || message.takenUp || message.queueLost || message.queueAction) return;
    this.pending.add(key);
    const update = (change: Partial<Message>) => patch((state) => ({
      ...state, messages: state.messages.map((m) => m.turnId === turnId ? { ...m, ...change } : m),
    }));
    update({ queueAction: action, queueError: undefined });
    try {
      const applied = await invoke(action === "start" ? "chat_start_queued" : "chat_cancel_queued");
      if (applied === true && action === "cancel") {
        // Read the original snapshot even if the broadcast removed it first.
        reclaim(message);
        patch((state) => ({ ...state, messages: state.messages.filter((m) => m.turnId !== turnId) }));
      } else {
        await refresh();
      }
    } catch (error) {
      // The connection can fail after the command ran. Reconcile before
      // exposing retry; never submit a second send on an ambiguous outcome.
      await refresh().catch(() => {
        const current = read().messages.find((m) => m.turnId === turnId);
        if (current?.delivery === "queued") update({ delivery: "unknown" });
      });
      update({ queueError: String((error as Error).message ?? error) });
    } finally {
      update({ queueAction: undefined });
      this.pending.delete(key);
    }
  }
}

/** Streaming another answer doesn't invalidate a queue read. Only changes to
 * the particular prompt since this request began make its snapshot stale. */
export function reconcileQueueSnapshot(
  current: ChatState,
  before: ChatState,
  queue: ChatQueueState,
  isPending: (message: Message) => boolean = () => false,
): ChatState {
  const reconciled = reconcileUnsentMessages(before, queue);
  const updates = new Map(before.messages.map((m, i) => [m, reconciled.messages[i]]));
  let changed = false;
  const messages = current.messages.map((message) => {
    let next = updates.get(message) ?? message;
    // Checkpoints can contain a local pending indicator from a closed tab.
    if (next.queueAction && !isPending(next)) next = { ...next, queueAction: undefined };
    changed ||= next !== message;
    return next;
  });
  return changed ? { ...current, messages } : current;
}

/** Restore content without duplicating the app-generated file list. */
export function reclaimedMessage(message: Message) {
  let text = message.blocks.flatMap((b) => b.kind === "text" ? [b.text] : []).join("\n").trim();
  const files = (message.attachments ?? []).filter((a) => !a.isImage);
  const suffix = `Files to look at:\n${files.map((a) => `- ${a.path}`).join("\n")}`;
  if (files.length && text.endsWith(suffix)) text = text.slice(0, -suffix.length).trimEnd();
  return {
    text: message.to ? `@${message.to.name} ${text}` : text,
    attachments: (message.attachments ?? []).map((a) => ({ ...a, isImage: !!a.isImage })),
  };
}
