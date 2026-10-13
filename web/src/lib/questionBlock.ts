// The questions an agent asks, as the transcript draws them.
//
// A question is drawn where it was asked: at the `ask_user` call, inline, and
// not on a card above the composer. Everything that can be wrong about that
// is here, where the test runner can reach it:
//
// - WHERE a pending batch goes. The host's record carries no tool-use id, so
//   a batch finds its call by the words it asked (`placeQuestions`). One whose
//   call the page does not hold (asked before the page loaded this far back,
//   a provider with no such call) is drawn at the end of the transcript.
// - WHAT is selected when the block arrives, and what the one button would
//   send (`startPick`, `pickAnswer`). The agent's recommendation is selected;
//   only the person's press sends it.
// - WHAT the answer bubble says, and from where: the question's own record
//   while the host still lists it, the call's result once it has one, or the
//   host's turn that carried a late answer back (`answerTurn`). Never from
//   anything this page remembers, so a reload and a second tab draw the same.
import { askAnswer, readOne, type AskItem } from "./askAnswer";
import type { Message } from "./chat";
import type { Question } from "./question";
import { choicesOf, composeAnswer } from "./questionAnswer";

/* ---- Batches ------------------------------------------------------------ */

/** The questions of one `ask_user` call: one block, one button. */
export type Batch = { key: string; questions: Question[] };

/** A chat's pending questions as the calls that asked them, oldest first. A
 *  question with no `batch` was asked alone. */
export function batchesOf(questions: readonly Question[]): Batch[] {
  const out = new Map<string, Batch>();
  for (const question of questions) {
    if (!question?.id) continue;
    const key = question.batch || question.id;
    const batch = out.get(key);
    if (batch) batch.questions.push(question);
    else out.set(key, { key, questions: [question] });
  }
  return [...out.values()];
}

/** Whether a batch still asks: any of its questions has no answer yet. A
 *  status-less question comes from a host older than the durable store,
 *  which only ever lists unanswered ones. */
export function asks(batch: Batch): boolean {
  return batch.questions.some((q) => q.answer === undefined && (q.status === undefined || q.status === "pending"));
}

/* ---- Where a batch is drawn --------------------------------------------- */

/** What two lists of questions are compared by: the words, in order. */
function wordsKey(questions: readonly string[]): string {
  return questions.map((q) => q.trim()).join("\u0000");
}

type Call = { toolId: string; key: string };

/** The `ask_user` calls a pending batch can belong to, oldest first: the
 *  main agent's own, with no answer on them. A call that already carries
 *  what the person said was answered, and is nobody's to answer again. */
function openCalls(messages: readonly Message[]): Call[] {
  const calls: Call[] = [];
  for (const message of messages) {
    // A subagent's calls are drawn inside its Task card, not in this column.
    if (message.role !== "assistant" || message.parent) continue;
    for (const block of message.blocks) {
      if (block.kind !== "tool") continue;
      const read = askAnswer(block.name, block.args, block.result);
      if (!read?.length) continue;
      if (read.some((item) => item.answer || (item.unanswered && !item.later))) continue;
      calls.push({ toolId: block.id, key: wordsKey(read.map((item) => item.question)) });
    }
  }
  return calls;
}

export type Placement = {
  /** The batch drawn at each `ask_user` call, by the call's tool-use id. */
  byTool: ReadonlyMap<string, Batch>;
  /** The batches with no call in these messages, for the end of the
   *  transcript. */
  loose: Batch[];
};

const NOWHERE: Placement = { byTool: new Map(), loose: [] };

/** Put each pending batch at the call that asked it.
 *
 *  Matched by the questions' words, because that is all the two share. Asked
 *  twice in the same words, the newest batches take the newest calls: an
 *  older batch is the one whose call is more likely out of these messages. */
