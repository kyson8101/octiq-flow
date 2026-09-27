// How a browser gets in, now that `/token` hands the token only to a
// Cloudflare Access sign-in: a browser with no token, or a stale one, must
// land on the Connect page once and stay there — no silent retry loop — while
// a stored token, a dropped network and a pasted token behave as before.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  constructor(readonly url: string) { super(); Socket.instances.push(this); }
  send() {}
  open() { this.readyState = 1; this.dispatchEvent(new Event("open")); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

type Answer = { status: number; body?: string } | "unreachable";
let answers: Record<string, Answer>;
let stored: string | null;
const fetched: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  Socket.instances = [];
  fetched.length = 0;
  stored = null;
  answers = { "/token": { status: 403 }, "/auth": { status: 401 } };
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", new URL("http://localhost:1421/"));
  vi.stubGlobal("history", { replaceState: () => {} });
  vi.stubGlobal("localStorage", {
    getItem: () => stored,
    setItem: (_key: string, value: string) => { stored = value; },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    fetched.push(path);
    const answer = answers[path];
    if (!answer || answer === "unreachable") throw new TypeError("network down");
    return { ok: answer.status < 300, status: answer.status, text: async () => answer.body ?? "" };
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function settle() {
  await vi.advanceTimersByTimeAsync(20_000);
}

it("a new browser with no token goes straight to Connect, without opening a socket or looping", async () => {
  const { bridge } = await import("./bridge");
  await settle();
  expect(bridge.state).toBe("unauthorized");
  expect(Socket.instances).toHaveLength(0);
  expect(fetched).toEqual(["/token"]);
});

it("a stale stored token reaches Connect once and stops there", async () => {
  stored = "old-token";
  const { bridge } = await import("./bridge");
  Socket.instances[0].close();
  await settle();
  expect(bridge.state).toBe("unauthorized");
  expect(Socket.instances).toHaveLength(1);
  expect(fetched).toEqual(["/auth", "/token"]);
});

it("a stored token reconnects after a dropped network, as before", async () => {
  stored = "good-token";
  answers["/auth"] = "unreachable";
  const { bridge } = await import("./bridge");
  Socket.instances[0].close();
  await vi.advanceTimersByTimeAsync(600);
  expect(bridge.state).toBe("connecting");
  expect(Socket.instances).toHaveLength(2);
  expect(Socket.instances[1].url).toContain("token=good-token");
  Socket.instances[1].open();
  expect(bridge.state).toBe("open");
});

it("an unreachable server with no token keeps trying rather than asking for one", async () => {
  answers["/token"] = "unreachable";
  const { bridge } = await import("./bridge");
  await vi.advanceTimersByTimeAsync(0);
  expect(bridge.state).toBe("connecting");
  expect(Socket.instances).toHaveLength(1);
});

it("a browser Cloudflare Access signed in is handed the token and connects with it", async () => {
  answers["/token"] = { status: 200, body: "access-issued\n" };
  const { bridge } = await import("./bridge");
  await vi.advanceTimersByTimeAsync(0);
  expect(Socket.instances).toHaveLength(1);
  expect(Socket.instances[0].url).toContain("token=access-issued");
  expect(stored).toBe("access-issued");
  Socket.instances[0].open();
  expect(bridge.state).toBe("open");
});

it("the token pasted on Connect is kept and used", async () => {
  const { bridge } = await import("./bridge");
  await settle();
  expect(bridge.state).toBe("unauthorized");
  bridge.useToken("  pasted-token ");
  expect(stored).toBe("pasted-token");
  expect(Socket.instances.at(-1)!.url).toContain("token=pasted-token");
  Socket.instances.at(-1)!.open();
  expect(bridge.state).toBe("open");
});
