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
 *  - `src-tauri/src/question.rs` — the wait running out.
 *  - `scripts/mcp/octiq-ask.cjs` — the browser not being there to ask. */
const EXCUSES: { opens: string; means: string }[] = [
  { opens: "The user closed this question", means: "closed without answering" },
  { opens: "The user did not answer in time", means: "not answered in time" },
  { opens: "The question timed out", means: "not answered in time" },
  { opens: "OctiqFlow is not reachable", means: "could not be asked" },
  { opens: "OctiqFlow could not be reached", means: "could not be asked" },
  { opens: "OctiqFlow gave no answer", means: "could not be asked" },
];

export type AskAnswer = {
  /** What was put to the person. */
  question: string;
  /** What they said. Empty while they are still deciding, and empty when they
   *  did not answer at all — the two are told apart by `unanswered`. */
  answer: string;
  /** Why there is no answer, in words a reader can act on. Absent while the
   *  question is still open, because "still waiting" is not a failure. */
  unanswered?: string;
};

/** Read a question and its answer off a tool call, or `null` when the call is
 *  not one — which is every other card in the app, so this is the common path.
 *
 *  `null` also while the arguments are still streaming: they arrive as JSON
 *  fragments, and a card drawn from an empty bag says "asked:" and nothing
 *  after it. */
export function askAnswer(
  name: string,
  args: unknown,
  result: string | undefined,
): AskAnswer | null {
  if (name !== ASK_TOOL) return null;

  const bag = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const question = typeof bag.question === "string" ? bag.question.trim() : "";
  if (!question) return null;

  // Still open. Not an answer, and not a failure either.
  const said = (result ?? "").trim();
  if (!said) return { question, answer: "" };

  const excuse = EXCUSES.find((e) => said.startsWith(e.opens));
  if (excuse) return { question, answer: "", unanswered: excuse.means };

  return { question, answer: said };
}
