import { afterEach, beforeEach, expect, it, vi } from "vitest";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  frames: string[] = [];
  constructor(_url: string) { super(); Socket.instances.push(this); }
  send(frame: string) { this.frames.push(frame); }
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
  reply(result: unknown) {
    const { id } = JSON.parse(this.frames.at(-1)!);
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ t: "reply", id, ok: true, result }) }));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", new URL("http://localhost:1421/"));
  vi.stubGlobal("localStorage", { getItem: () => "test-token" });
  vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200 })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("rejects an interrupted read so a reconnect can load the same chat again", async () => {
  const { bridge } = await import("./bridge");
  const socket = Socket.instances[0];
  socket.open();
  const read = bridge.invoke("chat_since", { key: "chat:a", after: 0 });
  const rejected = expect(read).rejects.toThrow("Connection closed");
  socket.close();
  await rejected;
  await vi.advanceTimersByTimeAsync(500);
  const next = Socket.instances[1];
  next.open();
  const retried = bridge.invoke("chat_since", { key: "chat:a", after: 0 });
  next.reply(["history"]);
  await expect(retried).resolves.toEqual(["history"]);
});

it("keeps an offline request queued until a socket opens", async () => {
  const { bridge } = await import("./bridge");
  const read = bridge.invoke("chat_since", { key: "chat:a", after: 0 });
  Socket.instances[0].close();
  await vi.advanceTimersByTimeAsync(500);
  const socket = Socket.instances[1];
  socket.open();
  expect(socket.frames).toHaveLength(1);
  socket.reply([]);
  await expect(read).resolves.toEqual([]);
});