export function placeQuestions(messages: readonly Message[], questions: readonly Question[]): Placement {
  const batches = batchesOf(questions);
  if (!batches.length) return NOWHERE;
  const calls = new Map<string, string[]>();
  for (const call of openCalls(messages)) {
    const list = calls.get(call.key);
    if (list) list.push(call.toolId);
    else calls.set(call.key, [call.toolId]);
  }
  const byTool = new Map<string, Batch>();
  const loose: Batch[] = [];
  const asked = new Map<string, Batch[]>();
  for (const batch of batches) {
    const key = wordsKey(batch.questions.map((q) => q.question));
    const list = asked.get(key);
    if (list) list.push(batch);
    else asked.set(key, [batch]);
  }
  for (const [key, list] of asked) {
    const ids = calls.get(key) ?? [];
    const without = Math.max(0, list.length - ids.length);
    const from = Math.max(0, ids.length - list.length);
    list.forEach((batch, index) => {
      if (index < without) loose.push(batch);
      else byTool.set(ids[from + index - without], batch);
    });
  }
  // In the order they were asked, whatever the grouping above did.
  loose.sort((a, b) => batches.indexOf(a) - batches.indexOf(b));
  return { byTool, loose };
}

/* ---- A late answer, as the host's turn ----------------------------------- */

/** The id prefix of the turn the host starts when answers arrive after their
 *  call ended (`question_store::Record::turn_id`). No person's turn id
 *  starts with it. */
export const ANSWER_TURN_PREFIX = "octiq-question-";

export function isAnswerTurn(turnId?: string | null): boolean {
  return typeof turnId === "string" && turnId.startsWith(ANSWER_TURN_PREFIX);
}

/** Where the host's own closing sentence starts in that turn's text. */
const TURN_END = "\n\nContinue the original task";

/** The questions and answers a host turn carried back
 *  (`question_store::Record::continuation`), or `null` when the text is not
 *  that: the turn is then drawn as the words it holds, as before.
 *
 *  Read like the batch result in `lib/askAnswer`: an `A<n>:` answer runs to
 *  the line before `Q<n+1>:`, or to the host's closing sentence. */
export function answerTurn(text: string): AskItem[] | null {
  const end = text.lastIndexOf(TURN_END);
  const body = end < 0 ? text : text.slice(0, end);
  const items: AskItem[] = [];
  let from = 0;
  for (let n = 1; n <= 64; n += 1) {
    const q = new RegExp(`(^|\\n)Q${n}: `).exec(body.slice(from));
    if (!q) break;
    const qStart = from + q.index + q[0].length;
    const a = new RegExp(`\\nA${n}: ?`).exec(body.slice(qStart));
    if (!a) break;
    const aStart = qStart + a.index + a[0].length;
    const next = new RegExp(`\\n+Q${n + 1}: `).exec(body.slice(aStart));
    const said = (next ? body.slice(aStart, aStart + next.index) : body.slice(aStart)).trim();
    const question = body.slice(qStart, qStart + a.index).trim();
    items.push(said === "Not answered" ? { question, answer: "", unanswered: "not answered" } : readOne(question, said));
    from = next ? aStart + next.index : body.length;
  }
  return items.length ? items : null;
}

/** A message's words, as the host wrote them. */
function wordsOf(message: Message): string {
  return message.blocks.map((b) => (b.kind === "text" ? b.text : "")).join("\n\n");
}

/** The answers of a host's answer turn, or `null` for any other message. */
export function answerTurnOf(message: Pick<Message, "role" | "turnId" | "blocks">): AskItem[] | null {
  if (message.role !== "user" || !isAnswerTurn(message.turnId)) return null;
  return answerTurn(wordsOf(message as Message));
}

/** Every late answer in these messages, by the words that were asked, so a
 *  call that ended still waiting can say what was answered afterwards. */
export function lateAnswers(messages: readonly Message[]): ReadonlyMap<string, AskItem[]> {
  const out = new Map<string, AskItem[]>();
  for (const message of messages) {
    // Cheap before it is anything else: this runs on every streamed delta.
    if (message.role !== "user" || !isAnswerTurn(message.turnId)) continue;
    const items = answerTurnOf(message);
    if (items) out.set(wordsKey(items.map((item) => item.question)), items);
  }
  return out;
}

/** The late answer to one call's questions, if these messages hold it. */
export function lateAnswerTo(late: ReadonlyMap<string, AskItem[]>, asked: readonly AskItem[]): AskItem[] | null {
  if (!late.size || !asked.some((item) => item.later)) return null;
  return late.get(wordsKey(asked.map((item) => item.question))) ?? null;
}

/* ---- What is selected, and what the button would send -------------------- */

