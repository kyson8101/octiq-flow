import { describe, expect, it } from "vitest";
import { seenWait, waitingChats } from "./chatWait";
import { WAIT_SOURCES, wholeOf, type PendingAction, type SourcesRead, type WaitSource } from "./pendingActions";
import { PARKS, parkStep, signOfWork, type Park, type ParkAfter, type ParkEvent } from "./restoredPark";
import { parkRestored, restoredTurn, turnElapsed, withWait, withWork, type TurnWaits } from "./turnClock";

const EVENTS: readonly ParkEvent[] = [
  { type: "card" },
  { type: "noCard", read: "read" },
  { type: "noCard", read: "unread" },
  { type: "noCard", read: "gaveUp" },
  { type: "work" },
];
const name = (event: ParkEvent) => (event.type === "noCard" ? `noCard/${event.read}` : event.type);

describe("the machine of a wait a checkpoint brought back", () => {
  it("is this table, whole: every state takes every event", () => {
    const table: Record<Park, Record<string, ParkAfter>> = {
      held: { card: "confirmed", "noCard/read": "ended", "noCard/unread": "held", "noCard/gaveUp": "held", work: "held" },
      confirmed: { card: "confirmed", "noCard/read": "ended", "noCard/unread": "answered", "noCard/gaveUp": "answered", work: "confirmed" },
      answered: { card: "confirmed", "noCard/read": "ended", "noCard/unread": "answered", "noCard/gaveUp": "answered", work: "ended" },
    };
    expect(PARKS).toEqual(["held", "confirmed", "answered"]);
    for (const park of PARKS) {
      for (const event of EVENTS) expect(parkStep(park, event), `${park} + ${name(event)}`).toBe(table[park][name(event)]);
    }
  });

  it("ends on a whole read that names no card, or on work after a card the page saw has gone, and on nothing else", () => {
    // Every sequence of seven events from a park just restored: 78,125.
    let ended = 0;
    const walk = (park: Park, taken: ParkEvent[]) => {
      if (taken.length === 7) return;
      for (const event of EVENTS) {
        const after = parkStep(park, event);
        const path = [...taken, event];
        if (after !== "ended") { walk(after, path); continue; }
        ended += 1;
        if (event.type === "noCard") { expect(event.read).toBe("read"); continue; }
        // Never because a card confirmed the wait.
        expect(event.type, path.map(name).join(" ")).toBe("work");
        // (b): since the last card the page saw there is a look that found
        // it gone, and no card after that look.
        const lastCard = path.map((each) => each.type).lastIndexOf("card");
        expect(lastCard, path.map(name).join(" ")).toBeGreaterThanOrEqual(0);
        const between = path.slice(lastCard + 1, -1);
        expect(between.some((each) => each.type === "noCard"), path.map(name).join(" ")).toBe(true);
      }
    };
    walk("held", []);
    expect(ended).toBeGreaterThan(1000);
  });

  it("never leaves a park over a source that is unread or given up when the chat has shown no sign of work", () => {
    // No sequence without a whole read and without work ends.
    const quiet = EVENTS.filter((event) => event.type === "card" || (event.type === "noCard" && event.read !== "read"));
    const walk = (park: Park, depth: number) => {
      if (depth === 8) return;
      for (const event of quiet) {
        const after = parkStep(park, event);
        expect(after).not.toBe("ended");
        walk(after as Park, depth + 1);
      }
    };
    walk("held", 0);
  });
});

describe("what counts as the agent at work", () => {
  it("is the model writing or starting on something, for each provider", () => {
    for (const event of [
      { type: "stream_event", event: { type: "message_start" } },
      { type: "assistant", message: {} },
      { type: "item.started", item: { type: "command_execution" } },
      { type: "item.updated", item: { type: "todo_list" } },
      { type: "item.completed", item: { type: "agent_message" } },
      { type: "item.completed", item: { type: "reasoning" } },
      { event: "step_update", step_update: {} },
    ]) expect(signOfWork(event), JSON.stringify(event)).toBe(true);
  });

  it("is not an answer arriving, the host's word, another writer, or a full stop", () => {
    for (const event of [
      { type: "user", message: { content: [{ type: "tool_result" }] } },
      { type: "item.completed", item: { type: "mcp_tool_call" } },
      { type: "item.completed", item: { type: "command_execution" } },
      { type: "item.completed" },
      { type: "octiq_question_answered" }, { type: "octiq_tool_outcome" }, { type: "octiq_user_turn_delivery" },
      { type: "system", subtype: "init" }, { type: "result" }, { type: "turn.started" }, { type: "turn.completed" },
      { type: "stream_event", parent_tool_use_id: "task-1" }, { type: "assistant", octiq_speaker: { id: "s1" } },
      { event: "init" }, { event: "result" }, {}, null, undefined, "stream_event", 3,
    ]) expect(signOfWork(event), JSON.stringify(event)).toBe(false);
  });
});

