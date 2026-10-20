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
import type { Question, QuestionAnswered } from "./question";
import { choicesOf, composeAnswer } from "./questionAnswer";
import { shownMedia, type Shown } from "./questionMedia";

/* ---- Batches ------------------------------------------------------------ */

/** The questions of one `ask_user` call: one block, one button. */
export type Batch = {
  key: string;
  questions: Question[];
  /** How many questions of the call can still arrive on this page. The
   *  host says how many a call carried (`batchSize`) and sends them one
   *  event each, so a block can be on screen before its last question is.
   *  It is not whole, and not to be sent, until this is zero
   *  (`stillMissing`, which also reads `until`). */
  missing: number;
  /** When the wait for the missing ones is over whatever arrives, on the
   *  page's clock: `batchSize` may delay a send, and never forbids one.
   *  Set for a call the host's own list has named (`listedQuestions`);
   *  absent for one whose questions are coming by event. */
  until?: number;
};

/** How long a part of a call that the host's LIST named is held for the
 *  rest. A host that keeps a call's record lists every question of it, so
 *  a part in its list is a call caught as it was being asked, and the rest
 *  follows in the same breath. Long past that, nothing more is coming. */
export const LISTED_GRACE_MS = 10_000;

/** What this page knows of one call's questions. */
type Known = {
  /** The questions of the call this page has ever been told of. A question
   *  the page dropped itself (an older host keeps no record of an answer,
   *  so the page takes it off its own list) has still arrived: what is left
   *  of its call is whole, and must stay answerable. */
  ids: Set<string>;
  /** When a read of the host's list of what is pending named this call
   *  (`listedQuestions`), on the page's clock. */
  listedAt: number | null;
  /** That list came from a host that drops each question as it is
   *  answered: what it named IS what remains of the call. */
  whole: boolean;
};

/** By the call. In memory: a reload starts from what the host lists. It
 *  forgets a call when no question of it is left on the page
 *  (`keepBatches`). */
const known = new Map<string, Known>();

const batchKey = (question: Question) => question.batch || question.id;

function knownOf(key: string): Known {
  let entry = known.get(key);
  if (!entry) known.set(key, entry = { ids: new Set(), listedAt: null, whole: false });
  return entry;
}

/** The host's list of what is pending (`question_pending`), as one read of
 *  it answered at `now`. `oneAtATime` is whether this host was last seen
 *  taking answers one question at a time (`lib/questionHost`).
 *
 *  Such a host keeps no record of an answer and drops each question as it
 *  is answered. So after a reload it lists what is left of a call, still
 *  with the call's first `batchSize`: one of two. Counted against what this
 *  page had seen arrive (nothing, after a reload), that block said `Still
 *  reading the questions: 1 of 2 has arrived` for good and could not be
 *  sent (review 3b). "Still reading" is for questions that can still
 *  arrive. On that host none can: what the list named is what remains.
 *
 *  On any other host a part of a call in the list is a call caught while
 *  it is being asked, and is held for the rest as an event's would be, but
 *  only for `LISTED_GRACE_MS`: a list the host has answered is not still
 *  being read for good. */
export function listedQuestions(list: readonly Question[], now: number, oneAtATime = false): void {
  for (const question of list) {
    if (!question?.id) continue;
    const entry = knownOf(batchKey(question));
    entry.listedAt ??= now;
    if (oneAtATime) entry.whole = true;
  }
}

/** Forget every call that none of these questions belongs to: its record is
 *  complete, was cancelled, or went with its chat's history. `questions`
 *  are all the page holds, for every chat. */
export function keepBatches(questions: Iterable<Question>): void {
  if (!known.size) return;
  const held = new Set<string>();
  for (const question of questions) if (question?.id) held.add(batchKey(question));
  for (const key of [...known.keys()]) if (!held.has(key)) known.delete(key);
}

/** How many calls this page is keeping count of. For a test. */
export const knownBatches = () => known.size;

/** A chat's pending questions as the calls that asked them, oldest first. A
 *  question with no `batch` was asked alone. */
export function batchesOf(questions: readonly Question[]): Batch[] {
  const out = new Map<string, Batch & { size: number }>();
  for (const question of questions) {
    if (!question?.id) continue;
    const key = batchKey(question);
    const size = question.batch && typeof question.batchSize === "number" ? question.batchSize : 1;
    knownOf(key).ids.add(question.id);
    const batch = out.get(key);
    if (batch) {
      batch.questions.push(question);
      batch.size = Math.max(batch.size, size);
    } else out.set(key, { key, questions: [question], missing: 0, size });
  }
  return [...out.values()].map(({ size, ...batch }) => {
    const entry = known.get(batch.key);
    const missing = entry?.whole ? 0 : Math.max(0, size - (entry?.ids.size ?? 0));
    if (!missing || entry?.listedAt == null) return { ...batch, missing };
    return { ...batch, missing, until: entry.listedAt + LISTED_GRACE_MS };
  });
}

