// The connection to the OctiqFlow backend.
//
// v2 is web-first: it always talks to the Rust app over the same WebSocket the
// vanilla client uses (src-tauri/src/web.rs), whether it is being served BY
// that app or by the Vite dev server on another port. There is no Tauri IPC
// path here on purpose — one transport means one thing to reason about, and it
// is the one that works from a phone.
//
//   invoke(cmd, args)  ->  { t: "invoke", id, cmd, args }  ->  reply
//   on(event, fn)      <-  { t: "event", event, payload }
//
// Calls made before the socket opens are queued, so nothing has to wait for a
// connection before asking for data.

type Reply = { t: "reply"; id: number; ok: boolean; result?: unknown; error?: string };
type EventFrame = { t: "event"; event: string; payload: unknown };
type Frame = Reply | EventFrame;

export type ConnectionState = "connecting" | "open" | "closed";

const TOKEN_KEY = "octiq.web.token";

/** Where the backend lives.
 *
 *  Served by the Rust app -> the page's own host. Vite dev server -> the
 *  backend is elsewhere, so `VITE_OCTIQ_SERVER` names it (default: the port
 *  web.rs listens on). */
function serverHost(): string {
  const configured = import.meta.env.VITE_OCTIQ_SERVER as string | undefined;
  if (configured) return configured;
  // The dev server runs on 5273 (vite.config.ts); anything else is the backend
  // serving this page itself.
  if (location.port === "5273") return "127.0.0.1:1421";
  return location.host;
}

/** The token that opens the socket. It arrives once as `?token=…`, is kept for
 *  later visits, and is taken out of the address bar so it does not sit in
 *  history or a screenshot. */
function readToken(): string {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get("token");
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_KEY, fromUrl);
    } catch {
      /* private mode: the token then lasts for this page only */
    }
    url.searchParams.delete("token");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    return fromUrl;
  }
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

class Bridge {
  private socket: WebSocket | null = null;
  private seq = 1;
  private pending = new Map<number, { resolve: (v: never) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<(payload: never) => void>>();
  private queue: string[] = [];
  private retry = 0;
  private stateFns = new Set<(s: ConnectionState) => void>();

  state: ConnectionState = "connecting";

  constructor() {
    this.connect();
  }

  private setState(s: ConnectionState) {
    this.state = s;
    for (const fn of this.stateFns) fn(s);
  }

  private connect() {
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const url = `${scheme}://${serverHost()}/ws?token=${encodeURIComponent(readToken())}`;
    this.setState("connecting");
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.retry = 0;
      this.setState("open");
      const waiting = this.queue;
      this.queue = [];
      for (const frame of waiting) socket.send(frame);
    });

    socket.addEventListener("message", (ev) => {
      let frame: Frame;
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (frame.t === "reply") {
        const waiting = this.pending.get(frame.id);
        if (!waiting) return;
        this.pending.delete(frame.id);
        if (frame.ok) waiting.resolve(frame.result as never);
        else waiting.reject(new Error(frame.error ?? "command failed"));
        return;
      }
      if (frame.t === "event") {
        const set = this.listeners.get(frame.event);
        if (!set) return;
        for (const fn of [...set]) {
          try {
            fn(frame.payload as never);
          } catch (err) {
            console.error("[octiq] listener failed", frame.event, err);
          }
        }
      }
    });

    socket.addEventListener("close", () => {
      this.setState("closed");
      // The sessions live on the server, so a dropped socket costs the VIEW and
      // nothing else. Back off to a few seconds so a sleeping phone does not
      // hammer the machine.
      this.retry = Math.min(this.retry + 1, 6);
      setTimeout(() => this.connect(), Math.min(500 * 2 ** (this.retry - 1), 8000));
    });

    socket.addEventListener("error", () => socket.close());
  }

  private send(frame: unknown) {
    const text = JSON.stringify(frame);
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(text);
    else this.queue.push(text);
  }

  /** Run a backend command. Every one of the app's commands is reachable. */
  invoke<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.seq++;
      this.pending.set(id, {
        resolve: resolve as (v: never) => void,
        reject,
      });
      this.send({ t: "invoke", id, cmd, args });
    });
  }

  /** Subscribe to a backend event. Returns an unsubscribe function. */
  on<T = unknown>(event: string, fn: (payload: T) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn as (p: never) => void);
    return () => set!.delete(fn as (p: never) => void);
  }

  /** Watch the connection, for the "reconnecting…" strip. */
  onState(fn: (s: ConnectionState) => void): () => void {
    this.stateFns.add(fn);
    fn(this.state);
    return () => this.stateFns.delete(fn);
  }
}

export const bridge = new Bridge();
