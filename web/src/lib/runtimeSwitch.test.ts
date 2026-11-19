import { describe, expect, it } from "vitest";
import { MODELS } from "./agentProviders";
import {
  NO_RUNTIMES, antigravityHold, clockWords, homeWords, msToReset, pendingLine, picksThroughSwitch, readAnswer, readHome, readRegistered, readRuntime,
  reduceRuntime, refOf, runtimeSwitchable, sameRuntime, shortModelName, takeAnswer, type HomeRuntime, type RuntimeState,
} from "./runtimeSwitch";

const opusHome: HomeRuntime = { agent: "claude", model: "opus", effort: "high", limited: true, resetsAt: Math.floor(Date.UTC(2026, 10, 19, 7, 40) / 1000) };
const codex = { agent: "codex" as const, model: "gpt-5.6-sol", effort: "high" };

describe("reading the host's runtimes", () => {
  it("reads a whole runtime and nothing else", () => {
    expect(readRuntime({ agent: "codex", model: "gpt-5.6-sol", effort: "high" })).toEqual(codex);
    expect(readRuntime({ agent: "codex", model: null, effort: null })).toEqual({ agent: "codex", model: null, effort: null });
    expect(readRuntime({ agent: "gemini", model: "x" })).toBeUndefined();
    expect(readRuntime(null)).toBeUndefined();
    expect(readRuntime("codex")).toBeUndefined();
  });

  it("keeps a reset only when the host gave a real one", () => {
    expect(readHome({ agent: "claude", model: "opus", effort: null, limited: true, resetsAt: 1_800_000_000 })).toMatchObject({ limited: true, resetsAt: 1_800_000_000 });
    const none = readHome({ agent: "claude", model: "opus", effort: null, limited: true });
    expect(none).toEqual({ agent: "claude", model: "opus", effort: null, limited: true });
    expect(readHome({ agent: "claude", limited: true, resetsAt: 0 })).not.toHaveProperty("resetsAt");
    expect(readHome({ limited: true })).toBeUndefined();
  });

  it("reads an answer only with a state it knows", () => {
    expect(readAnswer({ state: "pending", agent: "claude", model: "opus", effort: null, access: "auto" })).toMatchObject({ state: "pending", access: "auto" });
    expect(readAnswer({ state: "maybe", agent: "claude" })).toBeUndefined();
    expect(readAnswer({ agent: "claude" })).toBeUndefined();
  });
});

describe("asking for a runtime", () => {
  const opus = MODELS.find((m) => m.id === "claude:opus")!;
  const sol = MODELS.find((m) => m.id === "codex:sol")!;
  const agy = MODELS.find((m) => m.agent === "antigravity" && m.flag)!;

  it("names Auto effort as the provider's own, and drops an effort the provider lacks", () => {
    expect(refOf(opus, "auto")).toEqual({ agent: "claude", model: "opus", effort: null });
    expect(refOf(opus, "high")).toEqual({ agent: "claude", model: "opus", effort: "high" });
    // Codex has no ultracode: it falls back to the provider's first, never a made-up level.
    expect(refOf(sol, "ultracode").effort).not.toBe("ultracode");
  });

  it("never asks Antigravity for an effort: it is part of its model id", () => {
    expect(refOf(agy, "high").effort).toBeNull();
  });

  it("calls two runtimes the same however each spells its default", () => {
    expect(sameRuntime({ agent: "claude", model: "opus", effort: null }, { agent: "claude", model: "opus", effort: "auto" })).toBe(true);
    expect(sameRuntime({ agent: "claude", model: "opus", effort: "low" }, { agent: "claude", model: "opus", effort: "high" })).toBe(false);
    expect(sameRuntime({ agent: "claude", model: "opus", effort: null }, { agent: "codex", model: "opus", effort: null })).toBe(false);
    expect(sameRuntime({ agent: "claude", model: null, effort: null }, { agent: "claude", model: "", effort: null })).toBe(true);
  });
});

