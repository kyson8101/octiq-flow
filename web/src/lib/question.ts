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

const text = (value: unknown): value is string => typeof value === "string";

/** Read that line off a chat's record, or `null` for anything that is not
 *  one whole: a line with no id, no question or an answer that is not text
 *  is not drawn in part. Strings are kept as text and nothing is repaired. */
export function readQuestionAnswered(event: unknown): QuestionAnswered | null {
  const bag = event && typeof event === "object" ? event as Record<string, unknown> : null;
  if (!bag || bag.type !== QUESTION_ANSWERED || !text(bag.id) || !bag.id) return null;
  if (!Array.isArray(bag.questions) || bag.questions.length === 0) return null;
  const questions: AnsweredQuestion[] = [];
  for (const raw of bag.questions) {
    const q = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
    if (!q || !text(q.question) || !text(q.answer)) return null;
    const options = Array.isArray(q.options)
      ? q.options.flatMap((option): Choice[] => {
          const o = option && typeof option === "object" ? option as Record<string, unknown> : null;
          if (!o || !text(o.label)) return [];
          return [text(o.description) ? { label: o.label, description: o.description } : { label: o.label }];
        })
      : [];
    questions.push({
      id: text(q.id) ? q.id : "",
      question: q.question,
      options,
      ...(typeof q.recommended === "number" ? { recommended: q.recommended } : {}),
      multiple: q.multiple === true,
      answer: q.answer,
    });
  }
  return { type: QUESTION_ANSWERED, id: bag.id, via: bag.via === "native" ? "native" : "tool", at: typeof bag.at === "number" ? bag.at : 0, questions };
}

/** The id of the transcript item a line is drawn as: one for a record,
 *  however often the line is heard. */
export const answeredMessageId = (recordId: string) => `octiq-answered-${recordId}`;
