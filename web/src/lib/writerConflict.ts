// A chat refused because an orchestration worker is writing where it would
// work (`OrchestrationStore::require_workspace_access`). Only a chat that
// could write is refused; a read-only one is not, so the way out the page
// offers is to open it read-only, to discuss.
import type { Message } from "./chat";

/** The words the host refuses with, kept in step with `workspaces.rs`. */
const WRITER_CONFLICT = "has an active writer for task";

/** Whether an error is that refusal. */
export function isWriterConflict(error: string | null | undefined): boolean {
  return !!error && error.includes(WRITER_CONFLICT);
}

/** Whether a sent message may be sent again read-only: it never reached the
 *  agent, and a writer is what stopped it. */
export function canDiscussUnsent(message: Pick<Message, "turnId" | "echo" | "takenUp" | "queueError">): boolean {
  return !!message.turnId && !message.echo && !message.takenUp && isWriterConflict(message.queueError);
}

/** The notice a chat shows once it is opened read-only this way. */
export const DISCUSS_NOTICE =
  "Opened read-only to discuss: another task is writing in this project. The agent can read the project but change nothing.";
