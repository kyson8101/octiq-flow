// What an agent's memory write came to, as the HOST reports it.
//
// The backend (`memory_activity.rs`) writes an `octiq_memory_activity` event
// into the chat once the vault has answered: `saved` only on a saved receipt,
// `failed` when nothing was written, `uncertain` when the receipt needs review.
// Nothing here reads tool names or what the agent said about its memory — an
// agent announcing "noted" draws no line, and a read of its memory never looks
// like a write.
//
// A line is one operation, keyed by its id. The same id arriving again (a
// replayed transcript, a reconnect, a retried call) updates that line in place;
// only the receipt's own evidence moves it, from uncertain to saved.

export type MemoryStatus = "saved" | "failed" | "uncertain";

export type MemoryActivity = {
  id: string;
  status: MemoryStatus;
  /** Absent when the chat is no registered agent's — never guessed. */
  agent?: { id: string; name: string };
  /** Unix milliseconds. */
  at: number;
  requestId?: string;
  /** The note, relative to the vault. */
  note?: string;
  date?: string;
  /** Exactly what this write appended — never the rest of the note. */
  text?: string;
  receipt?: { id: string; status?: string };
  error?: string;
  /** Set on the copy a worker's coordinator is shown: where the write
   *  happened. That copy carries no text; the worker chat has it. */
  source?: { chatKey: string; taskId?: string; taskTitle?: string; runId?: string };
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const opt = (v: unknown) => str(v) || undefined;

export function readMemoryActivity(e: Record<string, unknown>): MemoryActivity | null {
  const id = str(e.id);
  const status = str(e.status);
  if (!id || !["saved", "failed", "uncertain"].includes(status)) return null;
  const agent = obj(e.agent);
  const receipt = obj(e.receipt);
  const source = obj(e.source);
  return {
    id,
    status: status as MemoryStatus,
    agent: str(agent.name) ? { id: str(agent.id), name: str(agent.name) } : undefined,
    at: typeof e.at === "number" ? e.at : 0,
    requestId: opt(e.requestId),
    note: opt(e.note),
    date: opt(e.date),
    text: opt(e.text),
    receipt: str(receipt.id) ? { id: str(receipt.id), status: opt(receipt.status) } : undefined,
    error: opt(e.error),
    source: str(source.chatKey)
      ? {
          chatKey: str(source.chatKey),
          taskId: opt(source.taskId),
          taskTitle: opt(source.taskTitle),
          runId: opt(source.runId),
        }
      : undefined,
  };
}

/** What a line becomes when its id arrives again. The host already refuses to
 *  move a line backwards; this refuses too, so an out-of-order replay cannot
 *  either. The first report's snapshot (who, what, where) is kept. */
export function mergeMemoryActivity(old: MemoryActivity, next: MemoryActivity): MemoryActivity {
  if (old.status === "uncertain" && next.status === "saved" && old.receipt?.id === next.receipt?.id)
    return { ...old, status: "saved", at: next.at || old.at, receipt: next.receipt, error: undefined };
  return old;
}

/** The line's headline: who, and what became of it. */
export function memoryHeadline(a: MemoryActivity): string {
  const who = a.agent?.name;
  if (a.status === "saved") return `${who ?? "An agent"} updated memory`;
  if (a.status === "uncertain") return who ? `${who}'s memory update is unconfirmed` : "Memory update is unconfirmed";
  return who ? `${who}'s memory was not updated` : "Memory was not updated";
}

/** The chat id in a host chat key (`chat:<id>`). */
export function chatIdOf(key: string): string {
  return key.startsWith("chat:") ? key.slice(5) : key;
}
