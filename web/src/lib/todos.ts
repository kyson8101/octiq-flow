// The plan, pinned on screen.
//
// An agent that takes a request and goes quiet for four minutes gives the
// person waiting nothing to hold on to: they cannot tell being understood from
// being ignored. So the agent writes down what it is about to do, and keeps it
// up to date as it goes.
//
// There is nothing to fetch. The agent calls `todo_write` (scripts/mcp), and
// that call travels down the chat stream like any other tool call — arguments
// and all. So the list on screen is simply the newest one of those, read back
// out of the transcript. It survives a reload for free, because the transcript
// does.
import type { Message } from "./chat";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type Todo = {
  /** The task, as an imperative: "Fix the mobile top bar". */
  content: string;
  status: TodoStatus;
  /** The same task as what is happening right now: "Fixing the mobile top bar".
   *  Shown in place of `content` while the item is the one in progress. */
  activeForm?: string;
};

/** Both spellings of the same tool: ours, and the one Claude has built in when
 *  it is running somewhere that offers it. */
const TODO_TOOLS = new Set(["mcp__octiq__todo_write", "todo_write", "todowrite"]);

const STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed"]);

/**
 * The newest TODO list in a conversation, or [] when there is none.
 *
 * Read backwards, and only from the MAIN agent's own turns: a subagent keeps
 * its own list of its own job, and letting that overwrite the plan on screen
 * would replace the work with one step of it.
 */
export function latestTodos(messages: Message[]): Todo[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.parent) continue;
    for (let j = message.blocks.length - 1; j >= 0; j -= 1) {
      const block = message.blocks[j];
      if (block.kind !== "tool") continue;
      if (!TODO_TOOLS.has(block.name.toLowerCase())) continue;
      // A call still being written has no arguments yet. Keep looking back: the
      // list already on screen stays up rather than blinking out and in again
      // while the new one arrives. An EMPTY list is a real answer, though —
      // `readTodos` gives [] for that and null only for "nothing to read yet".
      const todos = readTodos(block.args);
      if (todos) return todos;
    }
  }
  return [];
}

function readTodos(args: unknown): Todo[] | null {
  if (!args || typeof args !== "object") return null;
  const raw = (args as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) return null;
  const out: Todo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { content?: unknown; status?: unknown; activeForm?: unknown };
    const content = typeof row.content === "string" ? row.content.trim() : "";
    if (!content) continue;
    const status =
      typeof row.status === "string" && STATUSES.has(row.status)
        ? (row.status as TodoStatus)
        : "pending";
    const activeForm = typeof row.activeForm === "string" ? row.activeForm.trim() : "";
    out.push(activeForm ? { content, status, activeForm } : { content, status });
  }
  return out;
}

/** What the closed strip says: how far through, and what is happening now. */
export type TodoLook = { done: number; total: number; current: string; finished: boolean };

export function todoLook(todos: Todo[]): TodoLook {
  const done = todos.filter((t) => t.status === "completed").length;
  const running = todos.find((t) => t.status === "in_progress");
  // Nothing marked in progress falls back to the next thing not yet done — a
  // list between items still has a next step, and saying nothing there reads
  // as a list that has stalled.
  const next = running ?? todos.find((t) => t.status !== "completed");
  return {
    done,
    total: todos.length,
    current: running ? running.activeForm || running.content : (next?.content ?? ""),
    finished: todos.length > 0 && done === todos.length,
  };
}
