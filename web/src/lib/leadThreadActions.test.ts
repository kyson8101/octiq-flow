import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LeadThreadsReading } from "./leadThreads";
import type { Scheduling } from "./agentLanes";

const invoke = vi.hoisted(() => vi.fn());
const events = vi.hoisted(() => new Map<string, (data: unknown) => void>());
const states = vi.hoisted(() => new Set<(state: string) => void>());
vi.mock("./bridge", () => ({ bridge: {
  invoke,
  on: (event: string, fn: (data: unknown) => void) => { events.set(event, fn); return () => events.delete(event); },
  onState: (fn: (state: string) => void) => { states.add(fn); fn("open"); return () => states.delete(fn); },
} }));

const lead = { agentId: "head", name: "Head", chatKey: "chat:lead-head", cwd: "/repo", exists: true };
const scheduling: Scheduling = { orientation: "agents", hostCap: null, lanes: [], live: { total: 0 } };
let reading: LeadThreadsReading, enabled: boolean, epoch: number, stop: () => void;
beforeEach(() => {
  vi.resetModules(); invoke.mockReset(); events.clear(); states.clear();
  reading = { threads: [lead], error: null, freshness: "host" }; enabled = true; epoch = 0;
  invoke.mockImplementation((cmd: string) => Promise.resolve(cmd === "scheduling_get" ? scheduling : { id: "lead-head" }));
});
afterEach(() => stop?.());
async function setup() {
  const lanes = await import("./agentLanes");
  stop = lanes.subscribeScheduling(() => {});
  await Promise.resolve();
  const feed = await import("./leadThreadFeed");
  return { ...feed, ...lanes, token: () => feed.leadActionToken("head", () => reading, () => enabled, () => epoch) };
}

it("does not send lead_thread_open when a cached row is pressed before confirmation", async () => {
  const feed = await setup();
  reading = { ...reading, freshness: "cached" };
  expect(await feed.openConfirmedLeadThread("head", feed.token())).toBeNull();
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "lead_thread_open")).toHaveLength(0);
});
it("waits for orientation even if lead_threads has already confirmed the identity", async () => {
  invoke.mockReturnValue(new Promise(() => {}));
  const feed = await setup();
  expect(await feed.openConfirmedLeadThread("head", feed.token())).toBeNull();
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "lead_thread_open")).toHaveLength(0);
});
it.each(["tasks", "removed", "empty", "disabled"])("refuses an identity with authoritative %s state", async state => {
  const feed = await setup();
  if (state === "tasks") events.get("scheduling-changed")!({ ...scheduling, orientation: "tasks" });
  if (state === "removed") reading = { ...reading, threads: [{ ...lead, agentId: "other" }] };
  if (state === "empty") reading = { ...reading, threads: [] };
  if (state === "disabled") enabled = false;
  expect(await feed.openConfirmedLeadThread("head", feed.token())).toBeNull();
  expect(invoke.mock.calls.filter(([cmd]) => cmd === "lead_thread_open")).toHaveLength(0);
});
it("opens a confirmed lead normally", async () => {
  const feed = await setup();
  expect(await feed.openConfirmedLeadThread("head", feed.token())).toEqual({ id: "lead-head" });
  expect(invoke).toHaveBeenLastCalledWith("lead_thread_open", { agentId: "head" });
});
it.each(["same-roster", "self-index", "same-orientation", "worker-lanes"])("delivers an in-flight open after %s confirms the same authority", async newer => {
  const feed = await setup();
  let resolve!: (entry: unknown) => void;
  invoke.mockReturnValue(new Promise(done => { resolve = done; }));
  const pending = feed.openConfirmedLeadThread("head", feed.token());
  if (newer === "same-roster" || newer === "self-index") reading = { ...reading, threads: [{ ...lead }] };
  if (newer === "same-orientation") events.get("scheduling-changed")!({ ...scheduling });
  if (newer === "worker-lanes") events.get("scheduling-changed")!({ ...scheduling, live: { total: 1 }, lanes: [{ agentId: "fe", state: "working", queued: 1 }] });
  resolve({ id: "lead-head" });
  expect(await pending).toEqual({ id: "lead-head" });
});
it.each([
  ["empty", /no longer listed/], ["removed", /no longer listed/],
  ["tasks", /orientation changed/], ["orientation-returned", /orientation changed/],
  ["disconnect", /connection/i], ["reconfirmed", /connection/i],
  ["disabled", /disabled/], ["reenabled", /reset or disabled/],
] as const)("drops a delayed successful open after %s with a reason", async (newer, reason) => {
  const feed = await setup();
  let resolve!: (entry: unknown) => void;
  invoke.mockReturnValue(new Promise(done => { resolve = done; }));
  const pending = feed.openConfirmedLeadThread("head", feed.token());
  expect(invoke).toHaveBeenLastCalledWith("lead_thread_open", { agentId: "head" });
  if (newer === "empty") reading = { ...reading, threads: [] };
  if (newer === "removed") reading = { ...reading, threads: [{ ...lead, agentId: "other" }] };
  if (newer === "tasks" || newer === "orientation-returned") events.get("scheduling-changed")!({ ...scheduling, orientation: "tasks" });
  if (newer === "orientation-returned") events.get("scheduling-changed")!({ ...scheduling });
  if (newer === "disconnect" || newer === "reconfirmed") for (const fn of states) fn("closed");
  if (newer === "reconfirmed") events.get("scheduling-changed")!({ ...scheduling });
  if (newer === "disabled") enabled = false;
  if (newer === "reenabled") epoch++;
  resolve({ id: "lead-head" });
  await expect(pending).rejects.toThrow(reason);
});
it("explains a disconnected open rejection instead of silently swallowing it", async () => {
  const feed = await setup();
  let reject!: (reason: Error) => void;
  invoke.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
  const pending = feed.openConfirmedLeadThread("head", feed.token());
  for (const fn of states) fn("closed");
  reject(new Error("Connection closed before the command answered"));
  await expect(pending).rejects.toThrow(/connection/i);
});
it("keeps the latest confirmed orientation when a same-connection reread fails", async () => {
  const feed = await setup();
  const token = feed.token();
  invoke.mockRejectedValueOnce(new Error("Temporary read failure"));
  await feed.refreshScheduling();
  expect(feed.schedulingReading()).toMatchObject({ data: scheduling, fresh: true, error: "Temporary read failure" });
  expect(token?.()).toBe(true);
});
it("retains scheduling display on reconnect but requires a fresh answer before acting", async () => {
  const feed = await setup();
  for (const fn of states) fn("closed");
  expect(feed.schedulingReading()).toMatchObject({ data: scheduling, fresh: false });
  expect(feed.token()).toBeNull();
  let resolve!: (value: unknown) => void;
  invoke.mockReturnValue(new Promise(done => { resolve = done; }));
  for (const fn of states) fn("open");
  expect(feed.token()).toBeNull();
  resolve(scheduling); await Promise.resolve();
  expect(feed.token()).not.toBeNull();
});
