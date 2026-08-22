// Work the agent left running, reporting back.
//
// A `run_in_background` command, a Task subagent, a Monitor — each keeps going
// after the call that started it has already answered, and each reports its end
// by INJECTING a user turn: `<task-notification>` with the outcome inside it.
//
// That is a shape, not a speaker. Nobody typed it, and drawn as a bubble it
// reads as the reader pasting XML at their own agent mid-conversation. This
// reader is what tells the report apart from the words around it.

export type TaskNotice = {
  /** The harness's own id for the background task. Every notice carries one. */
  taskId: string;
  /** The call that STARTED the work, when the notice names one — a background
   *  command says which Bash call it came from. A subagent's does not: those
   *  are tracked on the agent rail, by task id. */
  toolUseId?: string;
  /** Where the whole output was written, for work too long to inline. */
  outputFile?: string;
  /** How it ended: `completed`, `failed`, `killed`, `stopped`. A Monitor event
   *  has none — it is news from work still running, not an ending. */
  status?: string;
  /** The one line worth reading: what ended, and how. */
  summary: string;
};

/** Only a message that OPENS with the tag counts. The same tag quoted deeper in
 *  a message is a person talking ABOUT a notification, which is their own words
 *  and stays a bubble. */
const NOTICE_HEAD = "<task-notification>";

/** Read the report a background task sent back, or null for anything else. */
export function parseTaskNotice(text: string): TaskNotice | null {
  const body = text.trim();
  if (!body.startsWith(NOTICE_HEAD) || !body.includes("</task-notification>")) return null;
  const taskId = tag(body, "task-id");
  if (!taskId) return null;
  return {
    taskId,
    toolUseId: tag(body, "tool-use-id"),
    outputFile: tag(body, "output-file"),
    status: tag(body, "status"),
    summary: tag(body, "summary") ?? "",
  };
}

/** The first `<name>…</name>` in the notice, trimmed, or undefined. Undefined
 *  rather than "" because which tags are present is the difference between the
 *  shapes: a missing `<status>` says "still running", an empty one would not. */
function tag(body: string, name: string): string | undefined {
  const found = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1]?.trim();
  return found || undefined;
}
