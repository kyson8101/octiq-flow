// Every file the session has touched, in one column.
//
// This replaces the list that used to sit under each reply. That list was a
// footnote to ONE turn, and it had two problems a footnote cannot fix:
//
//   * **It blinked.** The footer under a reply only draws when nothing is
//     streaming, and a turn stops and restarts on every tool call — so it
//     flashed off and on all turn, most visibly around a permission dialog,
//     where the pause is long enough to watch it happen.
//   * **It answered the wrong question.** "What did that reply touch" is rarely
//     what you want. "Where is the file we were looking at an hour ago" is, and
//     no per-reply list can answer it without scrolling back to find the reply.
//
// So the list is the whole session's, and it lives in a column beside the chat
// — the same column the git panel uses, with the same phone behaviour (a sheet
// that slides in, because two columns do not fit in 390px).
//
// Where the paths come from is unchanged: `candidatePaths` collects every
// path-ish string from the transcript, and the backend's `resolve_paths` throws
// away the ones that do not exist. What IS new is the cache. Every candidate is
// asked about once and the answer is kept, so a re-scan can never blank the
// list, and a session that mentions the same file in thirty turns costs one
// existence check, not thirty.
//
// A long session names more files than a column can be read: the list is
// capped at the newest 25, which is far enough back to cover what a chat is
// still about. Those 25 are then drawn A→Z by file name — recency chooses the
// rows, the name orders them. Older ones are not hidden behind anything — they are simply not
// in this list, and the git panel is where a whole branch's worth of files
// lives.
//
// Under the cap there are two ways to cut it down further and one way to tell
// the rows apart at a glance:
//
//   * a text box, matched against the whole path, so a folder narrows it too;
//   * a TYPE dropdown, built from the extensions actually present with a count
//     each — the two compose as an AND;
//   * and each row's MODIFIED time, read from disk rather than from the
//     transcript, so "which of these did the last change touch" is answered
//     without opening any of them.
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { bridge } from "../lib/bridge";
import {
  baseName,
  byName,
  candidatePaths,
  fileExt,
  fileTypes,
  formatModified,
  isImage,
  modifiedTitle,
  newestFiles,
  typeLabel,
} from "../lib/files";
import { useDockWidth, type Sizes } from "../lib/dockWidth";
import { askPaths, knownPaths, subscribePaths } from "../lib/pathStore";
import { useOpenFile } from "./OpenFile";
import type { Message } from "../lib/chat";

const WIDTH_KEY = "octiq.v2.filesWidth";

const SIZES: Sizes = { initial: 340, min: 260, max: 620 };

/** How often the transcript is re-scanned while the agent is still working.
 *  The scan runs a handful of regexes over every message, so it is not
 *  something to do per delta; a second's lag on a list nobody is reading yet
 *  costs nothing. */
const LIVE_MS = 1200;

/** How many files the panel holds, newest first. A hard ceiling rather than a
 *  first page: past two dozen rows the list has stopped being "what this chat
 *  is about" and become a log, and the older end of it is the part nobody
 *  scrolls to. */
const MAX_FILES = 25;

/** Below this many files the filter row is more chrome than help: a list this
 *  short is entirely on screen already, and reading it beats narrowing it. */
const FILTER_AT = 8;

/** The type filter's "everything" option. A sentinel rather than the empty
 *  string, because "" is a real answer here — the files with no extension at
 *  all, which are a bucket you can pick. */
const ALL_TYPES = "*";

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

/** Every file this conversation has touched that actually exists, in name
 *  order, out of the newest MAX_FILES of them.
 *
 *  The newest are what it KEEPS — the older end of a long session's list is
 *  history nobody scrolls to — and the name is what it ORDERS them by, because
 *  a column of names is scanned for a name.
 *
 *  Scanned when the transcript gains or loses a message — about once per tool
 *  call, which is the rate files actually appear at. `active` buys one thing on
 *  top of that: while the panel is OPEN and the agent is working, a ticking
 *  re-scan, so a path named halfway through a long reply shows up before that
 *  reply ends. Shut, it is not worth the regexes. */
