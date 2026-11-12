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
