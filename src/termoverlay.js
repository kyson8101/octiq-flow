// Command-block overlay (spike) — a UI layer drawn ON TOP of a terminal.
//
// xterm keeps rendering the real output. This module only adds DOM above the
// grid, anchored to lines the shell marked with OSC 133 — the FinalTerm /
// iTerm2 "semantic prompt" codes that Warp, WezTerm and Ghostty all build on:
//
//   OSC 133 ; A          ST   a prompt starts on this line
//   OSC 133 ; B          ST   the prompt ends, the user's typing starts
//   OSC 133 ; C          ST   Enter was pressed — command OUTPUT starts here
//   OSC 133 ; D ; <code> ST   the command finished with this exit code
//
// Those marks are the whole trick. Without them the PTY stream is cursor moves
// and repaints, so an overlay has nothing to attach to; with them each command
// becomes a block we can tint, label, and later collapse or re-run.
//
// The marks are parsed by XTERM, not on the `pty-output` hot path in
// terminals.js: a registered OSC handler fires while xterm walks a chunk it is
// already walking, so a terminal whose shell emits no marks costs nothing.
//
// Try it by hand in any terminal (no shell integration needed yet):
//   printf '\e]133;C\a'; ls;      printf '\e]133;D;0\a'
//   printf '\e]133;C\a'; ls /nope; printf '\e]133;D;1\a'

const OSC_SEMANTIC_PROMPT = 133;

// How many finished blocks keep a decoration. Old blocks scroll out of the
// buffer and xterm disposes their markers for us, but a terminal with a huge
// scrollback would otherwise hold thousands of live decorations. Oldest goes
// first.
const MAX_BLOCKS = 40;

/**
 * Draw an overlay block around every OSC 133 marked command in this terminal.
 * Safe to call on a terminal that is not open yet — nothing is created until
 * the first mark arrives.
 */
export function attachBlockOverlay(term) {
  // Finished blocks, oldest first. Each is { marker, decoration }.
  const blocks = [];
  // The block currently being written, or null between commands.
  let open = null;

  /** Enter was pressed: pin the line where this command's output begins. */
  function startBlock() {
    // A previous block that never reported its exit code (Ctrl-C at the wrong
    // moment, a shell that emits C without D) is abandoned, not drawn — a band
    // with no known outcome would be a lie.
    open?.marker.dispose();
    // No offset: at C time the cursor sits on the first output line.
    const marker = term.registerMarker();
    open = marker ? { marker } : null;
  }

  /** The command finished: draw the band over the lines it produced. */
  function endBlock(exitArg) {
    if (!open) return;
    const { marker } = open;
    open = null;
    if (marker.isDisposed) return;

    // The cursor is now on the line AFTER the output, so the difference is the
    // line count. A command that printed nothing (`cd`) gives 0 — clamp to 1 so
    // the block is still visible as a thin band.
    const buf = term.buffer.active;
    const height = Math.max(1, buf.baseY + buf.cursorY - marker.line);
    const code = Number.parseInt(exitArg ?? "", 10);
    const ok = !Number.isFinite(code) || code === 0;

    // layer "top" on purpose: a "bottom" decoration renders BEHIND the WebGL
    // canvas, which paints an opaque background, so the band would be invisible
    // on exactly the renderer this app uses. Drawn on top with a low-alpha fill
    // instead, so the text still reads through it.
    const decoration = term.registerDecoration({
      marker,
      x: 0,
      width: term.cols,
      height,
      layer: "top",
    });
    if (!decoration) {
      marker.dispose();
      return;
    }

    // onRender fires on every repaint, and xterm may hand back a fresh element
    // after a resize — so the guard is per element, not per decoration.
    decoration.onRender((el) => {
      el.className = `octiq-blk ${ok ? "is-ok" : "is-err"}`;
      if (el.dataset.octiqBlk) return;
      el.dataset.octiqBlk = "1";
      const pill = document.createElement("span");
      pill.className = "octiq-blk-pill";
      pill.textContent = ok ? "done" : `exit ${code}`;
      el.append(pill);
    });

    blocks.push({ marker, decoration });
    while (blocks.length > MAX_BLOCKS) {
      const old = blocks.shift();
      old.decoration.dispose();
      old.marker.dispose();
    }
  }

  term.parser.registerOscHandler(OSC_SEMANTIC_PROMPT, (data) => {
    const [kind, arg] = String(data).split(";");
    if (kind === "C") startBlock();
    else if (kind === "D") endBlock(arg);
    // A and B are consumed but unused for now: this spike marks output blocks,
    // not prompt lines. Returning true either way stops xterm passing an
    // unhandled sequence on to nothing.
    return true;
  });
}
