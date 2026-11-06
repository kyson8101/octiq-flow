import { afterEach, beforeEach, expect, it, vi } from "vitest";
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: Array<{ id: number; cmd: string; args: Record<string, unknown> }> = [];
  handlers = new Map<string, Array<(e: unknown) => void>>();
  constructor() { Socket.instances.push(this); }
  addEventListener(name: string, fn: (e: unknown) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  emit(name: string, e: unknown = {}) { for (const fn of this.handlers.get(name) ?? []) fn(e); }
  open() { this.readyState = 1; this.emit("open"); }
  close() { this.readyState = 3; this.emit("close"); }
  reply(index: number, error?: string) { this.emit("message", { data: JSON.stringify({ t: "reply", id: this.sent[index].id, ok: !error, result: { chatKeys: [] }, error }) }); }
}
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { href: "http://fixture/", host: "fixture", port: "", protocol: "http:" });
  vi.stubGlobal("localStorage", { getItem: () => "fixture-token" });
  vi.stubGlobal("fetch", async () => ({ status: 200 }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
it("subscribes first, replaces panes, waits for latest ack, and resubscribes first on reconnect", async () => {
  const { bridge } = await import("./bridge");
  const queued = bridge.invoke("queued"); queued.catch(() => {});
  void bridge.watchChats(["chat:b", "chat:a", "chat:a"]);
  const first = Socket.instances[0]; first.open();
  expect(first.sent.map(f => f.cmd)).toEqual(["chat_subscribe", "queued"]);
  expect(first.sent[0].args).toEqual({ chatKeys: ["chat:a", "chat:b"] });
  let caught = false; const ready = bridge.chatsReady().then(() => { caught = true; });
  const change = bridge.watchChats(["chat:b"]);
  first.reply(0); await vi.advanceTimersByTimeAsync(0); expect(caught).toBe(false);
  first.reply(2); await change; await ready; expect(caught).toBe(true);
  await bridge.watchChats(["chat:b"]); expect(first.sent).toHaveLength(3);
  first.close(); await vi.advanceTimersByTimeAsync(600);
  const second = Socket.instances[1]; second.open();
  expect(second.sent[0]).toMatchObject({ cmd: "chat_subscribe", args: { chatKeys: ["chat:b"] } });
  second.reply(0); await bridge.chatsReady();
});
it("opts into an empty screen, and only explicit unavailability uses legacy streaming", async () => {
  const { bridge } = await import("./bridge"); const socket = Socket.instances[0]; socket.open();
  expect(socket.sent[0].args).toEqual({ chatKeys: [] });
  socket.reply(0, "'chat_subscribe' is not available on this backend");
  await bridge.chatsReady(); expect(bridge.scopedChats).toBe(false);
  await bridge.watchChats(["chat:a"]); expect(socket.sent).toHaveLength(1);
});
it("a subscription failure never starts transcript catch-up as if acknowledged", async () => {
  const { bridge } = await import("./bridge"); const socket = Socket.instances[0]; socket.open();
  socket.reply(0, "could not read profile");
  await expect(bridge.chatsReady()).rejects.toThrow("could not read profile");
  expect(bridge.scopedChats).toBe(true);
});
