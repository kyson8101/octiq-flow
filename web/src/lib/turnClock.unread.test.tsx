// A reload in the middle of a wait, with the page's lists of what waits
// read late, read empty, or never read.
//
// `turnClock.reload.test.ts` is the checkpoint bringing the turn's start and
// its waits back. This is what the page then does with them before it knows
// anything: its card lists start EMPTY and are filled by one request each,
// and "not read yet" was taken for "nothing waits". With `question_pending`
// held back 120 s, `1m 30s` read `3m 31s`, drawn as thinking, and stayed
// `3m 31s` once the question was back on screen.
//
// So this goes the whole way the page goes: the real checkpoint and
// `loadChat`, then the three steps `App` makes on every look (the reading,
// which chats wait, the clock), then what the composer, the task bar and the
// chat list draw from them. `chatWait.wiring.test.ts` holds `App` to those
// three steps as they are spelled here.
import { IDBFactory } from "fake-indexeddb";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));

import { Composer, MODELS } from "../components/Composer";
import { addUserTurn, emptyChat, type ChatState } from "./chat";
import { CatchUp, type Frame } from "./catchUp";
import { saveChatCheckpoint } from "./chatCache";
import { phaseOf } from "./chatTask";
import { seenWait, waitingChats, workingChats, type ChatHold } from "./chatWait";
import { loadChat } from "./loadChat";
import { EMPTY_ORCHESTRATION } from "./orchestration";
import { SILENT_MS, WAIT_SOURCES, pendingReading, type SourceRead, type SourcesRead, type WaitSource } from "./pendingActions";
import type { Question } from "./question";
import { parkRestored, withWait } from "./turnClock";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const T = 1_800_000_000_000;
const s = (seconds: number) => seconds * 1000;
const opus = MODELS.find((model) => model.agent === "claude" && model.flag === "opus")!;
const every = (state: SourceRead) => Object.fromEntries(WAIT_SOURCES.map((source) => [source, state])) as SourcesRead;
const question = (status: Question["status"]): Question => ({ id: "q1", chatKey: "chat:a", question: "Ship it?", status });

/** What the page draws for the chat: the composer's eyebrow as text, the
 *  task bar's word, and whether its row in the chat list is drawn working. */
type Drawn = { eyebrow: string; taskBar: string; listedWorking: boolean };

/** A page that has just loaded: no card list read, no ledger.
 *
 *  `unknownIsNotWaiting` is the page as it was: an unread list read as an
 *  empty one, and a chat nothing names read as working. */
function page({ unknownIsNotWaiting = false } = {}) {
  let state = emptyChat();
  let questions: Record<string, Question[]> = {};
  let sources = every("asked");
  let late = false;
  const options = { id: "a", key: "chat:a", catchUp: new CatchUp(), getState: () => state,
    publish: (next: ChatState) => { state = next; }, cancelled: () => false };

  // The three steps `App` makes, in its order.
  const reading = () => pendingReading({
    orchestration: EMPTY_ORCHESTRATION, parents: new Map(), questions, sources, late,
  });
  const waits = (): ReadonlyMap<string, ChatHold> => {
    const read = reading();
    return unknownIsNotWaiting
      ? waitingChats(read.actions, new Set())
      : waitingChats(read.actions, new Set(), { whole: read.whole, restored: parkRestored(state) ? ["a"] : [] });
  };
  const look = (now: number) => {
    const held = waits();
    state = unknownIsNotWaiting
      ? withWait(state, held.has("a"), now)
      : withWait(state, seenWait(held, "a"), now, reading().whole);
  };

  return {
    get state() { return state; },
    load: (request: (after: number) => Promise<Frame[]> = async () => []) => loadChat({ ...options, request }),
    /** One of the page's requests answers. */
    answers(source: WaitSource, list?: Question[]) {
      sources = { ...sources, [source]: "answered" };
      if (list) questions = { a: list };
    },
    /** Every one but `source` answers, with nothing in it. */
    answersAllBut(source: WaitSource) {
      for (const other of WAIT_SOURCES) if (other !== source) sources = { ...sources, [other]: "answered" };
    },
    /** A request failed twice (`lib/listRead`). */
    fails(source: WaitSource) { sources = { ...sources, [source]: "failed" }; },
    /** `SILENT_MS` have passed since the lists were asked. */
    waitedTooLong() { late = true; },
    /** A new connection: every source is asked again. */
    reconnects() { sources = every("asked"); late = false; },
    /** A live `question-updated` event. */
    updates(list: Question[]) { questions = { a: list }; },
    /** The page's look at `now`, and what it then draws. */
    at(now: number): Drawn {
      look(now);
      vi.setSystemTime(now);
      const hold = waits().get("a") ?? null;
      const html = renderToStaticMarkup(
        <Composer choice={opus} onChoice={() => {}} access="auto" onAccess={() => {}} onSend={() => {}} onStop={() => {}}
          effort="high" onEffort={() => {}} lite={false} onLite={() => {}} identity={null}
          busy={state.busy} thinking turnStartedAt={state.turnStartedAt} turnWaits={state.turnWaits} waiting={hold} />,
      );
      const hint = html.slice(html.indexOf('<div class="composer-hint">'), html.indexOf('class="composer-history"'));
      const clock = /<span class="working-clock">([^<]+)<\/span>/.exec(hint)?.[1] ?? "";
      const words = /<span class="working-waits[^"]*">([^<]+)<\/span>/.exec(hint)?.[1]
        ?? (/thinking with high effort/.exec(hint)?.[0] ?? "");
      return {
        eyebrow: `${clock} · ${words}`,
        taskBar: phaseOf(undefined, { busy: state.busy, waiting: hold }).label,
        // The chat list's own rule (`Sidebar`: busy and not in the map), and
        // the projects page's set.
        listedWorking: state.busy && !waits().has("a") && workingChats(new Set(["a"]), waits()).has("a"),
      };
    },
  };
}

