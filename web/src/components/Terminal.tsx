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
import { THEME_EVENT } from "../lib/themeStore";
import { xtermTheme } from "../lib/xtermTheme";

export function TerminalPane({
  id,
  cwd,
  cmd,
  env,
}: {
  id: string;
  cwd: string;
  /** For a tab opened from one of the project's saved commands: the command to
   *  run in it. Passed on every mount, not only the first — `pty_spawn` is
   *  idempotent by id, so a shell that is already running is left alone and
   *  only a genuinely new one (the server restarted) starts it again. */
  cmd?: string;
  /** The project's environment, set on the shell — passed on every mount for
   *  the same reason `cmd` is. */
  env?: Record<string, string>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Xterm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Read from a ref, not the effect's own deps: a project reload gives `env` a
  // new object identity every time even when its contents are unchanged, and
  // this pane must not be torn down and rebuilt — with it, the shell — over
  // that.
  const envRef = useRef(env);
  envRef.current = env;

  /** Tell the PTY the new size, so programs that care about width reflow. */
  const sendSize = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    bridge
      .invoke("pty_resize", { id, rows: term.rows, cols: term.cols })
      .catch(() => {});
  }, [id]);

  // A theme change repaints the terminal in place. It deliberately does not
  // live in the effect below — that one owns the shell, and re-running it to
  // change a colour would throw away the scrollback.
  useEffect(() => {
    const repaint = () => {
      if (termRef.current) termRef.current.options.theme = xtermTheme();
    };
    window.addEventListener(THEME_EVENT, repaint);
    return () => window.removeEventListener(THEME_EVENT, repaint);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      theme: xtermTheme(),
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
      .invoke("pty_spawn", { id, cwd, startCmd: cmd, env: envRef.current })
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
  }, [id, cwd, cmd, sendSize]);

  return <div className="term" ref={hostRef} />;
}
