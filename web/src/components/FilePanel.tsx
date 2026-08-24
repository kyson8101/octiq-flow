// A file, docked down the right-hand side: read it, edit it, quote it, save it.
//
// Clicking a file in a reply's list opens this. Markdown renders by default —
// most of what an agent writes is prose — with a raw view a tap away, and any
// other text file opens straight in the editor.
//
// Three rules matter more than the rest:
//
//   · It is NOT a dialog. Reading a file and asking an agent about it is one
//     action, not two, so this is a COLUMN beside the chat rather than a sheet
//     laid over it — the composer stays reachable the whole time it is open.
//     It is the same slot the git and files panels use, and the same stylesheet
//     rules turn it into a sliding sheet on a phone, where two columns do not
//     fit.
//
//   · HIGHLIGHTING is a way to ask about a file. Text you select offers to go
//     into the prompt box with the path and the lines it came from — see
//     lib/quote — which is the whole reason the chat had to stay reachable.
//
//   · A preview that was TRUNCATED cannot be saved. The backend caps how much
//     of a large file it returns, and writing that back would cut the real file
//     down to the part we happened to be shown. So saving is refused outright
//     for those, rather than warned about.
import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { createPortal } from "react-dom";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";
import { useDockWidth, type Sizes } from "../lib/dockWidth";
import { canQuote, lineRange, sendQuote, type Quote } from "../lib/quote";
import { useConfirm } from "./Confirm";
import { FileView } from "./FileView";

type Preview = {
  /** "text" | "image" | "pdf" | "binary" */
  kind: string;
  content: string;
  truncated: boolean;
  size: number;
};

const WIDTH_KEY = "octiq.v2.fileWidth";

/** Wider than the git and files columns, because this one holds prose and code
 *  rather than a list of names. */
const SIZES: Sizes = { initial: 480, min: 320, max: 760 };

/** Where the panel is put in the DOM. Its state lives above the whole app (see
 *  OpenFile) but it has to render as a SIBLING of the views to take width from
 *  them, and those two places are nowhere near each other in the tree. */
const DOCK_ID = "dock";

