// One question the agent put to the person, as the host lists it
// (`question_pending`, `user-question`, `question-updated`).
import type { Choice } from "./questionAnswer";

export type Question = {
  id: string;
  chatKey?: string;
  question: string;
  /** What is on offer. Read through choicesOf, never straight: an agent sends
   *  AskUserQuestion-shaped {label, description} objects, an older server
   *  sends plain strings, and both have to draw. */
  options?: (string | Choice)[];
  /** Index into options of the one the agent would pick. It is selected when
   *  the block arrives and still sent only by the person's own press: the
   *  agent having a view does not make the decision less theirs. */
  recommended?: number;
  /** Whether several of options may be picked at once. The agent asks for it
   *  per question: it is the only one that knows whether it can act on a set. */
  multiple?: boolean;
  /** A uuid shared by every question of the same `ask_user` call, present only
   *  when that call carried more than one. It is what makes them one block,
   *  and what lets App.tsx announce the call once rather than once per
   *  question. */
  batch?: string;
  /** How many questions the call this one belongs to carried. Present only
   *  alongside `batch`. */
  batchSize?: number;
  answer?: string;
  /** `saved`: the answer is on the server's disk. `delivered`: the agent has
   *  it and the server could not write it down (`unsaved` says why). */
  status?: "pending" | "saved" | "delivered" | "failed";
  error?: string;
  retryable?: boolean;
  /** Why an answered question is not saved, in the server's words. */
  unsaved?: string;
};
