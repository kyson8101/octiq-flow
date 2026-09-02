// Card 79 — what an `ask_user` call actually decided.
//
// The live question card is a control, and it is right that it goes when it has
// nothing left to do. What was wrong is that the DECISION went with it: the
// call it came from is an `mcp` row labelled `ask_user`, which says neither what
// was asked nor what was said. A decision is a permanent part of the
// conversation, so it belongs where the conversation is kept.
//
// This lives apart from the card that draws it for the usual reason: it is the
// half that can be wrong. Reading one of the machine's own excuses as an answer
// would put words in the person's mouth on a permanent record, and a component
// is where the test runner cannot go.
//
// One call can now carry several questions — an agent with five things to ask
// no longer makes the person answer five cards in a row. The card still draws
// as one list either way; this file is what turns the call's arguments and its
// (possibly multi-part) result into that list.

/** The tool. Print mode is never offered `AskUserQuestion`, so questions only
 *  ever arrive through our own MCP server — one name, not a family. */
const ASK_TOOL = "mcp__octiq__ask_user";

/** The things that come back when nobody typed anything.
 *
 *  Every one of them is written by a machine, and each is quoted here by how it
 *  OPENS so that a change to the wording further along the sentence does not
 *  silently start reading as an answer. Matching anywhere in the string would be
 *  worse than useless: "the question timed out last time, so try again" is a
 *  person telling the agent something.
 *
 *  Sources, so a change to any of them is findable from here:
 *  - `UserQuestion.tsx` — closing the card without answering.
 *  - `src-tauri/src/question.rs` — the wait running out, and (both sentences
 *    open the same way) nobody being there to ask in the first place.
 *  - `scripts/mcp/octiq-ask.cjs` — the browser not being there to ask. */
const EXCUSES: { opens: string; means: string }[] = [
  { opens: "The user closed this question", means: "closed without answering" },
  { opens: "The user did not answer in time", means: "not answered in time" },
  { opens: "The question timed out", means: "not answered in time" },
  { opens: "OctiqFlow is not reachable", means: "could not be asked" },
  { opens: "OctiqFlow could not be reached", means: "could not be asked" },
  { opens: "OctiqFlow gave no answer", means: "could not be asked" },
  { opens: "Nobody is watching OctiqFlow", means: "nobody was there to ask" },
  { opens: "No question was given", means: "nothing was asked" },
];

export type AskItem = {
  /** What was put to the person. */
  question: string;
  /** What they said. Empty while they are still deciding, and empty when they
   *  did not answer at all — the two are told apart by `unanswered`. */
  answer: string;
  /** Why there is no answer, in words a reader can act on. Absent while the
   *  question is still open, because "still waiting" is not a failure. */
  unanswered?: string;
};

/** One item, read for a whole-result string that already belongs to it alone —
 *  the single-question case, whichever shape the call arrived in. */
function readOne(question: string, said: string): AskItem {
  if (!said) return { question, answer: "" };
  const excuse = EXCUSES.find((e) => said.startsWith(e.opens));
  if (excuse) return { question, answer: "", unanswered: excuse.means };
  return { question, answer: said };
}

/** Several questions, one result string shaped:
 *
 *    Q1: <question 1>
 *    A1: <answer 1 or an excuse sentence>
 *
 *    Q2: <question 2>
 *    A2: <answer 2>
 *
 *  Read defensively, because this is a machine's own formatting and not a
 *  format this file controls: an `A<n>:` answer runs from just after that
 *  prefix to the line before the next `Q<n+1>:` line, or the end of the
 *  string, whichever comes first — never by counting blank lines, which a
 *  multi-line answer could add or omit. */
function readBatch(questions: string[], said: string): AskItem[] {
  if (!said) return questions.map((question) => ({ question, answer: "" }));

  // No `A1:` at all: either the whole-result excuse (asked with nobody
  // watching, before a single question was even framed), or a shape this
  // parser was not told to expect. Either way, do not crash — hand every item
  // something rather than nothing.
  if (!/(^|\n)A1:/.test(said)) {
    const excuse = EXCUSES.find((e) => said.startsWith(e.opens));
    return excuse
      ? questions.map((question) => ({ question, answer: "", unanswered: excuse.means }))
      : questions.map((question) => ({ question, answer: said }));
  }

  return questions.map((question, index) => {
    const n = index + 1;
    const marker = new RegExp(`(^|\\n)A${n}:`).exec(said);
    if (!marker) return { question, answer: "" };

    const rest = said.slice(marker.index + marker[0].length);
    const next = new RegExp(`(^|\\n)Q${n + 1}:`).exec(rest);
    const raw = (next ? rest.slice(0, next.index) : rest).trim();

    const excuse = EXCUSES.find((e) => raw.startsWith(e.opens));
    return excuse ? { question, answer: "", unanswered: excuse.means } : { question, answer: raw };
  });
}

/** Read the questions and their answers off a tool call, or `null` when the
 *  call is not one — which is every other card in the app, so this is the
 *  common path.
 *
 *  `null` also while the arguments are still streaming and no question text
 *  has arrived yet: they arrive as JSON fragments, and a card drawn from an
 *  empty bag says "asked:" and nothing after it. */
export function askAnswer(
  name: string,
  args: unknown,
  result: string | undefined,
): AskItem[] | null {
  if (name !== ASK_TOOL) return null;

  const bag = args && typeof args === "object" ? (args as Record<string, unknown>) : {};

  // The batch shape wins when it is there at all. A legacy single call never
  // has `questions`, so this does not have to guess which shape it was sent.
  const rawQuestions = Array.isArray(bag.questions) ? bag.questions : null;
  const questions: string[] = rawQuestions
    ? rawQuestions
        .map((q) => (q && typeof q === "object" ? (q as Record<string, unknown>).question : undefined))
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim())
    : typeof bag.question === "string" && bag.question.trim()
      ? [bag.question.trim()]
      : [];

  if (questions.length === 0) return null;

  const said = (result ?? "").trim();

  // One question, either shape: today's logic, unparsed — there is no `Q1:`
  // framing to look for because the server never bothers writing it for one.
  if (questions.length === 1) return [readOne(questions[0], said)];

  return readBatch(questions, said);
}