describe("folding what the host says", () => {
  const fold = (...actions: Parameters<typeof reduceRuntime>[1][]): RuntimeState => actions.reduce(reduceRuntime, NO_RUNTIMES);

  it("holds a pending switch until the host says it is cleared", () => {
    const waiting = fold({ type: "pending", chatId: "c", runtime: codex });
    expect(waiting.c.pending).toEqual(codex);
    expect(fold({ type: "pending", chatId: "c", runtime: codex }, { type: "cleared", chatId: "c" }).c.pending).toBeUndefined();
  });

  it("a second pick replaces the first", () => {
    const next = { agent: "claude" as const, model: "sonnet", effort: null };
    expect(fold({ type: "pending", chatId: "c", runtime: codex }, { type: "pending", chatId: "c", runtime: next }).c.pending).toEqual(next);
  });

  it("takes the way back from the switch event, and drops it when the host says the chat is home", () => {
    const onFallback = fold({ type: "switched", chatId: "c", home: opusHome });
    expect(onFallback.c.home).toEqual(opusHome);
    expect(reduceRuntime(onFallback, { type: "switched", chatId: "c", home: null }).c.home).toBeUndefined();
    // An older host sends no `home`: what the page knew stays.
    expect(reduceRuntime(onFallback, { type: "switched", chatId: "c" }).c.home).toEqual(opusHome);
  });

  it("a read older than an event does not put the older answer back", () => {
    const read = { type: "queue" as const, chatId: "c", rev: 0, pending: undefined, home: opusHome };
    const eventFirst = fold({ type: "pending", chatId: "c", runtime: codex }, read);
    expect(eventFirst.c.pending).toEqual(codex);
    expect(eventFirst.c.home).toBeUndefined();
    // A read taken at the current revision is applied: a reload and a second tab draw the same.
    const fresh = fold(read);
    expect(fresh.c).toMatchObject({ home: opusHome });
    expect(fold({ type: "queue", chatId: "c", rev: 0, pending: codex, home: opusHome }).c).toMatchObject({ pending: codex, home: opusHome });
  });

  it("an answer after the events for the same switch changes nothing", () => {
    const events = fold({ type: "pending", chatId: "c", runtime: codex }, { type: "cleared", chatId: "c" });
    expect(reduceRuntime(events, { type: "answer", chatId: "c", rev: 0, answer: { ...codex, state: "pending" } })).toBe(events);
  });

  it("a delayed older answer is not applied over a newer host event (M1)", () => {
    const sol = { ...codex, state: "switched" as const };
    // The press was made at rev 0; a newer host switch to Opus arrived while the reply was held.
    const newer = fold({ type: "switched", chatId: "c" });
    const late = takeAnswer(newer, "c", 0, sol);
    expect(late.apply).toBe(false);
    expect(late.state).toBe(newer);
    // With no event in between, the answer is the newest word and is applied.
    const quiet = takeAnswer(NO_RUNTIMES, "c", 0, sol);
    expect(quiet.apply).toBe(true);
    // A pending answer applies nothing to the page's settings, accepted or not.
    expect(takeAnswer(NO_RUNTIMES, "c", 0, { ...codex, state: "pending" }).apply).toBe(false);
  });

  it("a pending answer says what waits; a switched one says nothing waits", () => {
    const waiting = fold({ type: "answer", chatId: "c", rev: 0, answer: { ...codex, state: "pending" } });
    expect(waiting.c.pending).toMatchObject(codex);
    const done = reduceRuntime(waiting, { type: "answer", chatId: "c", rev: waiting.c.rev, answer: { ...codex, state: "switched" } });
    expect(done.c.pending).toBeUndefined();
  });

  it("keeps the home runtime while a switch is cleared", () => {
    const state = fold({ type: "switched", chatId: "c", home: opusHome }, { type: "pending", chatId: "c", runtime: opusHome }, { type: "cleared", chatId: "c" });
    expect(state.c.home).toEqual(opusHome);
  });
});

