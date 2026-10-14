// Which way this host takes the answers of a call.
//
// A host with `question_answer_batch` keeps a record of a call and lists
// every question of it until the whole call is answered. A host without it
// (older than the durable store) is answered one question at a time, keeps
// no record, and drops each question as it is answered: after that its list
// holds what is LEFT of a call, still stamped with the call's first size.
//
// The page learns which it is talking to only by sending: the batch command
// either exists or is refused as not available (`lib/submitQuestionAnswers`).
// That is remembered here, in this browser, because the moment it matters is
// a reload: a call answered in part on such a host comes back as one
// question of two, and "one of two has arrived" is then not a call still
// arriving (`questionBlock.listedQuestions`).
//
// A hint, never an authority: it only decides whether a listed part of a
// call is whole at once or after a moment. Forgotten the first time the
// batch command answers, so a host that was upgraded is not called old.
import { forget, recall, remember } from "./remember";

const KEY = "octiq.v2.questionsOneAtATime";

/** Whether this host was last seen answering one question at a time. */
export function answersOneAtATime(): boolean {
  return recall(KEY) === "1";
}

/** What a send just showed of the host: it took the answers one at a time
 *  (`true`), or its batch command answered (`false`). */
export function sawOneAtATime(yes: boolean): void {
  if (answersOneAtATime() === yes) return;
  if (yes) remember(KEY, "1");
  else forget(KEY);
}
