// The files worth opening, in one column.
//
// This column has been three things. It began as a footnote under each reply —
// the files THAT turn touched — which blinked on every tool call and answered a
// question nobody asks. It became a whole-session list beside the chat, built
// by scraping every path-shaped word out of the transcript and keeping the ones
// that existed on disk. Better, and still the wrong list: a session touches
// forty files, thirty-eight of which were opened to look around, and a column
// of forty names is a column nobody reads.
//
// So it is no longer a guess. The agent SAYS which files matter — `pin_file`,
// one line of reason each and a label to tag it with — and this draws what it
// said. See lib/pins for how the list is read back out of the transcript. A
// pin is the only way in: a file the agent merely read, and a file it merely
// changed, appear nowhere. That is the point.
//
// What survives from the scraper era is everything around the list. Paths are
// still resolved through the backend, so a pin to a file that does not exist is
// dropped rather than drawn. Modified times are still read from disk rather
// than the transcript. The filter row, the type dropdown, the phone sheet and
// the drag-resize are unchanged — they were never the part that was wrong.
//
// Each row also carries two quiet buttons: copy the path, and copy what is in
// the file. Both answer the same question the column does — this file matters —
// for the case where the answer is wanted somewhere else: a terminal, another
// chat, a message to somebody. See `PinRow`.
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { bridge } from "../lib/bridge";
import { copyText } from "../lib/clipboard";
import type { Preview } from "../lib/fileView";
import {
  baseName,
  fileExt,
  fileTypes,
  formatModified,
  isImage,
  modifiedTitle,
  typeLabel,
} from "../lib/files";
import { latestPins, pinPaths, type Pin } from "../lib/pins";
import { useDockWidth, type Sizes } from "../lib/dockWidth";
import { askPaths, knownPaths, subscribePaths } from "../lib/pathStore";
import { useOpenFile } from "./OpenFile";
import type { Message } from "../lib/chat";

const WIDTH_KEY = "octiq.v2.filesWidth";

const SIZES: Sizes = { initial: 340, min: 260, max: 620 };

/** How often the transcript is re-read while the agent is still working.
 *  Reading it is a walk backwards over the messages, so it is not something to
 *  do per delta; a second's lag on a column nobody is reading yet costs
 *  nothing. */
const LIVE_MS = 1200;

/** Below this many files the filter row is more chrome than help: a list this
 *  short is entirely on screen already, and reading it beats narrowing it. */
const FILTER_AT = 8;

/** The type filter's "everything" option. A sentinel rather than the empty
 *  string, because "" is a real answer here — the files with no extension at
 *  all, which are a bucket you can pick. */
const ALL_TYPES = "*";

// ---------------------------------------------------------------------------
// Reading the column
// ---------------------------------------------------------------------------

/** The files this conversation says are worth opening, in the order they should
 *  be read: the agent's newest pin list, as it ranked it.
 *
 *  The ORDER is the agent's and is left alone. The old list sorted A→Z because
 *  a scraped list has no meaningful order to preserve; a pinned one does — the
 *  agent put the file that answers the question first, and re-sorting by name
 *  would throw that away.
 *
 *  Re-read when the transcript gains or loses a message — about once per tool
 *  call, which is the rate pins actually appear at. `active` buys one thing on
 *  top of that: while the panel is OPEN and the agent is working, a ticking
 *  re-read, so a file pinned halfway through a long reply shows up before that
 *  reply ends. Shut, it is not worth the walk. */