describe("the way back, in words", () => {
  const T = Date.UTC(2026, 10, 19, 6, 0);
  it("names the reset while the limit stands", () => {
    const words = homeWords("codex", opusHome, T, "en-US");
    expect(words.label).toBe("Running on Codex");
    expect(words.detail).toMatch(/^Opus limit resets \d{1,2}:\d{2}\s?(AM|PM)$/);
    expect(words.back).toBe("Back to Opus");
  });

  it("says it may be available once the reset has passed, and still offers the way back", () => {
    const words = homeWords("codex", opusHome, T + 3 * 3_600_000, "en-US");
    expect(words.detail).toBe("Opus may be available again");
    expect(words.back).toBe("Back to Opus");
  });

  it("says it may be available when the host is not limited, and when it says no reset", () => {
    expect(homeWords("codex", { ...opusHome, limited: false, resetsAt: undefined }, T).detail).toBe("Opus may be available again");
    expect(homeWords("codex", { ...opusHome, limited: true, resetsAt: undefined }, T).detail).toBe("Opus limit reached");
  });

  it("names another day's reset by its weekday", () => {
    const next = Date.UTC(2026, 10, 21, 12, 0);
    expect(clockWords(next, T, "en-US")).toMatch(/^[A-Z][a-z]{2} \d/);
  });

  it("calls the alias by its family and a versioned model by its version", () => {
    expect(shortModelName({ agent: "claude", model: "opus", effort: null })).toBe("Opus");
    expect(shortModelName({ agent: "claude", model: "claude-opus-5-5", effort: null })).toBe("Opus 5.5");
  });

  it("words a waiting switch", () => {
    expect(pendingLine({ agent: "claude", model: "opus", effort: null })).toBe("Switches to Opus after this turn");
  });
});

describe("the one timer", () => {
  const now = 1_000_000;
  it("waits for the reset only while a real reset is ahead", () => {
    expect(msToReset({ limited: true, resetsAt: (now + 60_000) / 1000 }, now)).toBeGreaterThanOrEqual(60_000);
    expect(msToReset({ limited: true, resetsAt: (now - 1000) / 1000 }, now)).toBeUndefined();
    expect(msToReset({ limited: false, resetsAt: (now + 60_000) / 1000 }, now)).toBeUndefined();
    expect(msToReset({ limited: true }, now)).toBeUndefined();
    expect(msToReset(undefined, now)).toBeUndefined();
  });

  it("is in steps a timer can hold", () => {
    expect(msToReset({ limited: true, resetsAt: (now + 90 * 86_400_000) / 1000 }, now)).toBe(2 ** 31 - 1);
  });
});

describe("who is offered it", () => {
  const ok = { identity: true, removed: false, workerChat: false, frontDesk: false, saved: true, started: true };
  it("offers a sent conversation with a registered agent", () => expect(runtimeSwitchable(ok)).toBe(true));
  it.each([
    ["no agent", { identity: false }],
    ["a removed agent", { removed: true }],
    ["a worker's chat", { workerChat: true }],
    ["a front desk", { frontDesk: true }],
    ["a conversation not saved", { saved: false }],
    ["a conversation not sent yet", { started: false }],
  ])("does not offer %s", (_name, change) => expect(runtimeSwitchable({ ...ok, ...change })).toBe(false));

  it("holds Antigravity at guarded Auto or Manual, in words, and nothing else", () => {
    expect(antigravityHold("antigravity", "auto")).toMatch(/cannot ask/);
    expect(antigravityHold("antigravity", "manual")).toMatch(/Auto or Manual/);
    for (const level of ["read", "edits", "full"] as const) expect(antigravityHold("antigravity", level)).toBeUndefined();
    expect(antigravityHold("claude", "auto")).toBeUndefined();
  });
});

describe("a pick in a registered agent's chat is a runtime switch, whatever agents mode is", () => {
  it("reads only a boolean as the host's word", () => {
    expect(readRegistered(true)).toBe(true);
    expect(readRegistered(false)).toBe(false);
    for (const odd of [undefined, null, "true", 1, {}]) expect(readRegistered(odd)).toBeUndefined();
  });

  it("goes through the switch only for a registered, saved, sent chat", () => {
    expect(picksThroughSwitch({ registered: true, saved: true, started: true })).toBe(true);
    expect(picksThroughSwitch({ registered: false, saved: true, started: true })).toBe(false);
    // An older host says nothing: the chat stays on the ordinary picker.
    expect(picksThroughSwitch({ registered: undefined, saved: true, started: true })).toBe(false);
    expect(picksThroughSwitch({ registered: true, saved: false, started: true })).toBe(false);
    expect(picksThroughSwitch({ registered: true, saved: true, started: false })).toBe(false);
  });
});