/** One question's controls. */
export type Picked = {
  /** One-of: the option selected. */
  chosen?: string;
  /** A set: the options ticked. */
  ticks: string[];
  /** Whether `Other…` is selected (one-of) or ticked (a set). */
  other: boolean;
  /** What is typed: the answer of a question with no options, else the
   *  words behind `Other…`. */
  text: string;
};

/** A question as it arrives: its recommended option selected, and nothing
 *  else. Without a recommendation nothing is selected. */
export function startPick(question: Question): Picked {
  const options = choicesOf(question.options);
  const tip = typeof question.recommended === "number" ? options[question.recommended]?.label : undefined;
  if (question.multiple && options.length > 0) return { ticks: tip ? [tip] : [], other: false, text: "" };
  return { chosen: tip, ticks: [], other: false, text: "" };
}

/** What the button would send for one question. Empty means it has no answer
 *  yet, and the button stays off: never a cheerful blank answer.
 *
 *  `Other…` selected sends what is typed and nothing else; ticked beside
 *  other ticks of a set it is sent with them, last. */
export function pickAnswer(question: Question, pick: Picked): string {
  const labels = choicesOf(question.options).map((option) => option.label);
  if (!labels.length) return pick.text.trim();
  if (question.multiple) return composeAnswer(labels, pick.ticks, pick.other ? pick.text : "");
  if (pick.other) return pick.text.trim();
  return pick.chosen && labels.includes(pick.chosen) ? pick.chosen : "";
}

/** Why the button is off, in words, or `null` when every question has an
 *  answer. */
export function submitReason(questions: readonly Question[], picks: Readonly<Record<string, Picked>>): string | null {
  const open = questions.filter((q) => !pickAnswer(q, picks[q.id] ?? startPick(q)));
  if (!open.length) return null;
  if (questions.length === 1) {
    const pick = picks[open[0].id] ?? startPick(open[0]);
    const typed = pick.other || choicesOf(open[0].options).length === 0;
    return typed ? "Type your answer to send it." : "Choose an answer to send it.";
  }
  return open.length === questions.length
    ? `Answer all ${questions.length} questions to send them.`
    : `${open.length} of ${questions.length} questions still ${open.length === 1 ? "needs" : "need"} an answer.`;
}

/* ---- What the answer bubble says ----------------------------------------- */

/** One line of the bubble. */
export type Said = { label?: string; answer: string; none?: true };

/** The bubble's lines: the bare answer for one question, the question and
 *  its answer for several. Nothing at all when nothing was said. */
export function saidLines(items: readonly Pick<AskItem, "question" | "answer" | "unanswered">[]): Said[] {
  if (!items.some((item) => item.answer)) return [];
  if (items.length === 1) return [{ answer: items[0].answer }];
  return items.map((item) => item.answer
    ? { label: item.question, answer: item.answer }
    : { label: item.question, answer: item.unanswered ?? "not answered", none: true as const });
}

/** A bubble line as text: `question: answer`, and no colon after a question
 *  that already ends in a mark of its own. */
export function saidText(line: Said): string {
  if (!line.label) return line.answer;
  const label = line.label.trim();
  return /[?？:：!！.。]$/.test(label) ? `${label} ${line.answer}` : `${label}: ${line.answer}`;
}

/* ---- Words --------------------------------------------------------------- */

/** The row above the composer, for question blocks that are out of view. */
export function waitingLabel(count: number): string {
  return count === 1 ? "1 question waiting" : `${count} questions waiting`;
}

/** What became of answers the host still lists: never "saved" for what is
 *  not on disk. `null` while the batch still asks. */
export function answeredNote(batch: Batch): { title: string; tone: "quiet" | "warn"; why?: string } | null {
  if (asks(batch)) return null;
  const failed = batch.questions.find((q) => q.error || q.status === "failed");
  if (failed) return { title: "Answers need attention", tone: "warn", why: failed.error };
  const unsaved = batch.questions.find((q) => q.status === "delivered" || q.unsaved !== undefined);
  if (unsaved) return { title: "Answers sent · not saved", tone: "warn", why: unsaved.unsaved || undefined };
  return { title: "Answers saved · waiting for the agent", tone: "quiet" };
}