/** The first page: a turn sent at `T`, a question 90 s into it, and the
 *  checkpoint written a second later. The reload is at 271 s, after 180 s
 *  of waiting. */
async function reloadedWhileWaiting(options?: Parameters<typeof page>[0]) {
  let state = addUserTurn(emptyChat(), "Review now", [], T);
  state = withWait(state, false, T + s(30));
  state = withWait(state, true, T + s(90));
  await saveChatCheckpoint({ id: "a", seq: 1, state, updatedAt: T + s(91) });
  const next = page(options);
  await next.load();
  return next;
}
const RELOAD = T + s(271);

/** What the task bar says of a chat with no turn to speak of: where its
 *  work stands (here, nothing verified). Neither of its two live words. */
const QUIET = phaseOf(undefined).label;
const HELD = { eyebrow: "1m 30s · Checking what waits on you", taskBar: QUIET, listedWorking: false };
const WAITING = { eyebrow: "1m 30s · Waiting for your answer", taskBar: "Needs you", listedWorking: false };
const working = (clock: string) => ({ eyebrow: `${clock} · thinking with high effort`, taskBar: "Working", listedWorking: true });

describe("a reload while the chat waits, with the lists of what waits not read yet", () => {
  it("draws the held chat as neither working nor waiting on the person", () => {
    expect(["Working", "Needs you"]).not.toContain(QUIET);
  });

  it("(a) holds the clock for 120 s of not knowing, and is still waiting when the question arrives", async () => {
    const next = await reloadedWhileWaiting();
    // Nothing has answered: not `thinking`, not working, not `Needs you`.
    expect(next.at(RELOAD)).toEqual(HELD);
    expect(next.at(RELOAD + s(1))).toEqual(HELD);
    // Every list but the question's answers, empty. Still not known.
    next.answersAllBut("question_pending");
    expect(next.at(RELOAD + s(2))).toEqual(HELD);
    expect(next.at(RELOAD + s(120))).toEqual(HELD);
    // The question's list answers: it is still pending.
    next.answers("question_pending", [question("pending")]);
    expect(next.at(RELOAD + s(120))).toEqual(WAITING);
    expect(next.at(RELOAD + s(600))).toEqual(WAITING);
    // The wait kept the moment it began before the reload.
    expect(next.state.turnWaits).toEqual({ turn: T, waited: 0, since: T + s(90) });
    // Answered: work goes on from where the clock stopped.
    next.updates([question("saved")]);
    expect(next.at(RELOAD + s(600))).toEqual(working("1m 30s"));
    expect(next.at(RELOAD + s(605))).toEqual(working("1m 35s"));
  });

  it("(a) is the same whichever list answers first", async () => {
    for (const first of WAIT_SOURCES) {
      vi.stubGlobal("indexedDB", new IDBFactory());
      const next = await reloadedWhileWaiting();
      const order = [first, ...WAIT_SOURCES.filter((source) => source !== first)];
      let now = RELOAD;
      for (const source of order) {
        expect(next.at(now).eyebrow, `before ${source}, ${first} first`).toMatch(/^1m 30s · (Checking what waits on you|Waiting for your answer)$/);
        next.answers(source, source === "question_pending" ? [question("pending")] : undefined);
        now += s(30);
      }
      expect(next.at(now), `${first} first`).toEqual(WAITING);
      next.updates([question("saved")]);
      expect(next.at(now + s(5)).eyebrow).toBe("1m 30s · thinking with high effort");
      expect(next.at(now + s(10)).eyebrow).toBe("1m 35s · thinking with high effort");
    }
  });

  it("(b) holds the clock, then goes on from it, when the lists arrive empty", async () => {
    // The question was answered while no page was open.
    const next = await reloadedWhileWaiting();
    expect(next.at(RELOAD + s(120))).toEqual(HELD);
    next.answersAllBut("question_pending");
    expect(next.at(RELOAD + s(120))).toEqual(HELD);
    next.answers("question_pending", []);
    // Known now: nothing waits. None of the time away or held is work.
    expect(next.at(RELOAD + s(120))).toEqual(working("1m 30s"));
    expect(next.at(RELOAD + s(125))).toEqual(working("1m 35s"));
    expect(next.state.turnWaits).toEqual({ turn: T, waited: RELOAD + s(120) - (T + s(90)), since: null });
  });

  it("(c) holds for a list that never arrives, lets go after five minutes, and takes the guess back if it answers", async () => {
    const next = await reloadedWhileWaiting();
    next.answersAllBut("question_pending");
    expect(next.at(RELOAD + s(120))).toEqual(HELD);
    expect(next.at(RELOAD + SILENT_MS - 1)).toEqual(HELD);
    // Five minutes of silence: the page goes on with what it has, on a
    // guess. The time it held is left out; the clock goes on from 1m 30s.
    next.waitedTooLong();
    expect(next.at(RELOAD + SILENT_MS)).toEqual(working("1m 30s"));
    expect(next.at(RELOAD + SILENT_MS + s(40))).toEqual(working("2m 10s"));
    // The list answers after all, and the question is still pending: the
    // guess was wrong, and its 100 s are taken back off the clock.
    next.answers("question_pending", [question("pending")]);
    expect(next.at(RELOAD + SILENT_MS + s(100))).toEqual(WAITING);
    next.updates([question("saved")]);
    expect(next.at(RELOAD + SILENT_MS + s(400))).toEqual(working("1m 30s"));
    expect(next.at(RELOAD + SILENT_MS + s(405))).toEqual(working("1m 35s"));
  });

  it("(c) lets the guess stand when the list that never arrived answers empty", async () => {
    const next = await reloadedWhileWaiting();
    next.answersAllBut("question_pending");
    next.waitedTooLong();
    expect(next.at(RELOAD + SILENT_MS)).toEqual(working("1m 30s"));
    next.answers("question_pending", []);
    expect(next.at(RELOAD + SILENT_MS + s(100))).toEqual(working("3m 10s"));
    expect(next.state.turnWaits?.guessed).toBeUndefined();
  });

  it("(c) does not hold for a list that failed twice once the rest have answered, and is not dropped before that", async () => {
    const next = await reloadedWhileWaiting();
    // The question's list has failed for good; the others are still out.
    next.fails("question_pending");
    expect(next.at(RELOAD + s(4))).toEqual(HELD);
    expect(next.at(RELOAD + s(60))).toEqual(HELD);
    // Nothing more is coming on this connection: on a guess from here.
    next.answersAllBut("question_pending");
    next.fails("question_pending");
    expect(next.at(RELOAD + s(60))).toEqual(working("1m 30s"));
    expect(next.at(RELOAD + s(90))).toEqual(working("2m 00s"));
    // The next connection asks again, and the question is there.
    next.reconnects();
    expect(next.at(RELOAD + s(95))).toEqual(working("2m 05s"));
    next.answers("question_pending", [question("pending")]);
    expect(next.at(RELOAD + s(96))).toEqual(WAITING);
  });

  it("never reads more than the 90 s the turn worked, in any of these orders", async () => {
    const orders: ((next: ReturnType<typeof page>) => void)[] = [
      (next) => next.answers("question_pending", [question("pending")]),
      (next) => { next.answersAllBut("question_pending"); next.answers("question_pending", [question("pending")]); },
      (next) => { next.answersAllBut("question_pending"); next.waitedTooLong(); next.answers("question_pending", [question("pending")]); },
      (next) => { next.fails("permission_pending"); next.answers("question_pending", [question("pending")]); },
      (next) => { next.reconnects(); next.answers("question_pending", [question("pending")]); },
    ];
    for (const arrive of orders) {
      vi.stubGlobal("indexedDB", new IDBFactory());
      const next = await reloadedWhileWaiting();
      next.at(RELOAD);
      next.at(RELOAD + s(119));
      arrive(next);
      expect(next.at(RELOAD + s(400))).toEqual(WAITING);
    }
  });
});

