// The board: which of your chats wants something from you, and which do not.
//
// A profile runs many chats at once — the idle reaper in `agent_chat.rs` exists
// because nine left open overnight held 4.3 GB — and the only view of them is a
// sidebar list carrying two dots. Those answer "is it alive". They do not answer
// "which of these is waiting on ME", which is the only question worth asking of
// nine chats at once.
//
// Everything here is DERIVED. There is no store behind this file and nothing to
// keep up to date: each column is a reading of state the client already holds
// for its own reasons, so the board cannot drift from the truth the way a board
// you type into does. That is the whole design, and it is why the columns are
// what they are — these four are exactly the states the client can already tell
// apart without asking anyone.
//
// The signals, and where they come from:
//
//   Needs you  a pending permission card or `ask_user` question. Refilled from
//              `permission_pending` / `question_pending` on every connect, so
//              this survives a reload — which matters, because the server goes
//              on holding the agent's turn open for an answer either way.
//   Working    the `busy` set: a turn in flight.
//   Idle       the `running` set without `busy`: a live process between turns.
//   Quiet      neither: reaped by the sweeper, or never started this session.
import type { Message } from "./chat";
import { latestTodos, todoLook, type TodoLook } from "./todos";

export type BoardColumn = "needs-you" | "working" | "idle" | "quiet";

/** How many Quiet cards are worth drawing.
 *
 *  Quiet is every chat that ever was, so uncapped it stops being a board and
 *  becomes a second sidebar — and it is the column with the least to say. What
 *  is dropped is COUNTED rather than silently cut: a column that shows twelve
 *  of forty-nine and says so is honest, one that just shows twelve is not. */
export const QUIET_MAX = 12;

/** Why a chat is in the Needs you column. */
export type Waiting = {
  kind: "permission" | "question";
  /** One line for the card face: the tool being asked about, or the question. */
  summary: string;
};

export type BoardCard = {
  id: string;
  projectId: string;
  title: string;
  column: BoardColumn;
  /** Set on Needs you cards, and only those. */
  waiting?: Waiting;
  /** How far through its plan, when the transcript is in memory to read it
   *  from. Absent for a chat that is running but was never opened this
   *  session — its column is still right, and the title is the face. */
  plan?: TodoLook;
  /** Idle with items left undone: it stopped part-way.
   *
   *  This is the one thing Idle cannot say on its own. Idle mixes three
   *  different situations — finished, stopped and waiting on you, blocked on
   *  something outside — and only the agent really knows which. So the plan is
   *  read as the nearest available evidence, and the answer is MARKED rather
   *  than promoted into Needs you: an agent may well have finished without
   *  tidying its list, and a guess in the one column that must not cry wolf
   *  would cost that column its meaning. */
  stalled?: boolean;
  updatedAt: number;
};

export type BoardColumnView = {
  column: BoardColumn;
  cards: BoardCard[];
  /** Cards left out by the cap. 0 everywhere but Quiet. */
  hidden: number;
};

export type Board = {
  columns: BoardColumnView[];
  /** How many chats are waiting on an answer, for a badge somewhere small. */
  needsYou: number;
};

/** A conversation, as the sidebar's store holds one — narrowed to what the
 *  board reads, so `lib/store`'s full shape is not a dependency here. */
type BoardChat = {
  id: string;
  projectId: string;
  title: string;
  updatedAt: number;
};

/** A pending permission card. Structurally what `PermissionAsk`'s `Ask` is;
 *  restated so this file does not import from a component. */
type PendingAsk = { id: string; toolName?: string };

/** A pending `ask_user` question, same reasoning. */
type PendingQuestion = { id: string; question?: string };

export type BoardInput = {
  conversations: BoardChat[];
  /** Conversations with a live agent process behind them. */
  running: Set<string>;
  /** Of those, the ones mid-turn. */
  busy: Set<string>;
  /** Pending permission cards, by conversation id. */
  asks: Record<string, PendingAsk[]>;
  /** Pending `ask_user` questions, by conversation id. */
  questions: Record<string, PendingQuestion[]>;
  /** The chats whose transcripts are in memory. Only these have a plan. */
  chats: Record<string, { messages: Message[] } | undefined>;
};

const ORDER: BoardColumn[] = ["needs-you", "working", "idle", "quiet"];

export function buildBoard(input: BoardInput): Board {
  const cards: BoardCard[] = input.conversations.map((c) => card(c, input));

  const columns = ORDER.map((column) => {
    // Newest first. A column ordered any other way buries the thing that just
    // happened under the thing that happened this morning.
    const all = cards
      .filter((c) => c.column === column)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const cap = column === "quiet" ? QUIET_MAX : all.length;
    return { column, cards: all.slice(0, cap), hidden: Math.max(0, all.length - cap) };
  });

  return { columns, needsYou: cards.filter((c) => c.column === "needs-you").length };
}

function card(chat: BoardChat, input: BoardInput): BoardCard {
  const waiting = waitingOn(chat.id, input);
  const busy = input.busy.has(chat.id);
  const live = input.running.has(chat.id);

  // Read `waiting` BEFORE `busy`. A chat holding a permission card is normally
  // busy too — the turn is open, which is exactly why the agent cannot move —
  // so checking busy first would file the one chat that is stuck under the
  // column for the ones that are not.
  const column: BoardColumn = waiting
    ? "needs-you"
    : busy
      ? "working"
      : live
        ? "idle"
        : "quiet";

  const loaded = input.chats[chat.id];
  const plan = loaded ? todoLook(latestTodos(loaded.messages)) : undefined;
  const stalled = column === "idle" && !!plan && plan.total > 0 && !plan.finished;

  return {
    id: chat.id,
    projectId: chat.projectId,
    title: chat.title,
    column,
    ...(waiting ? { waiting } : {}),
    ...(plan ? { plan } : {}),
    ...(stalled ? { stalled } : {}),
    updatedAt: chat.updatedAt,
  };
}

/** What this chat is waiting on, if anything.
 *
 *  A permission outranks a question when both are up: the server holds a
 *  permission open for three minutes and a question for ten (see `App.tsx`), so
 *  the permission is the one that expires while you are answering the other. */
function waitingOn(id: string, input: BoardInput): Waiting | undefined {
  const ask = input.asks[id]?.[0];
  if (ask) return { kind: "permission", summary: ask.toolName ?? "a tool" };
  const question = input.questions[id]?.[0];
  if (question) return { kind: "question", summary: question.question ?? "" };
  return undefined;
}
