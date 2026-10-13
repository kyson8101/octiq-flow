// A reload in the middle of a wait: the turn's start and its waits come back
// together, or neither does.
//
// The bug lived between two stores. The chat's checkpoint (`lib/chatCache`,
// IndexedDB) brought `turnStartedAt` back, and the page's waits were its
// own, in memory, and began again from nothing: 90 s of work and 180 s of
// waiting read `1m 30s` before a reload and `4m 31s` after it. So this goes
// through the real checkpoint and the real `loadChat`, not the pure clock
// alone.
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addUserTurn, emptyChat, type ChatState } from "./chat";
import { CatchUp, type Frame } from "./catchUp";
import { readChatCheckpoint, saveChatCheckpoint } from "./chatCache";
import { loadChat } from "./loadChat";
import { turnElapsed, withWait } from "./turnClock";
import { elapsedLabel } from "./working";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const T = 1_800_000_000_000;
const s = (seconds: number) => seconds * 1000;
/** What the composer's clock reads for a state, at `now`. */
const clock = (state: ChatState, now: number) => elapsedLabel(turnElapsed(state.turnStartedAt!, state.turnWaits, now));

/** A page: its chat's state, and the load it does as it opens the chat. */
function page() {
  let state = emptyChat();
  const options = { id: "a", key: "chat:a", catchUp: new CatchUp(), getState: () => state,
    publish: (next: ChatState) => { state = next; }, cancelled: () => false };
  return {
    get state() { return state; },
    /** What `App` does with every look at who is waited on. */
    see(waiting: boolean, now: number) { state = withWait(state, waiting, now); },
    load: (request: (after: number) => Promise<Frame[]>) => loadChat({ ...options, request }),
  };
}

/** The first page: a turn sent at `T`, a card 90 s into it, and the
 *  checkpoint the page writes in the quiet moment after. Returns the state
 *  it saved. */
async function waitedBeforeReload(): Promise<ChatState> {
  let state = addUserTurn(emptyChat(), "Review now", [], T);
  expect(state).toMatchObject({ busy: true, turnStartedAt: T });
  state = withWait(state, false, T + s(30));
  state = withWait(state, true, T + s(90));
  expect(clock(state, T + s(270))).toBe("1m 30s");
  await saveChatCheckpoint({ id: "a", seq: 1, state, updatedAt: T + s(91) });
  return state;
}

describe("a reload while the chat waits on the person, with a checkpoint", () => {
  it("brings the turn's start and its waits back together", async () => {
    const saved = await waitedBeforeReload();
    const next = page();
    await next.load(async () => []);
    expect(next.state.turnStartedAt).toBe(T);
    expect(next.state.turnWaits).toEqual({ turn: T, waited: 0, since: T + s(90) });
    expect(next.state.turnWaits).toEqual(saved.turnWaits);
  });

  it("puts no waited time back on the clock", async () => {
    await waitedBeforeReload();
    const next = page();
    await next.load(async () => []);
    // The start alone, as the page had it after a reload: every second
    // waited was counted as work.
    const reloaded = T + s(271);
    expect(elapsedLabel(turnElapsed(next.state.turnStartedAt!, undefined, reloaded))).toBe("4m 31s");
    // With the waits that came back beside it, the clock stands where it
    // stood, before the page has read a single card and after.
    expect(clock(next.state, reloaded)).toBe("1m 30s");
    next.see(false, reloaded);
    next.see(true, reloaded + 400);
    expect(clock(next.state, reloaded + 400)).toBe("1m 30s");
    expect(clock(next.state, reloaded + s(600))).toBe("1m 30s");
    // The answer: work goes on from where the clock stopped.
    next.see(false, reloaded + s(600));
    expect(clock(next.state, reloaded + s(605))).toBe("1m 35s");
  });

  it("keeps both in the checkpoint the load itself writes", async () => {
    await waitedBeforeReload();
    const next = page();
    await next.load(async () => []);
    await vi.waitFor(async () => expect((await readChatCheckpoint("a"))?.updatedAt).not.toBe(T + s(91)));
    const again = (await readChatCheckpoint("a"))!.state;
    expect(again.turnStartedAt).toBe(T);
    expect(again.turnWaits).toEqual({ turn: T, waited: 0, since: T + s(90) });
  });

  it("counts a wait answered while no page was open as waited, never as work", async () => {
    await waitedBeforeReload();
    const next = page();
    await next.load(async () => []);
    // The page comes back ten minutes on and no card is up: when the answer
    // was given is not known, so none of that time is put on the clock.
    const back = T + s(690);
    next.see(false, back);
    expect(clock(next.state, back)).toBe("1m 30s");
    expect(clock(next.state, back + s(20))).toBe("1m 50s");
  });
});

describe("a reload while the chat waits on the person, with no checkpoint", () => {
  // A chat never saved, evicted, read in pages, or a browser whose storage
  // is blocked: the page reads the record and joins the turn part-way.
  const record: Frame[] = [
    { seq: 1, event: { type: "user", uuid: "u1", octiq_user_turn: true, message: { content: [{ type: "text", text: "Review now" }] } } },
    { seq: 2, event: { type: "stream_event", event: { type: "message_start", message: { id: "m1" } } } },
  ];

  it("brings back neither: the turn starts when the page joined it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const joined = T + s(271);
    vi.setSystemTime(joined);
    const next = page();
    await next.load(async () => record);
    expect(next.state.busy).toBe(true);
    expect(next.state.turnStartedAt).toBe(joined);
    expect(next.state.turnWaits).toBeUndefined();
    // The card is seen a moment later: stopped at about nothing, and after
    // the answer only the work done since is counted.
    next.see(true, joined + 400);
    expect(clock(next.state, joined + s(120))).toBe("0s");
    next.see(false, joined + s(120));
    expect(clock(next.state, joined + s(150))).toBe("30s");
  });
});