describe("the page as it was: a list not read yet taken for an empty one", () => {
  it("fails every case above: the wait is counted as work and drawn as thinking", async () => {
    const was = await reloadedWhileWaiting({ unknownIsNotWaiting: true });
    was.at(RELOAD);
    // 120 s of an unanswered `question_pending`: the reviewer's `3m 31s`.
    expect(was.at(RELOAD + s(120))).toEqual(working("3m 30s"));
    was.answers("question_pending", [question("pending")]);
    // Parked again, with the 120 s kept on the clock for good.
    expect(was.at(RELOAD + s(120)).eyebrow).toBe("3m 30s · Waiting for your answer");
    was.updates([question("saved")]);
    was.at(RELOAD + s(300));
    expect(was.at(RELOAD + s(305)).eyebrow).toBe("3m 35s · thinking with high effort");
  });
});

describe("a chat with no restored wait", () => {
  it("is drawn working at once: a turn that starts after the reload does not wait for the lists", async () => {
    // The person sends a message on a page that has just loaded: nothing
    // has answered, and nothing will for a while.
    const started = T + s(5);
    let state = addUserTurn(emptyChat(), "Go", [], started);
    const read = pendingReading({ orchestration: EMPTY_ORCHESTRATION, parents: new Map(), sources: every("asked") });
    expect(read.whole).toBe("unread");
    const held = waitingChats(read.actions, new Set(), { whole: read.whole, restored: parkRestored(state) ? ["a"] : [] });
    expect(held.has("a")).toBe(false);
    state = withWait(state, seenWait(held, "a"), started + s(30), read.whole);
    expect(state.turnWaits).toBeUndefined();
    expect(phaseOf(undefined, { busy: true, waiting: held.get("a") ?? null }).label).toBe("Working");
    expect(workingChats(new Set(["a"]), held).has("a")).toBe(true);
  });

  it("is not held when its checkpoint had no turn in flight", async () => {
    await saveChatCheckpoint({ id: "a", seq: 1, state: emptyChat(), updatedAt: T });
    const next = page();
    await next.load();
    expect(parkRestored(next.state)).toBe(false);
    expect(next.at(T + s(5)).listedWorking).toBe(false);
    expect(next.state.turnWaits).toBeUndefined();
  });
});

describe("a reload while the turn was working, with the lists read late", () => {
  it("holds the clock at the work the checkpoint saw until the lists say nothing waits", async () => {
    const state = withWait(addUserTurn(emptyChat(), "Review now", [], T), false, T + s(30));
    await saveChatCheckpoint({ id: "a", seq: 1, state, updatedAt: T + s(60) });
    const next = page();
    await next.load();
    const back = T + s(62);
    expect(next.at(back).eyebrow).toBe("1m 00s · Checking what waits on you");
    for (const source of WAIT_SOURCES) next.answers(source);
    // 300 ms later everything has answered: two seconds short, never over.
    expect(next.at(back + 300)).toEqual(working("1m 00s"));
    expect(next.at(back + s(8) + 300)).toEqual(working("1m 08s"));
  });
});
