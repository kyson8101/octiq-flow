// Small helpers shared across the frontend modules (card 26).
//
// Each of these existed two or three times, and the copies had DRIFTED — two
// byte formatters rounded differently, two `timeAgo`s disagreed about a zero
// timestamp, two `baseName`s disagreed about Windows separators. One definition
// each, and the divergences resolved in favour of the more careful version.
//
// Add something here only when a second module genuinely needs it. A helper with
// one caller belongs next to that caller.

/**
 * POSIX single-quote a value so a path, branch name, or commit message with
 * spaces or shell metacharacters is passed as ONE argument.
 *
 * Inside single quotes everything is literal, so the only escape needed is for
 * an embedded single quote: end the quote, add an escaped quote, reopen. This is
 * what stops a folder named `foo'; rm -rf ~` from breaking out of its argument.
 * The commands run in the login shell of a PTY, so POSIX is the target.
 */
export function shQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * Human-readable file size, e.g. "812 B", "1.2 KB", "3.4 MB".
 *
 * One decimal place from KB up. The old `fmtSize` (canvas, vault) rounded KB to
 * a whole number while `humanSize` (browser) showed a decimal, so the same file
 * read as "12 KB" in one pane and "12.3 KB" in another. The decimal wins: it is
 * the more useful number and it matches what the file browser already showed.
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * Short "12s ago" / "3m ago" / "5h ago" / "2d ago" label from an epoch-ms
 * timestamp. A missing or zero timestamp yields "" rather than "56y ago", which
 * is what the unguarded copy in vault.js produced for an unknown time.
 */
export function timeAgo(ms) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * Last path segment of a path, used as a short label. Handles both `/` and `\`
 * separators and trailing slashes; the workspaces.js copy handled neither, so a
 * Windows-style path there rendered whole instead of as its file name.
 */
export function baseName(path) {
  const trimmed = String(path || "").replace(/[/\\]+$/, "");
  const parts = trimmed.split(/[/\\]/);
  return parts[parts.length - 1] || path || "";
}

/**
 * Build an element whose text is set with `textContent`, never `innerHTML`.
 * The point is the safety: user file names, branch names, and diff lines all go
 * through here, so none of them can inject markup.
 */
export function textEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

/**
 * Wire a drag handle that resizes a pane whose RIGHT edge is fixed, persisting
 * the width to localStorage under `storageKey` (card 26).
 *
 * Used by the canvas and file-browser panes, which had the same 30 lines each.
 * The web-preview pane is deliberately NOT a caller: it docks to any of four
 * edges, resizes along two axes via `flex-basis`, clamps at a different fraction,
 * and persists through its own state object. Folding it in would need dock, axis,
 * clamp and persist parameters — an abstraction larger than the duplication it
 * removes.
 *
 * Returns nothing; the handle is live from the call.
 *
 * @param paneEl      the element being resized
 * @param resizerEl   the drag handle
 * @param storageKey  localStorage key holding the width in px
 * @param minWidth    smallest allowed width, px
 * @param maxFraction largest allowed width as a fraction of the window
 * @param onResize    optional callback after a drag ends (e.g. refit terminals)
 */
export function makeResizer({
  paneEl,
  resizerEl,
  storageKey,
  minWidth,
  maxFraction = 0.72,
  onResize = null,
}) {
  if (!paneEl || !resizerEl) return;
  resizerEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    // The pane's right edge does not move during the drag, so measure it once
    // and take the width as (that edge − pointer x) on every move.
    const rightEdge = paneEl.getBoundingClientRect().right;
    resizerEl.setPointerCapture(e.pointerId);
    resizerEl.classList.add("dragging");
    let width = loadPaneWidth(storageKey, minWidth, paneEl.offsetWidth, maxFraction);

    const onMove = (ev) => {
      const max = Math.floor(window.innerWidth * maxFraction);
      width = Math.max(minWidth, Math.min(rightEdge - ev.clientX, max));
      paneEl.style.width = `${width}px`;
    };
    const onUp = () => {
      resizerEl.classList.remove("dragging");
      resizerEl.removeEventListener("pointermove", onMove);
      resizerEl.removeEventListener("pointerup", onUp);
      localStorage.setItem(storageKey, String(width));
      onResize?.(width);
    };
    resizerEl.addEventListener("pointermove", onMove);
    resizerEl.addEventListener("pointerup", onUp);
  });
}

/**
 * The saved pane width, clamped to [minWidth, maxFraction of the window].
 * A missing, corrupt, or too-small saved value falls back to `fallback`.
 */
export function loadPaneWidth(storageKey, minWidth, fallback, maxFraction = 0.72) {
  const max = Math.floor(window.innerWidth * maxFraction);
  const n = Number(localStorage.getItem(storageKey));
  if (!Number.isFinite(n) || n < minWidth) return Math.min(fallback, max);
  return Math.min(n, max);
}