export function useSessionFiles(
  messages: Message[],
  cwd: string,
  active: boolean,
  busy: boolean,
): string[] {
  const [paths, setPaths] = useState<string[]>([]);
  /** Bumped when the transcript is worth scanning again. The scan reads
   *  `messages` through a ref so that a delta arriving does not, on its own,
   *  start one. */
  const [gen, setGen] = useState(0);
  const latest = useRef(messages);
  latest.current = messages;

  // Message COUNT, not the messages themselves: it moves once per tool call
  // rather than once per delta, which is the cadence this wants. The first
  // message's id rides along so that opening another conversation of the same
  // length still counts as a change.
  const shape = `${messages.length}:${messages[0]?.id ?? ""}`;

  useEffect(() => {
    setGen((n) => n + 1);
    // Between message boundaries, only for someone actually watching.
    if (!busy || !active) return;
    const timer = setInterval(() => setGen((n) => n + 1), LIVE_MS);
    return () => clearInterval(timer);
  }, [busy, active, shape]);

  // `gen` is the whole dependency by design — see the ref above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const candidates = useMemo(() => candidatePaths(latest.current), [gen]);

  useEffect(() => {
    /** Rebuild the list from what the store knows. Cheap, and it is what makes
     *  a scan that learns nothing new a no-op rather than a flicker. */
    const apply = () => {
      // Recency picks WHICH files the list holds; the name decides the ORDER
      // they are read in. The two are not in competition: the cap is what keeps
      // a long session's list about the work in hand, and A→Z is how anyone
      // finds a row in a column of names. When a row was last written is the
      // stamp beside it.
      const out = byName(newestFiles(candidates, knownPaths(candidates, cwd), MAX_FILES));
      // Same list, same array: re-rendering the panel every LIVE_MS to draw
      // exactly what is already on screen is the thing this file exists to
      // stop doing.
      setPaths((prev) =>
        prev.length === out.length && prev.every((p, i) => p === out[i]) ? prev : out,
      );
    };

    // Draw what is already known, then follow the answers in. The store is
    // shared with the clickable paths in the transcript (lib/pathStore), so
    // most of a re-scan's candidates are answered before this even asks.
    apply();
    const off = subscribePaths(apply);
    askPaths(candidates, cwd);
    return off;
  }, [candidates, cwd]);

  return paths;
}

/** When each of these files was last written, in epoch milliseconds — `null`
 *  for one the backend could not stat, and missing entirely until the first
 *  answer comes back.
 *
 *  Asked in ONE call for the whole list, the same batching the existence check
 *  uses. Unlike that check the answers are NOT cached forever, because a stamp
 *  is the one thing here that goes stale while the list stays identical: the
 *  agent rewrites a file it edited an hour ago and the path does not change at
 *  all. So it is re-read whenever the list changes and whenever a turn ENDS —
 *  a stat taken mid-turn is out of date by the next tool call anyway, so the
 *  moment worth reading is the one the work stops at.
 *
 *  Only while the panel is open. There is nothing to keep fresh behind a shut
 *  door, and this is a filesystem call per turn. */
