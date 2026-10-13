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

/** The `type` of the line the host writes into a chat's record when a
 *  question's answer is handed to the agent while its call waits
 *  (`question_store::ANSWERED`). */
export const QUESTION_ANSWERED = "octiq_question_answered";

/** One question of that line: as it was asked, and what was answered. */
export type AnsweredQuestion = {
  /** The id the question had while it was listed (`Question.id`). */
  id: string;
  question: string;
  /** Always labelled objects here, and `[]` for a free-text question. */
  options: Choice[];
  /** Index into `options`. Absent when the agent recommended none. */
  recommended?: number;
  multiple: boolean;
  answer: string;
};

/** A delivered question as the chat's record keeps it: one host event for
 *  one call's questions, read from `chat_since` / `chat_page` and heard as a
 *  `chat-event` (docs/question-delivery.md, The answered line).
 *
 *  `id` is the question record's and there is one line a record: the same
 *  event can be heard more than once (a write that failed is tried again),
 *  and a page draws one for an id. It is the host's turn id too, without
 *  its prefix (`octiq-question-<id>`), for the rare record that has both. */
export type QuestionAnswered = {
  type: typeof QUESTION_ANSWERED;
  id: string;
  /** `native`: the provider asked by itself (Codex), so no tool call of the
   *  transcript is this question's. `tool`: an `ask_user` call, whose own
   *  result carries the same answers when the page holds that call. */
  via: "native" | "tool";
  /** When the answer was handed over, on the host's clock (ms). */
  at: number;
  questions: AnsweredQuestion[];
};
