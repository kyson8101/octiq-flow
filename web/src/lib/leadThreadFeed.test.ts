import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("./bridge", () => ({ bridge: { invoke: vi.fn() } }));
let held: Map<string, string>;
beforeEach(() => {
  vi.resetModules(); held = new Map();
  vi.stubGlobal("localStorage", { getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => held.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());
const thread = { agentId: "head", name: "OCTIQ HEAD", chatKey: "chat:lead-head", cwd: "/repo", exists: true };
it("paints last host lead identities and accepts an authoritative empty list", async () => {
  const { cachedLeadThreads, rememberLeadThreads } = await import("./leadThreadFeed");
  expect(cachedLeadThreads()).toBeNull();
  rememberLeadThreads([thread]);
  expect(cachedLeadThreads()).toEqual([thread]);
  rememberLeadThreads([]);
  expect(cachedLeadThreads()).toEqual([]);
});
it("never revives a locally deleted thread from the navigation cache", async () => {
  held.set("octiq.v2.deletedChats", JSON.stringify([{ id: "lead-head", key: thread.chatKey, at: Date.now() }]));
  const { cachedLeadThreads, rememberLeadThreads } = await import("./leadThreadFeed");
  rememberLeadThreads([thread]);
  expect(cachedLeadThreads()).toEqual([]);
});
it.each(["invalid", "{}", '[{"agentId":"head"}]', '[null]'])("ignores malformed cache %s", async raw => {
  held.set("octiq.v2.leadThreads", raw);
  const { cachedLeadThreads } = await import("./leadThreadFeed");
  expect(cachedLeadThreads()).toBeNull();
});
it("storage failure leaves live navigation updates usable", async () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); } });
  const { cachedLeadThreads, rememberLeadThreads } = await import("./leadThreadFeed");
  expect(cachedLeadThreads()).toBeNull();
  expect(() => rememberLeadThreads([thread])).not.toThrow();
});
/** Mirrors the hook's roster state so tests can replay reply orders. */
async function roster() {
  const { createReadSequencer } = await import("./leadThreadFeed");
  const reads = createReadSequencer();
  let value: string[] = ["lead0", "lead1"], error: string | null = null;
  const ok = (t: ReturnType<typeof reads.begin>, next: string[]) => {
    const v = reads.succeed(t); if (v.apply) { value = next; error = v.error; }
  };
  const bad = (t: ReturnType<typeof reads.begin>, msg: string) => { if (reads.fail(t, msg)) error = msg; };
  return { reads, ok, bad, get: () => ({ value, error }) };
}
it("keeps a removal when a later overlapping read fails (success arrives first)", async () => {
  const r = await roster(); const r1 = r.reads.begin(), r2 = r.reads.begin();
  r.ok(r1, ["lead1"]); r.bad(r2, "boom");
  expect(r.get()).toEqual({ value: ["lead1"], error: "boom" });
});
it("keeps a removal when a later overlapping read fails (failure arrives first)", async () => {
  const r = await roster(); const r1 = r.reads.begin(), r2 = r.reads.begin();
  r.bad(r2, "boom"); r.ok(r1, ["lead1"]);
  expect(r.get()).toEqual({ value: ["lead1"], error: "boom" });
});
it("a success started later wins over an older success that arrives after it", async () => {
  const r = await roster(); const r1 = r.reads.begin(), r2 = r.reads.begin();
  r.ok(r2, ["lead1"]); r.ok(r1, ["lead0", "lead1"]);
  expect(r.get().value).toEqual(["lead1"]);
});
it("an older success still applies while a newer read is in flight, and a later success clears the error", async () => {
  const r = await roster(); const r1 = r.reads.begin(), r2 = r.reads.begin();
  r.ok(r1, ["lead1"]);
  expect(r.get().value).toEqual(["lead1"]);
  r.ok(r2, ["lead1", "lead2"]);
  expect(r.get()).toEqual({ value: ["lead1", "lead2"], error: null });
});
it("a failure older than the newest success never shows and never restores", async () => {
  const r = await roster(); const r1 = r.reads.begin(), r2 = r.reads.begin();
  r.ok(r2, ["lead1"]); r.bad(r1, "late failure");
  expect(r.get()).toEqual({ value: ["lead1"], error: null });
});
it("a reset drops every earlier read, success or failure", async () => {
  const r = await roster(); const r1 = r.reads.begin(); r.reads.reset();
  r.ok(r1, ["lead1"]); r.bad(r1, "boom");
  expect(r.get()).toEqual({ value: ["lead0", "lead1"], error: null });
  const r2 = r.reads.begin(); r.ok(r2, ["lead0", "lead1"]);
  expect(r.get().value).toEqual(["lead0", "lead1"]);
});
it("a same-value refresh still applies", async () => {
  const r = await roster(); const r1 = r.reads.begin(), r2 = r.reads.begin();
  r.ok(r1, ["lead0", "lead1"]); r.ok(r2, ["lead0", "lead1"]);
  expect(r.get()).toEqual({ value: ["lead0", "lead1"], error: null });
});
