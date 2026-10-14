// A reload in the middle of a wait: the turn's start and its waits come back
// together, or neither does.
//
// The bug lived between two stores. The chat's checkpoint (`lib/chatCache`,
// IndexedDB) brought `turnStartedAt` back, and the page's waits were its
// own, in memory, and began again from nothing: 90 s of work and 180 s of
// waiting read `1m 30s` before a reload and `4m 31s` after it. So this goes
// through the real checkpoint and the real `loadChat`, not the pure clock
// alone.
//
// Every look here is one the page KNOWS (its lists of what waits have all
// answered). What it does before they have is `turnClock.unread.test.tsx`.
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
    /** What `App` does with every look at who is waited on, once its lists
     *  have all answered. */
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
    // The wait and the moment it began, marked as the checkpoint's word
    // until a look of this page confirms it.
    expect(next.state.turnWaits).toEqual({ turn: T, waited: 0, since: T + s(90), park: "held" });
    expect(next.state.turnWaits).toMatchObject(saved.turnWaits!);
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
    expect(again.turnWaits).toEqual({ turn: T, waited: 0, since: T + s(90), park: "held" });
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

describe("a reload with a checkpoint older than what the page last saw", () => {
  // A checkpoint is written in a quiet moment, 700 ms after the page's chats
  // last changed, so with agents streaming elsewhere it can be minutes old:
  // older than a wait the page did see begin. The reviewer's clock probe hit
  // exactly this once in three runs, and read `4m 31s` again.
  /** Saved 60 s into the turn, while it worked. */
  async function savedWhileWorking(): Promise<void> {
    const state = withWait(addUserTurn(emptyChat(), "Review now", [], T), false, T + s(30));
    expect(state.turnWaits).toBeUndefined();
    await saveChatCheckpoint({ id: "a", seq: 1, state, updatedAt: T + s(60) });
  }

  it("does not count the wait the page saw begin after it as work", async () => {
    await savedWhileWorking();
    // The card came at 90 s and the page waited 180 s; none of that reached
    // the checkpoint. The page is reloaded at 271 s, still waiting.
    const next = page();
    await next.load(async () => []);
    expect(next.state.turnStartedAt).toBe(T);
    // Back parked since the checkpoint was written: nobody saw it after.
    expect(next.state.turnWaits).toEqual({ turn: T, waited: 0, since: T + s(60), park: "held" });
    const reloaded = T + s(271);
    // The start alone read every second since as work.
    expect(elapsedLabel(turnElapsed(T, undefined, reloaded))).toBe("4m 31s");
    // It reads the work seen up to the checkpoint, before the first look
    // and after it, however long the wait goes on.
    expect(clock(next.state, reloaded)).toBe("1m 00s");
    next.see(false, reloaded);
    next.see(true, reloaded + 400);
    expect(clock(next.state, reloaded + s(300))).toBe("1m 00s");
    next.see(false, reloaded + s(300));
    expect(clock(next.state, reloaded + s(305))).toBe("1m 05s");
    // It never reads more than the turn worked: 90 s before the card.
    expect(turnElapsed(T, next.state.turnWaits, reloaded + s(300))).toBeLessThanOrEqual(s(90));
  });

  it("leaves only the time away out of a turn that was working all along", async () => {
    await savedWhileWorking();
    const next = page();
    await next.load(async () => []);
    // Reloaded two seconds after the checkpoint, no card up: the clock goes
    // on, two seconds short of the turn's real length.
    next.see(false, T + s(62));
    expect(next.state.turnWaits).toEqual({ turn: T, waited: s(2), since: null });
    expect(clock(next.state, T + s(70))).toBe("1m 08s");
  });

  it("keeps the waits the checkpoint already had", async () => {
    // Waited 30 s to 50 s, then worked; saved at 60 s.
    let state = addUserTurn(emptyChat(), "Review now", [], T);
    state = withWait(state, true, T + s(30));
    state = withWait(state, false, T + s(50));
    await saveChatCheckpoint({ id: "a", seq: 1, state, updatedAt: T + s(60) });
    const next = page();
    await next.load(async () => []);
    expect(next.state.turnWaits).toEqual({ turn: T, waited: s(20), since: T + s(60), park: "held" });
    expect(clock(next.state, T + s(500))).toBe("40s");
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
