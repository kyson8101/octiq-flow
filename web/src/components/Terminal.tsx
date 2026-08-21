// A real shell, under the chat.
//
// Chat is for asking an agent to do something. This is for the times you just
// want to run the thing yourself — a test, a build, a git status — without
// leaving the project you are already in. It opens in that project's folder.
//
// The PTY lives on the server, exactly as it does for the desktop app: bytes
// you type go down `pty_write`, and its output arrives as `pty-output` events
// on the same socket the chat already uses. Nothing about this is browser-only;
// it is the same terminal, seen from somewhere else.
import { useCallback, useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { bridge } from "../lib/bridge";

/** Matches the app's own palette, so a shell does not look pasted in. */
const THEME = {
  background: "#1c1c1e",
  foreground: "#d8d8dc",
  cursor: "#f5f5f7",
  selectionBackground: "rgba(10, 132, 255, 0.35)",
  black: "#3a3a3c",
  red: "#ff453a",
  green: "#30d158",
  yellow: "#ff9f0a",
  blue: "#0a84ff",
  magenta: "#bf5af2",
  cyan: "#64d2ff",
  white: "#d8d8dc",
  brightBlack: "#636366",
  brightRed: "#ff6961",
  brightGreen: "#5de37d",
  brightYellow: "#ffd426",
  brightBlue: "#4da3ff",
  brightMagenta: "#da8fff",
  brightCyan: "#8be9ff",
  brightWhite: "#f5f5f7",
};

export function TerminalPane({ id, cwd }: { id: string; cwd: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  /** Tell the PTY the new size, so programs that care about width reflow. */
  const sendSize = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    bridge
      .invoke("pty_resize", { id, rows: term.rows, cols: term.cols })
      .catch(() => {});
  }, [id]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      theme: THEME,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.3,
      cursorBlink: true,
      // Enough to scroll back through a build, not enough to eat memory on a
      // phone that leaves this open all day.
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    // WebGL for the same reason the desktop app uses it: the DOM renderer
    // leaves ghosted glyphs behind after a reflow. If the context is refused
    // (or lost later) the addon disposes itself and xterm falls back on its
    // own, so this is an upgrade attempt rather than a requirement.
    try {
      term.loadAddon(new WebglAddon());
    } catch {
      /* no WebGL here — the canvas renderer is fine */
    }

    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    // Keystrokes go to the shell. xterm gives us the bytes already encoded the
    // way a terminal expects, escape sequences and all, so this is a pipe and
    // not an interpreter.
    const typed = term.onData((data) => {
      bridge.invoke("pty_write", { id, data }).catch(() => {});
    });

    // The shell is OLDER than this pane. A dev server started an hour ago is
    // still printing into a PTY whose xterm was thrown away and built again —
    // by closing the drawer, switching tab or project, or reloading the page.
    // So the backend replays what the terminal has already printed, and until
    // that lands the live stream is held back.
    //
    // Dropped, not queued: the backend emits the restore while holding the same
    // lock the output stream takes (`pty_attach` in pty.rs), so anything
    // arriving before it is already inside the block about to arrive.
    let restored = false;

    // Output comes back on the shared event stream, addressed by id.
    const off = bridge.on<{ id: string; chunk: string }>("pty-output", (payload) => {
      if (payload?.id === id && restored) term.write(payload.chunk);
    });

    // The replay. It is a broadcast, so a SECOND browser attaching to this same
    // terminal sends one of these too — ignored here, because this pane is no
    // longer waiting for one and its screen is already right.
    const offRestore = bridge.on<{ id: string; data: string; trimmed: boolean }>(
      "pty-restore",
      (payload) => {
        if (payload?.id !== id || restored) return;
        if (payload.trimmed) {
          term.write("\r\n\x1b[2m[octiq: output trimmed]\x1b[0m\r\n");
        }
        if (payload.data) term.write(payload.data);
        restored = true;
      },
    );

    // Start the shell only once the size is known, so its first prompt is drawn
    // at the right width rather than at xterm's 80x24 default. `pty_spawn` is
    // idempotent by id, so on a re-attach this finds the running shell rather
    // than starting a second one.
    bridge
      .invoke("pty_spawn", { id, cwd })
      .then(() => {
        sendSize();
        // A backend older than this client does not have `pty_attach` and
        // rejects. Go live rather than sit here dropping every byte — the two
        // halves deploy separately, so this pairing really happens.
        return bridge.invoke("pty_attach", { id }).catch(() => {
          restored = true;
        });
      })
      .catch((e: Error) => {
        restored = true;
        term.writeln(`\r\n\x1b[31mCould not start a shell: ${e.message}\x1b[0m`);
      });

    const onResize = () => {
      fit.fit();
      sendSize();
    };
    window.addEventListener("resize", onResize);
    // The pane itself can change size without the window doing so — the drawer
    // being dragged, the sidebar opening.
    const observer = new ResizeObserver(onResize);
    observer.observe(host);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      typed.dispose();
      off();
      offRestore();
      term.dispose();
      termRef.current = null;
      // The shell is NOT killed here. Closing the drawer, or switching project,
      // should leave a running build running — it is reattached by id when the
      // pane comes back.
    };
  }, [id, cwd, sendSize]);

  return <div className="term" ref={hostRef} />;
}
