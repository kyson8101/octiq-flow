import { beforeEach, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
const events = vi.hoisted(() => new Map<string, (value: unknown) => void>());
const on = vi.hoisted(() => vi.fn((name: string, fn: (value: unknown) => void) => { events.set(name, fn); return () => events.delete(name); }));
vi.mock("./bridge", () => ({ bridge: { invoke, on, onState: (fn: (state: string) => void) => { fn("open"); return () => {}; } } }));
beforeEach(() => { vi.resetModules(); invoke.mockReset(); on.mockClear(); events.clear(); });
const data = (queued: number) => ({ orientation: "agents", hostCap: 3, live: { total: 1 }, lanes: [{ agentId: "fe", state: "working", queued }] });
it("shares one subscription and accepts an event after get", async () => {
  invoke.mockResolvedValue(data(1));
  const { subscribeScheduling, schedulingReading, useAgentLanes } = await import("./agentLanes");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  // Capture the current client snapshot through the listener, without a DOM.
  const updates = vi.fn();
  const a = subscribeScheduling(updates), b = subscribeScheduling(updates);
  await Promise.resolve();
  expect(on).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("scheduling_get");
  events.get("scheduling-changed")!(data(4));
  expect(updates).toHaveBeenCalledTimes(2);
  expect(schedulingReading().data).toEqual(data(4));
  // SSR stays empty rather than leaking a prior browser's lanes.
  function Probe() { return createElement("p", null, useAgentLanes().data?.hostCap ?? "unread"); }
  expect(renderToStaticMarkup(createElement(Probe))).toContain("unread");
  a(); b(); expect(events.size).toBe(0);
});
it("does not let a late get overwrite an event", async () => {
  let resolve!: (value: unknown) => void;
  invoke.mockReturnValue(new Promise(done => { resolve = done; }));
  const { subscribeScheduling, schedulingReading } = await import("./agentLanes");
  const updates = vi.fn(); const off = subscribeScheduling(updates);
  events.get("scheduling-changed")!(data(5));
  resolve(data(0)); await Promise.resolve();
  expect(updates).toHaveBeenCalledTimes(1);
  expect(schedulingReading().data).toEqual(data(5));
  off();
});
it("replaces exactly the settings and propagates the host's refusal", async () => {
  const { saveScheduling } = await import("./agentLanes");
  invoke.mockRejectedValue(new Error("The profile folder is away."));
  await expect(saveScheduling({ orientation: "tasks", hostCap: null })).rejects.toThrow("The profile folder is away.");
  expect(invoke).toHaveBeenCalledWith("scheduling_set", { settings: { orientation: "tasks", hostCap: null } });
});