export function useSessionPins(
  messages: Message[],
  cwd: string,
  active: boolean,
  busy: boolean,
): Pin[] {
  const [pins, setPins] = useState<Pin[]>([]);
  /** Bumped when the transcript is worth re-reading. The read goes through a
   *  ref so that a delta arriving does not, on its own, start one. */
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
  const claimed = useMemo(() => latestPins(latest.current), [gen]);
  const claimedKey = useMemo(() => pinPaths(claimed).join("\n"), [claimed]);

  useEffect(() => {
    /** Rebuild the column from what the path store knows.
     *
     *  A pin names a file the way the agent happened to write it — relative to
     *  the project, or with a `~`. The store answers with the absolute path for
     *  the ones that EXIST, `null` for the ones that do not, and nothing at all
     *  until it has been asked. So a pin to a file that was never written is
     *  quietly dropped instead of drawn as a dead row, and a pin still being
     *  resolved simply arrives a moment later. */
    const apply = () => {
      const answers = knownPaths(pinPaths(claimed), cwd);
      const out: Pin[] = [];
      for (const pin of claimed) {
        const resolved = answers.get(pin.path);
        if (typeof resolved !== "string") continue;
        out.push({ ...pin, path: resolved });
      }
      // Same column, same array: re-rendering every LIVE_MS to draw exactly
      // what is already on screen is the thing this guards against.
      setPins((prev) =>
        prev.length === out.length &&
        prev.every(
          (p, i) =>
            p.path === out[i].path && p.why === out[i].why && p.label === out[i].label,
        )
          ? prev
          : out,
      );
    };

    // Draw what is already known, then follow the answers in. The store is
    // shared with the clickable paths in the transcript (lib/pathStore), so a
    // file the agent pinned after writing about it is usually answered before
    // this even asks.
    apply();
    const off = subscribePaths(apply);
    askPaths(pinPaths(claimed), cwd);
    return off;
    // `claimed` is read through `claimedKey`, which moves when the list does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimedKey, cwd]);

  return pins;
}

/** When each of these files was last written, in epoch milliseconds — `null`
 *  for one the backend could not stat, and missing entirely until the first
 *  answer comes back.
 *
 *  Asked in ONE call for the whole list, the same batching the existence check
 *  uses. Unlike that check the answers are NOT cached forever, because a stamp
 *  is the one thing here that goes stale while the list stays identical: the
 *  agent rewrites a file it pinned an hour ago and the path does not change at
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
  // not merely when the read handed back a new array of the same paths.
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
 *  Absent until something has been pinned. A button reading "0" is a button
 *  that has nothing to offer, and the bar has four other things to carry on a
 *  phone. */
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
      aria-label={`Files worth opening — ${count}`}
      title={`${count} file${count === 1 ? "" : "s"} worth opening`}
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
  pins,
  open,
  busy,
  onClose,
}: {
  pins: Pin[];
  open: boolean;
  /** Whether the chat is mid-turn — the cue to re-read the modified times once
   *  it stops. See `useModified`. */
  busy: boolean;
  onClose: () => void;
}) {
  const openFile = useOpenFile();
  const [filter, setFilter] = useState("");
  const [type, setType] = useState(ALL_TYPES);
  const paths = useMemo(() => pinPaths(pins), [pins]);
  const modified = useModified(paths, open, busy);

  const { width, startDrag, entered } = useDockWidth(WIDTH_KEY, SIZES);

  /** The kinds on offer, counted over the WHOLE column rather than what the
   *  text box has left of it. A dropdown that reshuffles itself as you type is
   *  a dropdown you cannot aim at. */
  const types = useMemo(() => fileTypes(paths), [paths]);

  // Matched on the whole path AND on the label and the reason, so "retry" finds
  // the file pinned as "the retry loop" even though no part of its name says so.
  // That is new, and it is the reason a pinned column is worth searching at all:
  // the words you remember are the agent's, not the filename's.
  const needle = filter.trim().toLowerCase();
  const shown = useMemo(() => {
    let out = pins;
    if (type !== ALL_TYPES) out = out.filter((p) => fileExt(p.path) === type);
    if (needle) {
      out = out.filter(
        (p) =>
          p.path.toLowerCase().includes(needle) ||
          (p.label ?? "").toLowerCase().includes(needle) ||
          (p.why ?? "").toLowerCase().includes(needle),
      );
    }
    return out;
  }, [pins, needle, type]);

  /* A chosen type that the current column has none of — the panel stays mounted
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
        aria-label="Files worth opening"
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
                "12 to read" over a list of three is a lie you have to count the
                rows to catch. */}
            {shown.length !== pins.length
              ? `${shown.length} of ${pins.length}`
              : `${pins.length} to read`}
          </span>
          <button className="gitp-close" type="button" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        {pins.length >= FILTER_AT && (
          <div className="sfp-filter">
            <input
              type="search"
              value={filter}
              placeholder="Filter by name or reason"
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
                <option value={ALL_TYPES}>All types ({pins.length})</option>
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
          {pins.length === 0 && (
            <div className="gitp-note">
              Nothing yet. Files show up here when the agent pins one worth reading.
            </div>
          )}
          {pins.length > 0 && shown.length === 0 && (
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
            {shown.map((pin) => (
              <PinRow
                key={pin.path}
                pin={pin}
                modified={modified.get(pin.path)}
                onOpen={openFile}
              />
            ))}
          </ul>
        </div>
      </aside>
    </>
  );
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

/** How long an already-read file stays good enough to put on the clipboard.
 *
 *  Short on purpose. This column's whole subject is files an agent is CHANGING,
 *  so a cached read is a copy of what the file used to say — and a clipboard
 *  holding the previous version of a file is worse than a slower button. Long
 *  enough to cover a hover followed by a click, and no longer. */
const FILE_FRESH_MS = 2500;

/** What a copy button found to copy: the text, or `null` for "there is nothing
 *  here to put on a clipboard". `partial` when only the head of the file came
 *  back — the backend caps a preview read, and a silently half-copied file is
 *  exactly the kind of quiet lie a copy button must not tell. */
type Copyable = { text: string | null; partial?: boolean };

/** One pinned file.
 *
 *  The row opens the file. The two buttons beside it offer what you may want
 *  WITHOUT opening it — where the file is, and what is in it — and they live
 *  outside the row's own button rather than inside it, because a button inside
 *  a button is not something a browser will draw. That is the only reason this
 *  is a component of its own. */
export function PinRow({
  pin,
  modified,
  onOpen,
}: {
  pin: Pin;
  /** Epoch milliseconds; `null` when the backend could not stat the file, and
   *  missing entirely until the first answer comes back. */
  modified: number | null | undefined;
  onOpen: (path: string) => void;
}) {
  const image = isImage(pin.path);
  const file = useFileText(pin.path);

  return (
    <li className="sfp-row">
      <button
        className={`file sfp-pin ${image ? "is-image" : ""}`}
        type="button"
        title={pin.path}
        onClick={() => onOpen(pin.path)}
      >
        <span className="file-icon" aria-hidden="true">
          {image ? <ImageIcon /> : <FileIcon />}
        </span>
        <span className="file-name">{baseName(pin.path)}</span>
        <span className="file-dir">
          <bdi>{pin.path.slice(0, pin.path.length - baseName(pin.path).length)}</bdi>
        </span>
        {/* Last written. A clock time today, a date before that — see
            `formatModified`. Its own title, so hovering the stamp gives the
            whole thing back rather than the path the rest of the row shows. */}
        <span className="file-time" title={modifiedTitle(modified)}>
          {formatModified(modified)}
        </span>
        {/* The label and the reason — the whole point of the column, and the
            half no scraper could ever have produced. The label leads because it
            is the shorter answer: a row you can place without reading the
            sentence after it. Both are optional, and a row with neither is
            still a file the agent chose to put in front of you.

            A line number rides along when the agent gave one. It is a signpost,
            not a jump: clicking opens the file, because the editor restores
            where you last were in it and landing somewhere else would fight
            that. */}
        {(pin.label || pin.why || pin.line) && (
          <span className="sfp-why">
            {pin.label && <span className="sfp-label">{pin.label}</span>}
            {pin.why}
            {pin.line ? (
              <span className="sfp-line">
                {pin.why ? " " : ""}line {pin.line}
              </span>
            ) : null}
          </span>
        )}
      </button>

      {/* Dim until the row is hovered, never hidden outright: a phone has no
          hover, and a control that exists only under a pointer does not exist
          at all on the device this column was drawn for. The space they take is
          reserved on every row, so nothing shifts under the cursor. */}
      <span className="sfp-acts">
        <CopyBit
          icon={<CopyIcon />}
          idle="Copy the path"
          done="Path copied"
          read={() => ({ text: pin.path })}
        />
        {/* Absent for a picture, which has no text to hand over and would only
            ever answer "nothing to copy". Everything else is offered and the
            backend decides — a PDF, an executable and a .ts with a NUL in it
            all come back as not-text, which the button says plainly. */}
        {!image && (
          <CopyBit
            icon={<TextIcon />}
            idle="Copy what is in the file"
            done="File copied"
            empty="Nothing to copy — this file is not text"
            partial="Copied the first part — the file is too big to read whole"
            arm={file.arm}
            read={file.read}
          />
        )}
      </span>
    </li>
  );
}

/** Read a file's text for the clipboard, ahead of the click where the browser
 *  gives us the chance.
 *
 *  The chance matters. A clipboard write is only allowed while the page still
 *  holds the user gesture that asked for it, and an `await` in front of it
 *  spends that gesture — so "read the file, then copy it" is a copy that some
 *  browsers refuse outright. Hovering a row is a gesture-free moment to do the
 *  reading in, and by the time the click lands the text is already here and the
 *  copy is synchronous.
 *
 *  Touch has no hover, so there the read really does happen inside the click
 *  and the copy really can be refused. It is attempted anyway and the button
 *  says whether it landed, which is the honest half of the same problem —
 *  `copyText` reports rather than assumes. */
function useFileText(path: string) {
  const cached = useRef<{ at: number; value: Copyable } | null>(null);
  const inflight = useRef<Promise<Copyable> | null>(null);

  const fresh = () =>
    cached.current && Date.now() - cached.current.at < FILE_FRESH_MS ? cached.current.value : null;

  const fetchText = (): Promise<Copyable> => {
    if (inflight.current) return inflight.current;
    const run = bridge
      .invoke<Preview>("read_file_preview", { path })
      .then<Copyable>((preview) =>
        preview?.kind === "text"
          ? { text: preview.content, partial: preview.truncated }
          : { text: null },
      )
      // An older backend with no `read_file_preview`, a file deleted since it
      // was pinned, a permission we do not have: all the same answer here.
      .catch<Copyable>(() => ({ text: null }))
      .then((value) => {
        cached.current = { at: Date.now(), value };
        inflight.current = null;
        return value;
      });
    inflight.current = run;
    return run;
  };

  return {
    /** Start reading, because a click looks likely. */
    arm: () => {
      if (!fresh()) void fetchText();
    },
    read: (): Copyable | Promise<Copyable> => fresh() ?? fetchText(),
  };
}

/** One of a row's copy buttons.
 *
 *  Says what actually happened rather than always claiming success: this app is
 *  reached over plain http from a phone, where the modern clipboard API does
 *  not exist and the fallback can be refused, and "copied" over an unchanged
 *  clipboard is worse than being told it did not work. */
function CopyBit({
  icon,
  idle,
  done,
  empty,
  partial,
  arm,
  read,
}: {
  icon: React.ReactNode;
  /** What the button offers, before it has been pressed. */
  idle: string;
  /** What it says after it worked. */
  done: string;
  /** What it says when there was nothing worth copying. */
  empty?: string;
  /** What it says when only part of the file came back. */
  partial?: string;
  /** Called when a click looks likely, to get any reading out of the way. */
  arm?: () => void;
  read: () => Copyable | Promise<Copyable>;
}) {
  const [state, setState] = useState<"idle" | "done" | "warn" | "failed">("idle");
  const [said, setSaid] = useState(idle);

  const settle = (next: "done" | "warn" | "failed", words: string) => {
    setState(next);
    setSaid(words);
    setTimeout(() => {
      setState("idle");
      setSaid(idle);
    }, 1600);
  };

  return (
    <button
      className={`sfp-act is-${state}`}
      type="button"
      title={said}
      aria-label={said}
      onPointerEnter={arm}
      onPointerDown={arm}
      onFocus={arm}
      onClick={async () => {
        const found = read();
        const { text, partial: cut } = found instanceof Promise ? await found : found;
        if (text === null || text === "") {
          settle("warn", empty ?? "Nothing to copy");
          return;
        }
        if (!(await copyText(text))) {
          settle("failed", "Could not copy");
          return;
        }
        settle(cut ? "warn" : "done", cut ? (partial ?? done) : done);
      }}
    >
      {state === "done" ? <TickIcon /> : icon}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

/** A page with words on it — the file's contents, as against its address. */
function TextIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </svg>
  );
}

function TickIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m20 6-11 11-5-5" />
    </svg>
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