function useModified(
  paths: string[],
  active: boolean,
  busy: boolean,
): Map<string, number | null> {
  const [times, setTimes] = useState<Map<string, number | null>>(new Map());
  // The list as one string, so the effect re-runs when its CONTENTS change and
  // not merely when the scan handed back a new array of the same paths.
  const joined = paths.join("\n");

  useEffect(() => {
    if (!active || paths.length === 0) return;
    let alive = true;
    bridge
      .invoke<(number | null)[]>("stat_paths", { paths })
      .then((stamps) => {
        if (!alive) return;
        setTimes(new Map(paths.map((path, i) => [path, stamps?.[i] ?? null])));
      })
      .catch(() => {
        // A client newer than the server it is talking to has no `stat_paths`
        // to call — the two halves deploy separately. The rows simply show no
        // time, which is a column short of ideal and nothing worse.
      });
    return () => {
      alive = false;
    };
    // `paths` is read through `joined`; see above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, active, busy]);

  return times;
}

// ---------------------------------------------------------------------------
// The toolbar button
// ---------------------------------------------------------------------------

/** Open / close the panel, and say how much is in it.
 *
 *  Absent until the session has touched something. A button reading "0" is a
 *  button that has nothing to offer, and the bar has four other things to carry
 *  on a phone. */
export function FilesButton({
  count,
  open,
  onToggle,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  if (count === 0) return null;

  return (
    <button
      className={`icon-btn sfp-toggle ${open ? "is-on" : ""}`}
      type="button"
      aria-expanded={open}
      // Named apart from the view switch's "Files", which opens the editor.
      // Two controls one bar apart, both called Files, would be a coin toss.
      aria-label={`Files in this chat — ${count}`}
      title={
        count === MAX_FILES
          ? `The last ${MAX_FILES} files this chat has touched`
          : `${count} file${count === 1 ? "" : "s"} this chat has touched`
      }
      onClick={onToggle}
    >
      <FileIcon />
      <span className="sfp-count">{count}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export function SessionFilesPanel({
  paths,
  open,
  busy,
  onClose,
}: {
  paths: string[];
  open: boolean;
  /** Whether the chat is mid-turn — the cue to re-read the modified times once
   *  it stops. See `useModified`. */
  busy: boolean;
  onClose: () => void;
}) {
  const openFile = useOpenFile();
  const [filter, setFilter] = useState("");
  const [type, setType] = useState(ALL_TYPES);
  const modified = useModified(paths, open, busy);

  const { width, startDrag, entered } = useDockWidth(WIDTH_KEY, SIZES);

  /** The kinds on offer, counted over the WHOLE list rather than what the text
   *  box has left of it. A dropdown that reshuffles itself as you type is a
   *  dropdown you cannot aim at. */
  const types = useMemo(() => fileTypes(paths), [paths]);

  // Matched on the WHOLE path, so "src/lib" finds a folder and "png" finds a
  // kind, not just names that happen to contain it. The two filters are an AND:
  // pick .ts, then type "lib", and you get the TypeScript under lib.
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => {
    let out = paths;
    if (type !== ALL_TYPES) out = out.filter((p) => fileExt(p) === type);
    if (needle) out = out.filter((p) => p.toLowerCase().includes(needle));
    return out;
  }, [paths, needle, type]);

  /* A chosen type that the current list has none of — the panel stays mounted
   * across a conversation switch, so the .rs you picked in one chat can outlive
   * every .rs file. Kept as an option so the select is never blank, and the
   * body says plainly that nothing matches. */
  const orphanType = type !== ALL_TYPES && !types.some((t) => t.ext === type);

  return (
    <>
      {/* Phone only (the stylesheet hides it otherwise): tapping beside the
          panel closes it, which is what every sheet on the device does. */}
      <div
        className={`gitp-scrim ${entered && open ? "is-open" : ""}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`sfp-panel ${entered && open ? "is-open" : ""}`}
        aria-label="Files in this chat"
        // A custom property, not `width`: the phone rule in styles.css has to
        // be able to drop the column width, and an inline `width` would outrank
        // it.
        style={{ "--gitp-w": `${width}px` } as React.CSSProperties}
      >
        <div
          className="gitp-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the files panel"
          onPointerDown={startDrag}
        />

        <header className="gitp-head">
          <span className="gitp-title">Files</span>
          <span className="gitp-project">
            {/* Once a filter is on, the count has to say what it is counting —
                "12 in this chat" over a list of three is a lie you have to
                count the rows to catch. */}
            {shown.length !== paths.length
              ? `${shown.length} of ${paths.length}`
              : /* At the cap the count is not the session's total, and saying
                   "25 in this chat" over a chat that touched two hundred is the
                   same kind of lie the line above exists to avoid. */
                paths.length === MAX_FILES
                ? `Last ${MAX_FILES} in this chat`
                : `${paths.length} in this chat`}
          </span>
          <button className="gitp-close" type="button" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        {paths.length >= FILTER_AT && (
          <div className="sfp-filter">
            <input
              type="search"
              value={filter}
              placeholder="Filter by name or folder"
              aria-label="Filter files"
              onChange={(e) => setFilter(e.target.value)}
            />
            {/* A dropdown rather than a row of chips: this column is 340px by
                default, and a session touches a dozen kinds of file — chips
                would wrap into four rows of buttons above a list they exist to
                shorten. Absent when everything here is the same kind, which is
                a filter with one setting. */}
            {types.length > 1 && (
              <select
                className="sfp-type"
                value={type}
                aria-label="Filter by file type"
                onChange={(e) => setType(e.target.value)}
              >
                <option value={ALL_TYPES}>All types ({paths.length})</option>
                {types.map((t) => (
                  <option key={t.ext} value={t.ext}>
                    {typeLabel(t.ext)} ({t.count})
                  </option>
                ))}
                {orphanType && <option value={type}>{typeLabel(type)} (0)</option>}
              </select>
            )}
          </div>
        )}

        <div className="gitp-body sfp-body">
          {paths.length === 0 && (
            <div className="gitp-note">Nothing yet. Files show up here as the chat touches them.</div>
          )}
          {paths.length > 0 && shown.length === 0 && (
            <div className="gitp-note">
              No file here matches that.{" "}
              {type !== ALL_TYPES && (
                <button className="sfp-clear" type="button" onClick={() => setType(ALL_TYPES)}>
                  Show every type
                </button>
              )}
            </div>
          )}

          <ul className="sfp-list">
            {shown.map((path) => (
              <li key={path}>
                <button
                  className={`file ${isImage(path) ? "is-image" : ""}`}
                  type="button"
                  title={path}
                  onClick={() => openFile(path)}
                >
                  <span className="file-icon" aria-hidden="true">
                    {isImage(path) ? <ImageIcon /> : <FileIcon />}
                  </span>
                  <span className="file-name">{baseName(path)}</span>
                  <span className="file-dir">
                    <bdi>{path.slice(0, path.length - baseName(path).length)}</bdi>
                  </span>
                  {/* Last written. A clock time today, a date before that —
                      see `formatModified`. Its own title, so hovering the stamp
                      gives the whole thing back rather than the path the rest
                      of the row shows. */}
                  <span className="file-time" title={modifiedTitle(modified.get(path))}>
                    {formatModified(modified.get(path))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </>
  );
}

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}
