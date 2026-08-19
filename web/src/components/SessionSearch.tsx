// Finding an earlier agent session, from the page where a new one starts.
//
// A chat you had yesterday is not gone: both Claude Code and Codex keep every
// session they have ever run, and both can be told to pick one back up. Until
// now the only sessions this app could return to were the ones it had started
// itself and still had a row for. This is the other door — the same list the
// agents keep, searchable, on the screen where you would otherwise start from
// nothing.
//
// It sits under the hero rather than in a modal on purpose. Starting fresh and
// carrying on are the same decision, made at the same moment, so they belong in
// the same place; a dialog would make one of them feel like a detour.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  folderName,
  loadHistory,
  refreshHistory,
  searchSessions,
  whenLabel,
  type HistorySession,
} from "../lib/history";

/** Rows on screen at once. Enough to scan, few enough that the panel does not
 *  swallow the page on a phone. */
const SHOWN = 8;

export function SessionSearch({
  projectPath,
  onResume,
}: {
  /** The folder this project runs in, for the "This project" filter. */
  projectPath?: string;
  onResume: (session: HistorySession) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<"all" | "claude" | "codex">("all");
  const [hereOnly, setHereOnly] = useState(true);
  const [sessions, setSessions] = useState<HistorySession[] | null>(null);
  /** Why there is no list, when there is none. Kept apart from "not yet": an
   *  empty result and a failed call look identical on screen otherwise, and
   *  only one of them is something the reader can do anything about. */
  const [problem, setProblem] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Ask for the list as soon as this appears, not when the panel opens. The
  // first scan on the server reads hundreds of files; doing it now means the
  // panel is already full by the time anyone opens it, and the cost is paid
  // where nobody is waiting.
  useEffect(() => {
    let alive = true;
    loadHistory().then(
      (list) => {
        if (alive) {
          setSessions(list);
          setProblem(null);
        }
      },
      (err: Error) => {
        if (alive) {
          setSessions([]);
          setProblem(err.message);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const hits = useMemo(
    () =>
      searchSessions(sessions ?? [], query, {
        agent: agent === "all" ? undefined : agent,
        cwd: hereOnly ? projectPath : undefined,
        limit: 40,
      }),
    [sessions, query, agent, hereOnly, projectPath],
  );

  /** How many the same search finds outside this project. Only worth working
   *  out when the narrow search came back empty — it is the answer to "I know I
   *  had this open somewhere". */
  const elsewhere = useMemo(() => {
    if (!hereOnly || hits.length > 0 || !sessions) return 0;
    return searchSessions(sessions, query, {
      agent: agent === "all" ? undefined : agent,
      limit: 40,
    }).length;
  }, [hereOnly, hits.length, sessions, query, agent]);

  // The highlight always starts at the top of a NEW result set. Leaving it
  // where it was means Enter opens whatever happens to have slid under it.
  useEffect(() => setCursor(0), [query, agent, hereOnly]);

  useEffect(() => {
    listRef.current?.querySelector(".is-on")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  if (!open) {
    return (
      <button className="resume-open" type="button" onClick={() => setOpen(true)}>
        <HistoryIcon />
        Resume an earlier session
        {sessions && sessions.length > 0 && <span className="resume-count">{sessions.length}</span>}
      </button>
    );
  }

  const move = (by: number) => setCursor((c) => Math.min(Math.max(c + by, 0), hits.length - 1));

  return (
    <div className="resume">
      <div className="resume-bar">
        <input
          className="resume-input"
          value={query}
          autoFocus
          type="search"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder="Search Claude and Codex sessions"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              move(1);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              move(-1);
            } else if (e.key === "Enter" && hits[cursor]) {
              e.preventDefault();
              onResume(hits[cursor].session);
              setOpen(false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              if (query) setQuery("");
              else setOpen(false);
            }
          }}
        />
        <button
          className="resume-close"
          type="button"
          title="Close the search"
          onClick={() => setOpen(false)}
        >
          ✕
        </button>
      </div>

      <div className="resume-chips">
        {(["all", "claude", "codex"] as const).map((id) => (
          <button
            key={id}
            type="button"
            className={`resume-chip ${agent === id ? "is-on" : ""}`}
            onClick={() => setAgent(id)}
          >
            {id === "all" ? "Both" : id === "claude" ? "Claude" : "Codex"}
          </button>
        ))}
        {projectPath && (
          <button
            type="button"
            className={`resume-chip is-scope ${hereOnly ? "is-on" : ""}`}
            title={hereOnly ? `Only sessions from ${projectPath}` : "Sessions from every folder"}
            onClick={() => setHereOnly((v) => !v)}
          >
            This project
          </button>
        )}
      </div>

      <div className="resume-list" ref={listRef} style={{ maxHeight: `${SHOWN * 52}px` }}>
        {sessions === null && <div className="resume-msg">Reading what the agents remember…</div>}
        {problem && <div className="resume-msg is-bad">{problem}</div>}
        {sessions !== null && !problem && hits.length === 0 && (
          <div className="resume-msg">
            {elsewhere > 0 ? (
              <>
                Nothing here.{" "}
                <button className="resume-link" type="button" onClick={() => setHereOnly(false)}>
                  {elsewhere} in other folders
                </button>
              </>
            ) : (
              "No session matches."
            )}
          </div>
        )}
        {hits.map((hit, i) => (
          <button
            key={`${hit.session.agent}:${hit.session.sessionId}`}
            type="button"
            className={`resume-row ${i === cursor ? "is-on" : ""}`}
            onMouseEnter={() => setCursor(i)}
            onClick={() => {
              onResume(hit.session);
              setOpen(false);
            }}
          >
            <span className={`resume-tag is-${hit.session.agent}`}>
              {hit.session.agent === "claude" ? "Claude" : "Codex"}
            </span>
            <span className="resume-main">
              <span className="resume-title">
                <Marked text={hit.session.title} ranges={hit.ranges} />
              </span>
              <span className="resume-where">
                <bdi>{folderName(hit.session.cwd) || hit.session.cwd}</bdi>
                {hit.session.model && <span className="resume-dot">·</span>}
                {hit.session.model && shortModel(hit.session.model)}
                {hit.session.effort && <span className="resume-dot">·</span>}
                {hit.session.effort}
              </span>
            </span>
            <span className="resume-when">{whenLabel(hit.session.updatedAt)}</span>
          </button>
        ))}
      </div>

      <div className="resume-foot">
        <span>Picking one carries on that conversation, with its own model and effort.</span>
        <button
          className="resume-link"
          type="button"
          onClick={() => {
            setSessions(null);
            setProblem(null);
            refreshHistory().then(
              (list) => setSessions(list),
              (err: Error) => {
                setSessions([]);
                setProblem(err.message);
              },
            );
          }}
        >
          Look again
        </button>
      </div>
    </div>
  );
}

/** The title with the matched parts marked. The ranges come from the search,
 *  which measured them against the lower-cased title — the same string length,
 *  so they line up with the original. */
function Marked({ text, ranges }: { text: string; ranges: [number, number][] }) {
  if (ranges.length === 0) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start >= text.length) break;
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <mark key={start} className="resume-mark">
        {text.slice(start, Math.min(end, text.length))}
      </mark>,
    );
    at = Math.min(end, text.length);
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

/** `claude-opus-5` → `opus`, `gpt-5.6-terra` → `gpt-5.6`. The full id is the
 *  agent's business; the row only has space for the part that tells them apart. */
function shortModel(id: string): string {
  const claude = id.match(/(opus|sonnet|haiku|fable)/i);
  if (claude) return claude[1].toLowerCase();
  const gpt = id.match(/^(gpt-[\d.]+)/i);
  return gpt ? gpt[1].toLowerCase() : id;
}

function HistoryIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