/** How many questions of a call are still waited for at `now`: none once
 *  the wait a list started is over. */
export function stillMissing(batch: Pick<Batch, "missing" | "until">, now: number): number {
  return batch.until !== undefined && now >= batch.until ? 0 : batch.missing;
}

/** Whether one question still has no answer. A status-less question comes
 *  from a host older than the durable store, which only ever lists
 *  unanswered ones. */
export function unanswered(question: Question): boolean {
  return question.answer === undefined && (question.status === undefined || question.status === "pending");
}

/** Whether a batch still asks: any of its questions has no answer yet. */
export function asks(batch: Batch): boolean {
  return batch.questions.some(unanswered);
}

/** A batch as its block draws it, part by part. The host takes the answers
 *  of a call one question at a time and wakes the agent only when every one
 *  is in, so a call can be half answered: by another tab, by a page that
 *  sent before the last question arrived, by a record read back after a
 *  reload. Whatever was answered is said, and whatever was not is asked:
 *  nothing this page sent earlier stands in for a question with no answer.
 *
 *  - `said`: the questions that have an answer, the host's or the one this
 *    page just sent (`sentIds`) and has not heard back about.
 *  - `open`: the questions still to answer here. */
export function batchParts(batch: Batch, sentIds: readonly string[] = []): { said: Question[]; open: Question[] } {
  const said: Question[] = [];
  const open: Question[] = [];
  for (const question of batch.questions) (unanswered(question) && !sentIds.includes(question.id) ? open : said).push(question);
  return { said, open };
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
export function submitReason(questions: readonly Question[], picks: Readonly<Record<string, Picked>>, missing = 0): string | null {
  // Before anything about the answers: a call whose questions have not all
  // arrived is not to be sent, whatever is already selected.
  if (missing > 0) return readingReason(questions.length, questions.length + missing);
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

/** Why a block whose call has not wholly arrived cannot be sent. */
export function readingReason(here: number, of: number): string {
  return `Still reading the questions: ${here} of ${of} ${here === 1 ? "has" : "have"} arrived.`;
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
export function answeredNote(batch: Pick<Batch, "questions">): { title: string; tone: "quiet" | "warn"; why?: string } | null {
  if (batch.questions.some(unanswered)) return null;
  const failed = batch.questions.find((q) => q.error || q.status === "failed");
  if (failed) return { title: "Answers need attention", tone: "warn", why: failed.error };
  const unsaved = batch.questions.find((q) => q.status === "delivered" || q.unsaved !== undefined);
  if (unsaved) return { title: "Answers sent · not saved", tone: "warn", why: unsaved.unsaved || undefined };
  return { title: "Answers saved · waiting for the agent", tone: "quiet" };
}

/** What is said of the answered part of a call that still asks: the agent
 *  has nothing yet, because the host hands a call's answers over together.
 *  Never "saved": the host calls a record saved only when it is whole. */
export function partNote(said: number, open: number): { title: string; tone: "quiet" } {
  const rest = open === 1 ? "1 more question" : `${open} more questions`;
  return { title: `${said === 1 ? "Answered" : `${said} answered`} · the agent waits for ${rest}`, tone: "quiet" };
}

/* ---- A delivered question, from the chat's record ------------------------ */

/** Where each delivered question of these messages is drawn.
 *
 *  When an answer is handed to the agent while its call waits, the host
 *  writes one `octiq_question_answered` line into the chat's record
 *  (docs/question-delivery.md, The answered line), and `question-expired`
 *  then takes the question off every page. That line is what the page draws
 *  the answered question and the person's bubble from, so they are the same
 *  after delivery, after a reload and in a second tab.
 *
 *  A line is attached by what it IS, never by its words alone. The words
 *  say only which calls could be its own; the same words are asked twice.
 *
 *  - `via: "native"`: the provider asked by itself, so no tool call of the
 *    transcript is this question's. Never attached to one: drawn where the
 *    line stands.
 *  - `via: "tool"`: attached to the `ask_user` call it was written for, and
 *    then the call draws the answer and the line draws nothing, so a
 *    question answered through the tool is drawn once. Its call is the
 *    newest one before the line that asked these words and has no line yet,
 *    and only while that call has no answer of its own, or says the very
 *    answers the line does (its result has arrived). A call that carries
 *    another answer was answered in its own right and is never given a
 *    second; a call that ended without one has no line. The line is then
 *    drawn where it stands.
 *
 *  The host's turn for the same record (`octiq-question-<id>`, the rare
 *  record that has both) wins over either.
 *
 *  Words alone were the hole: an old call answered `Merge` (a record from
 *  before the host wrote lines), then the same words asked natively and
 *  answered `Rebase`. The native line was bound to the old call, the call
 *  drew its own result, and the page showed `Merge` and no `Rebase`. */
export type AnsweredPlacement = {
  /** The answers of the line attached to each call, by the call's id. */
  byTool: ReadonlyMap<string, AskItem[]>;
  /** The lines drawn where they stand, by the record's id. */
  atLine: ReadonlySet<string>;
  /** Every listed question these lines answer (`Question.id`): the record
   *  is the line now, and a pending copy of it is not drawn beside it. */
  ids: ReadonlySet<string>;
};

/** A line's questions as the bubble reads them, with what each showed. */
export function answeredItems(line: QuestionAnswered): AskItem[] {
  return line.questions.map((q) => withShown({ question: q.question, answer: q.answer }, shownMedia(q, q.answer)));
}

/** Listed questions as the answered line reads them: what each asked, the
 *  answer the host holds (or `answers`, by index, when it holds none yet)
 *  and what each showed. */
export function recordItems(questions: readonly Question[], answers: readonly string[] = []): AskItem[] {
  return questions.map((q, index) => {
    const answer = q.answer ?? answers[index] ?? "";
    return withShown({ question: q.question, answer }, shownMedia({ ...q, options: choicesOf(q.options) }, answer));
  });
}

/** A call's items with the media the host's record of the same questions
 *  showed: by place, and only where the words asked are the same. The
 *  call's own result says what was answered; the record says what was
 *  shown. */
export function withMediaOf(items: AskItem[], record: readonly AskItem[] | null | undefined): AskItem[] {
  if (!record?.some((item) => item.media?.length)) return items;
  return items.map((item, index) => {
    const from = record[index];
    return from?.media?.length && from.question === item.question ? { ...item, media: from.media } : item;
  });
}

const withShown = (item: AskItem, media: Shown[]): AskItem => (media.length ? { ...item, media } : item);

/** An `ask_user` call a `via: "tool"` line can be attached to, with what
 *  the call itself says was answered: nothing yet, or its own answers. */
type AskedCall = { toolId: string; own: string[] | null };

/** Whether a call can be the one a line was written for: it carries no
 *  answer of its own, or the very answers the line carries. */
function takesLine(call: AskedCall, line: QuestionAnswered): boolean {
  if (!call.own) return true;
  return call.own.length === line.questions.length && call.own.every((answer, i) => answer.trim() === line.questions[i].answer.trim());
}

export function placeAnswered(messages: readonly Message[]): AnsweredPlacement {
  const byTool = new Map<string, AskItem[]>();
  const atLine = new Set<string>();
  const ids = new Set<string>();
  let turns: Set<string> | null = null;
  /** The main agent's `ask_user` calls so far that could still be given a
   *  line, by the words they asked. */
  const calls = new Map<string, AskedCall[]>();
  for (const message of messages) {
    if (message.role !== "assistant" || message.parent) continue;
    for (const block of message.blocks) {
      if (block.kind === "tool") {
        if (block.state === "error") continue;
        const read = askAnswer(block.name, block.args, block.result);
        if (!read?.length) continue;
        // A call that ended with nothing said (closed, timed out, saved for
        // later) was handed no answer while it waited: no line is its own.
        if (read.some((item) => item.unanswered)) continue;
        const own = read.some((item) => item.answer) ? read.map((item) => item.answer) : null;
        const key = wordsKey(read.map((item) => item.question));
        const list = calls.get(key);
        if (list) list.push({ toolId: block.id, own });
        else calls.set(key, [{ toolId: block.id, own }]);
        continue;
      }
      if (block.kind !== "answered") continue;
      const line = block.answered;
      for (const question of line.questions) ids.add(question.id);
      // The same record's late answer, as the host's turn, is the bubble.
      turns ??= new Set(messages.flatMap((m) => (m.role === "user" && isAnswerTurn(m.turnId) ? [m.turnId!] : [])));
      if (turns.has(`${ANSWER_TURN_PREFIX}${line.id}`)) continue;
      // The provider's own question has no call here, whatever the words.
      if (line.via !== "tool") { atLine.add(line.id); continue; }
      // The newest call before the line that asked these words and has no
      // line yet (the line is written between a call and its result), when
      // it can be this line's. One that cannot keeps its place: it is not
      // used up by a line that was never its own.
      const open = calls.get(wordsKey(line.questions.map((q) => q.question)));
      const call = open?.at(-1);
      if (call && takesLine(call, line)) {
        open!.pop();
        byTool.set(call.toolId, answeredItems(line));
      } else atLine.add(line.id);
    }
  }
  return { byTool, atLine, ids };
}