// The reviewer's own helpers, as written (review-3b `early-answer-orders.mjs`
// and `early-confirm.mjs`), over the modules as they are: the reading's
// wholeness, which chats wait, the clock. No component is drawn here;
// `turnClock.unread.test.tsx` is the same through what the page draws.
describe("the reviewer's probes of the helpers", () => {
  const T = 1_800_000_000_000;
  type Timed = { busy: boolean; turnStartedAt?: number; turnWaits?: TurnWaits };
  const card = (kind: "question" | "permission"): PendingAction =>
    ({ kind, chatId: "a", key: `${kind}:x`, rowId: "a", openChatId: "a", surface: "chat" }) as PendingAction;
  const permutations = <V,>(list: V[]): V[][] =>
    list.length ? list.flatMap((item, i) => permutations(list.filter((_, j) => j !== i)).map((rest) => [item, ...rest])) : [[]];
  const restored = () => restoredTurn<Timed>({ busy: true, turnStartedAt: T, turnWaits: { turn: T, waited: 0, since: T + 90_000 } }, T + 270_000);

  it("early-confirm: 90 s stays 90 s with the question answered and the permission list unread", () => {
    let state = restored();
    const sources = Object.fromEntries(WAIT_SOURCES.map((source) => [source, "answered"])) as Record<WaitSource, "answered" | "asked">;
    sources.permission_pending = "asked";
    const now = T + 600_000;
    const read: number[] = [];
    for (const [actions, time] of [[[card("question")], now], [[], now + 60_000], [[], now + 180_000]] as const) {
      const whole = wholeOf(sources as SourcesRead, true);
      const holds = waitingChats(actions, new Set(), { whole, restored: parkRestored(state) ? ["a"] : [] });
      state = withWait(state, seenWait(holds, "a"), time, whole);
      read.push(turnElapsed(T, state.turnWaits, time));
    }
    // It read 90,000 → 90,000 → 210,000.
    expect(read).toEqual([90_000, 90_000, 90_000]);
  });

  it("early-answer-orders: 120 of 120, where 60 counted the wait on the permission", () => {
    const orders = permutations([...WAIT_SOURCES]);
    expect(orders).toHaveLength(120);
    const failed: string[] = [];
    for (const order of orders) {
      let state = restored();
      const sources = Object.fromEntries(WAIT_SOURCES.map((source) => [source, "asked"])) as Record<WaitSource, "answered" | "asked">;
      let question = false, permission = false, now = T + 900_000;
      const see = () => {
        const whole = wholeOf(sources as SourcesRead, true);
        const actions = [...(question ? [card("question")] : []), ...(permission ? [card("permission")] : [])];
        const holds = waitingChats(actions, new Set(), { whole, restored: parkRestored(state) ? ["a"] : [] });
        state = withWait(state, seenWait(holds, "a"), now, whole);
        // Until the last answer the clock stands at the work that was seen.
        if (turnElapsed(T, state.turnWaits, now) > 95_000) failed.push(order.join(" > "));
      };
      see();
      for (const source of order) {
        now += 10_000;
        sources[source] = "answered";
        if (source === "question_pending") question = true;
        if (source === "permission_pending") permission = true;
        see();
        if (source === "question_pending") { now += 5_000; question = false; see(); }
      }
      const atCard = turnElapsed(T, state.turnWaits, now);
      permission = false; now += 5_000; see();
      const final = turnElapsed(T, state.turnWaits, now + 5_000);
      if (atCard !== 90_000 || final !== 95_000) failed.push(order.join(" > "));
    }
    expect(failed).toEqual([]);
  });

  it("the same 120 with the agent writing after each answer: only what followed a known card's answer is work", () => {
    // The stream moves five seconds after the question is answered, in
    // every order. Where the permission's card is already up, nothing ends.
    // Where its list is still out, the agent's writing ends the park there,
    // and the permission its list later brings is an ordinary wait.
    for (const order of permutations([...WAIT_SOURCES])) {
      let state = restored();
      const sources = Object.fromEntries(WAIT_SOURCES.map((source) => [source, "asked"])) as Record<WaitSource, "answered" | "asked">;
      let question = false, permission = false, now = T + 900_000, worked = 0, since: number | null = null;
      const see = () => {
        const whole = wholeOf(sources as SourcesRead, true);
        const actions = [...(question ? [card("question")] : []), ...(permission ? [card("permission")] : [])];
        const holds = waitingChats(actions, new Set(), { whole, restored: parkRestored(state) ? ["a"] : [] });
        state = withWait(state, seenWait(holds, "a"), now, whole);
      };
      see();
      for (const source of order) {
        now += 10_000;
        if (since !== null && source === "permission_pending") { worked += now - since; since = null; }
        sources[source] = "answered";
        if (source === "question_pending") question = true;
        if (source === "permission_pending") permission = true;
        see();
        if (source === "question_pending") {
          now += 5_000; question = false; see();
          now += 5_000;
          const before = state;
          state = withWork(state, { type: "assistant" }, now);
          // Let on only where no card is up and the park was still on.
          if (state !== before) { expect(permission).toBe(false); since = now; }
          see();
        }
      }
      expect(turnElapsed(T, state.turnWaits, now), order.join(" > ")).toBe(90_000 + worked);
      permission = false; now += 5_000; see();
      expect(turnElapsed(T, state.turnWaits, now + 5_000), order.join(" > ")).toBe(95_000 + worked);
    }
  });
});