function isMarkdown(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A highlight, and where on screen to offer it. */
type Pending = { quote: Quote; x: number; y: number };

export function FilePanel({
  path,
  open,
  onClose,
}: {
  path: string;
  /** False while it is sliding away. The parent keeps this mounted until the
   *  slide finishes, so closing looks like the reverse of opening rather than
   *  the panel simply vanishing. */
  open: boolean;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // The file changed underneath us while we had unsaved edits. Reloading would
  // throw that work away, so it becomes a choice rather than something that
  // happens to you.
  const [staleOnDisk, setStaleOnDisk] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  /** Bumped on every read from disk. The editor keeps its document and its undo
   *  history for the life of one mount, so a reload has to give it a new `key`
   *  or it would go on showing text the file no longer holds. */
  const [generation, setGeneration] = useState(0);
  const confirm = useConfirm();
  const { width, startDrag, entered } = useDockWidth(WIDTH_KEY, SIZES);

  const panelRef = useRef<HTMLElement | null>(null);
  const proseRef = useRef<HTMLDivElement | null>(null);
  /** Where the pointer last came up inside the panel, so the quote button can
   *  appear where the selection was made. A drag in a textarea has no rect to
   *  measure — the browser does not expose one — so the pointer is the only
   *  thing that knows. */
  const pointerAt = useRef<{ x: number; y: number } | null>(null);

  const dirty = !!preview && draft !== preview.content;
  // The listener below is registered once per file; these keep it looking at
  // the live values rather than the ones captured when it was created.
  const draftRef = useRef(draft);
  const savedRef = useRef(preview?.content ?? "");
  draftRef.current = draft;
  savedRef.current = preview?.content ?? "";
  const canSave = !!preview && preview.kind === "text" && !preview.truncated && dirty;

  /** Read the file. `keepEditor` is for a reload, where flipping the user out
   *  of the editor they were in would be its own small betrayal. */
  const load = useCallback(
    async (keepEditor: boolean) => {
      try {
        const p = await bridge.invoke<Preview>("read_file_preview", { path });
        setPreview(p);
        setDraft(p.content ?? "");
        setGeneration((n) => n + 1);
        setStaleOnDisk(false);
        setError(null);
        // Card 89 — this flag now means "show markdown as SOURCE", not "show a
        // textarea": anything that is not markdown is drawn in the editor
        // either way, so there is nothing here to decide for it. Markdown opens
        // rendered, which is what it is for.
        if (!keepEditor) setEditing(false);
      } catch (e) {
        setError(String((e as Error).message ?? e));
      }
    },
    [path],
  );

  useEffect(() => {
    setPreview(null);
    setError(null);
    setEditing(false);
    setPending(null);
    void load(false);
  }, [path, load]);

  // Follow the file while it is open. An agent editing it in another chat, a
  // git checkout, a build writing a report — the panel is a window onto the
  // file, so it should show what the file says NOW.
  //
  // The watcher is a single shared one in the backend (file_watch.rs), so
  // pointing it here takes it away from anything else that was watching. The
  // classic UI's preview pane is the only other user, and the two are not open
  // at once.
  useEffect(() => {
    bridge.invoke("file_watch_paths", { paths: [path] }).catch(() => {});
    const off = bridge.on<string[]>("file-changed", (changed) => {
      if (!Array.isArray(changed) || !changed.includes(path)) return;
      // Unsaved work always wins over a background change.
      if (draftRef.current !== savedRef.current) {
        setStaleOnDisk(true);
        return;
      }
      void load(true);
    });
    return () => {
      off();
      bridge.invoke("file_watch_paths", { paths: [] }).catch(() => {});
    };
  }, [path, load]);

  /** What is highlighted right now, if anything, and where to offer it.
   *
   *  Two views, two ways of asking. A textarea knows its selection as character
   *  offsets, which is exactly what a line number is counted from. Rendered
   *  markdown has thrown the offsets away — the text on screen is not the text
   *  in the file — so the selection is looked for in the source instead, and
   *  when it is not found (a table, a heading, anything the renderer reshaped)
   *  the quote names the file and no line, rather than a line it guessed. */
  const readSelection = useCallback(() => {
    const live = window.getSelection();
    if (!live || live.isCollapsed || live.rangeCount === 0) return setPending(null);
    const range = live.getRangeAt(0);
    const host = proseRef.current;
    if (!host || !host.contains(range.commonAncestorContainer)) return setPending(null);
    const text = live.toString();
    if (!text.trim()) return setPending(null);
    const at = draftRef.current.indexOf(text);
    const lines = at >= 0 ? lineRange(draftRef.current, at, at + text.length) : { from: 0, to: 0 };
    const rect = range.getBoundingClientRect();
    setPending({
      quote: { path, text, ...lines },
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  }, [path]);

  // Watched rather than polled off mouse-up alone, so the button also goes away
  // when the selection does — clicking elsewhere, typing, or dragging it down
  // to nothing.
  useEffect(() => {
    const onChange = () => {
      // Let the browser finish settling the selection before reading it: on a
      // double-click the event arrives while it is still the old one.
      requestAnimationFrame(readSelection);
    };
    document.addEventListener("selectionchange", onChange);
    return () => document.removeEventListener("selectionchange", onChange);
  }, [readSelection]);

  /** A highlight made in the EDITOR, reported by the editor itself.
   *
   *  It used to be read off a `<textarea>`'s `selectionStart`. CodeMirror has no
   *  textarea to ask, and finding the text in the document with `indexOf` would
   *  be near enough most of the time and wrong exactly when it matters — a short
   *  snippet appearing twice would be quoted against the first line it happened
   *  to match. So the editor says, because it is the only thing that knows. */
  const onEditorSelect = useCallback(
    (sel: { from: number; to: number; text: string }) => {
      if (!sel.text.trim()) return setPending(null);
      const doc = draftRef.current;
      const at = pointerAt.current ?? centerOf(panelRef.current);
      setPending({
        quote: { path, text: sel.text, ...lineRange(doc, sel.from, sel.to) },
        ...at,
      });
    },
    [path],
  );

  /** Put the highlight in the prompt box. */
  const quote = useCallback(() => {
    if (!pending) return;
    sendQuote(pending.quote);
    setPending(null);
  }, [pending]);

  // Escape closes and Cmd+S saves — but ONLY while this panel has the focus.
  // It is a column beside a live chat now, not a sheet over a dead one, and a
  // panel that eats Escape from the prompt box is a panel that closes itself
  // every time someone dismisses an autocomplete.
  useEffect(() => {
    const mine = () => {
      const el = document.activeElement;
      return !el || el === document.body || !!panelRef.current?.contains(el);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!mine()) return;
      if (e.key === "Escape") {
        // The button first: it is the newer thing on screen, so it is the one
        // Escape is aimed at.
        if (pending) return setPending(null);
        if (!dirty) onClose();
      }
      if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function save() {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      await bridge.invoke("write_file", { path, content: draft });
      setPreview((p) => (p ? { ...p, content: draft } : p));
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (e) {
      // Usually "outside the project folders": write_file only accepts paths
      // under a project's own roots, which is what stops a chat editing
      // anything on the machine.
      setError(String((e as Error).message ?? e));
    } finally {
      setSaving(false);
    }
  }

  async function requestClose() {
    if (dirty) {
      const ok = await confirm({
        title: "Close without saving?",
        body: `Your changes to ${baseName(path)} will be lost.`,
        confirmLabel: "Discard changes",
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  }

  const host = typeof document === "undefined" ? null : document.getElementById(DOCK_ID);
  if (!host) return null;

  // Into the row of views, not inside the message it was opened from — it has
  // to be their sibling to take width from them, and nothing in a reply is.
  return (
    <>
      {createPortal(
        <>
          {/* Only ever seen on a phone, where the panel is a sheet over the chat
              rather than a column beside it. On a wide screen the stylesheet
              takes it away: there is nothing underneath to dim. */}
          <div
            className={`fpanel-scrim ${entered && open ? "is-open" : ""}`}
            onClick={() => void requestClose()}
            aria-hidden="true"
          />
          <aside
            ref={panelRef}
            className={`fpanel ${entered && open ? "is-open" : ""}`}
            aria-label={baseName(path)}
            // A custom property, not `width`: the phone rule in styles.css has to
            // be able to drop the column width, and an inline `width` would outrank
            // it.
            style={{ "--gitp-w": `${width}px` } as React.CSSProperties}
            onPointerUp={(e) => {
              pointerAt.current = { x: e.clientX, y: e.clientY };
              // Read it again now the drag has ENDED. A textarea reports its
              // selection while the pointer is still moving, so the button
              // would otherwise be placed where the last drag finished rather
              // than this one.
              readSelection();
            }}
          >
            <div
              className="gitp-resizer"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the file panel"
              onPointerDown={startDrag}
            />

            <header className="panel-head">
              <div className="panel-id">
                <div className="panel-name">
                  {baseName(path)}
                  {dirty && <span className="panel-dirty" title="Unsaved changes" />}
                </div>
                <div className="panel-path">
                  <bdi>{path}</bdi>
                </div>
              </div>

              {preview?.kind === "text" && isMarkdown(path) && (
                <button className="panel-btn" type="button" onClick={() => setEditing((v) => !v)}>
                  {editing ? "Preview" : "Edit"}
                </button>
              )}
              {preview?.kind === "text" && !preview.truncated && (
                <button
                  className="panel-btn is-primary"
                  type="button"
                  onClick={save}
                  disabled={!canSave || saving}
                >
                  {saving ? "Saving…" : saved ? "Saved" : "Save"}
                </button>
              )}
              <button
                className="panel-close"
                type="button"
                onClick={() => void requestClose()}
                aria-label="Close"
              >
                ✕
              </button>
            </header>

            {error && <div className="panel-error">{error}</div>}

            {staleOnDisk && (
              <div className="panel-warn is-stale">
                This file changed on disk while you were editing it.
                <button className="panel-inline-btn" type="button" onClick={() => void load(true)}>
                  Reload and lose my changes
                </button>
              </div>
            )}

            {preview?.truncated && (
              <div className="panel-warn">
                Showing the first {humanSize(preview.content.length)} of {humanSize(preview.size)}.
                Saving is off for this file — writing back what is on screen would cut the rest away.
              </div>
            )}

            <div className="panel-body">
              {!preview && !error && <div className="dots" aria-label="loading" />}

              {/* Card 89 — the same body the editor mode draws, which is how
                  this finally gets syntax colouring, search and an undo
                  history. It had a bare textarea until now, and nobody had
                  decided that: it is what two implementations of one thing
                  drift into. */}
              {preview && (
                <FileView
                  path={path}
                  preview={preview}
                  draft={draft}
                  raw={editing}
                  generation={generation}
                  onDraft={setDraft}
                  onSave={() => void save()}
                  onSelect={onEditorSelect}
                  onProseRef={(el: HTMLDivElement | null) => {
                    proseRef.current = el;
                  }}
                />
              )}

            </div>
          </aside>
        </>,
        host,
      )}

      {/* On the page, not in the dock: the button is placed in VIEWPORT
          coordinates, so it must not sit inside anything that could clip or
          re-anchor it. Offered rather than done, too — a stray drag across a
          paragraph should not put a paragraph in the prompt box. */}
      {pending &&
        canQuote() &&
        createPortal(
          <button
            className="quote-btn"
            type="button"
            style={{ left: `${pending.x}px`, top: `${pending.y}px` }}
            // The pointer coming DOWN on it would clear the selection first, and
            // there would be nothing left to quote by the time the click landed.
            onMouseDown={(e) => e.preventDefault()}
            onClick={quote}
          >
            <span className="quote-btn-plus" aria-hidden="true">
              +
            </span>
            Add to chat
            {pending.quote.from > 0 && (
              <span className="quote-btn-at">
                {pending.quote.to > pending.quote.from
                  ? `${pending.quote.from}–${pending.quote.to}`
                  : pending.quote.from}
              </span>
            )}
          </button>,
          document.body,
        )}
    </>
  );
}

/** A point near the top of an element, for a selection that has no rect of its
 *  own to sit by. */
/** Where to put the quote button when the pointer did not say.
 *
 *  Null-tolerant: the panel element is a ref, and a selection can in principle
 *  be reported in the frame before it is attached. A guessed corner is better
 *  than a crash, and the pointer position is the usual answer anyway. */
function centerOf(el: HTMLElement | null): { x: number; y: number } {
  if (!el) return { x: 24, y: 80 };
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + 40 };
}
