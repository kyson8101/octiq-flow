export type QuestionAnswer = { id: string; answer: string };
type Invoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

export function missingQuestionCommand(error: unknown, command: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(command) && message.includes("not available on this backend");
}

/** During an upgrade, retain only the questions an older server did not accept. */
export class PartialQuestionSubmission extends Error {
  constructor(message: string, readonly deliveredIds: string[]) { super(message); }
}

export async function submitLegacyQuestionAnswers(invoke: Invoke, answers: QuestionAnswer[]): Promise<void> {
  const delivered: string[] = [];
  for (const answer of answers) {
    try {
      const accepted = await invoke("question_answer", answer);
      if (accepted !== true) throw new Error("This question is no longer waiting. Your answer was not delivered; continue in the chat.");
      delivered.push(answer.id);
    } catch (error) {
      throw new PartialQuestionSubmission(error instanceof Error ? error.message : String(error), delivered);
    }
  }
}

/** What became of a submitted card.
 *
 *  - `"saved"`: the server wrote the answers down. Nothing else is called saved.
 *  - `"delivered"`: an older server took them one by one and keeps no receipt.
 *  - `{ unsaved }`: the answers reached the agent that was waiting for them and
 *    the server could NOT write them down; `unsaved` is why, in the server's
 *    words. They are not saved, and the card must not say they are. */
export type QuestionReceipt = "saved" | "delivered" | { unsaved: string };

/** The server's own "delivered, not saved" receipt, or null for anything else. */
function deliveredUnsaved(receipt: unknown): { unsaved: string } | null {
  if (!receipt || typeof receipt !== "object") return null;
  const { saved, delivered, unsaved } = receipt as Record<string, unknown>;
  if (saved !== false || delivered !== true) return null;
  return { unsaved: typeof unsaved === "string" ? unsaved : "" };
}

/** A transport response is not a receipt until the server confirms storage. */
export async function submitQuestionAnswers(
  invoke: Invoke,
  answers: QuestionAnswer[],
): Promise<QuestionReceipt> {
  let receipt: unknown;
  try {
    receipt = await invoke("question_answer_batch", { answers });
  } catch (error) {
    // A network error may follow a successful write. Never fall back or resend
    // unless the server explicitly says this command does not exist.
    if (!missingQuestionCommand(error, "question_answer_batch")) throw error;
    await submitLegacyQuestionAnswers(invoke, answers);
    return "delivered";
  }
  const unsaved = deliveredUnsaved(receipt);
  if (unsaved) return unsaved;
  if (!receipt || typeof receipt !== "object" || !("saved" in receipt) || receipt.saved !== true) {
    throw new Error("The server did not confirm your answers. They are still here; please retry.");
  }
  // One build of the server answered an unsaved answer `{ saved: true,
  // recorded: false }`, and the card said "Answers saved". Never again.
  if ("recorded" in receipt && receipt.recorded === false) return { unsaved: "" };
  return "saved";
}
