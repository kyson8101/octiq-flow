// What this app is holding in RAM, in the top bar.
//
// The number that matters is never the server's own — it is ~40 MB and always
// has been. It is the chats: an agent plus its own private copy of every MCP
// server it starts is ~480 MB, and six conversations left open overnight is
// most of 4 GB with nothing on screen to say which one to close. That is the
// whole reason this exists: the sidebar lists conversations, and has never
// been able to tell you which of them is the expensive one.
//
// A number, not a bar. There is no ceiling this could honestly be drawn
// against — the machine's total RAM says nothing about how much of it OctiqFlow
// may fairly have — so a fill would be inventing a threshold, and inventing one
// is what turns a readout into a nag. The number is the reading; the popover
// says where it went.
//
// It borrows the plan meter's `usage-*` shell classes on purpose. Those are
// already the top-bar-readout-with-a-popover primitives, and they carry the
// phone case with them: on a small screen this whole control moves into the
// drawer footer, where a popup has to open UPWARDS or fall off the viewport.
// A second copy of that would be a second copy of that bug.
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { formatMb, nameRow, type MemoryUsage } from "../lib/memoryNames";
import type { Store as TerminalStore } from "../lib/terminals";
import { RollingText } from "./RollingNumber";

/** How often the readout re-reads, while the tab is on screen.
 *
 *  Slow on purpose. Memory moves in minutes — an agent starting up, a chat
 *  being reaped — and nothing here is worth a number that flickers. The poll
 *  is also SKIPPED entirely while the tab is hidden: four tabs left open would
 *  otherwise wake the machine on their own timers to draw something nobody is
 *  looking at. The backend caches a sweep for a few seconds anyway, so tabs
 *  that do come back together still cost one `ps` between them. */
const REFRESH_MS = 30_000;

/** Same as the plan meter: the gap between the button and the popup belongs to
 *  neither, so crossing it must not read as leaving. */
const CLOSE_MS = 180;

/** Where the terminal tab strip saves itself. Read only, and only to put a
 *  name on a row: the tabs themselves belong to TerminalDrawer, and lifting
 *  that state through the whole app to label a line in a popover would be a
 *  much bigger change than the label is worth. */
const TERMS_KEY = "octiq.v2.terminals";

function readTerminals(): TerminalStore {
  try {
    const parsed = JSON.parse(localStorage.getItem(TERMS_KEY) || "{}");
    return parsed && typeof parsed === "object" ? (parsed as TerminalStore) : {};
  } catch {
    return {};
  }
}

export function Memory({
  conversations,
  projects,
}: {
  conversations: { id: string; title: string; projectId: string }[];
  projects: { id: string; name: string }[];
}) {
  const [usage, setUsage] = useState<MemoryUsage | null>(null);
  const [open, setOpen] = useState<null | "hover" | "pin">(null);
  const [terminals, setTerminals] = useState<TerminalStore>({});
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  useEffect(() => cancelClose, [cancelClose]);

  const refresh = useCallback(async () => {
    try {
      setUsage(await bridge.invoke<MemoryUsage>("memory_usage"));
    } catch {
      // A backend older than this page does not have the command. The two
      // halves deploy separately, so this really happens — and the honest
      // answer is to show nothing rather than a zero.
      setUsage(null);
    }
  }, []);

  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && void refresh();
    tick();
    const timer = setInterval(tick, REFRESH_MS);
    // Coming back to the tab is when what is on screen is oldest.
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("focus", tick);
    };
  }, [refresh]);

  // The tab strip is read when the popover opens, not on every render: it comes
  // from storage another component owns, and it can have changed since.
  const show = useCallback(
    (mode: "hover" | "pin") => {
      setTerminals(readTerminals());
      setOpen((v) => (mode === "pin" ? (v === "pin" ? null : "pin") : (v ?? "hover")));
      void refresh();
    },
    [refresh],
  );

  if (!usage) return null;

  return (
    <div
      className="usage mem"
      onPointerEnter={(e) => {
        if (e.pointerType !== "mouse") return;
        cancelClose();
        show("hover");
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "mouse") return;
        cancelClose();
        closeTimer.current = setTimeout(
          () => setOpen((v) => (v === "hover" ? null : v)),
          CLOSE_MS,
        );
      }}
    >
      <button
        className="usage-btn"
        type="button"
        title="Memory this app is holding — hover or tap for what is holding it"
        onClick={() => {
          cancelClose();
          show("pin");
        }}
      >
        <span className="usage-pill">
          <ChipIcon />
          <span className="usage-val">
            <RollingText>{formatMb(usage.totalMb)}</RollingText>
          </span>
        </span>
      </button>

      {open && (
        <>
          {open === "pin" && <div className="usage-scrim" onClick={() => setOpen(null)} />}
          <div className="usage-pop" role="dialog" aria-label="Memory">
            <section className="usage-block">
              <header className="usage-block-head">
                <span className="usage-block-name">{"Memory"}</span>
                <span className="usage-plan">{`${usage.procs} processes`}</span>
              </header>
              {usage.rows.map((row) => {
                const label = nameRow(row, { conversations, projects, terminals });
                return (
                  <div className="mem-row" key={`${row.kind}:${row.id}`}>
                    {/* Both halves stay together on the left, against the
                        number on the right. Inside the pair the TITLE is what
                        gives when the row is too narrow: a project clipped to
                        "octiq-fl…" has lost the only job it had, which is
                        telling two rows with the same name apart. */}
                    <span className="mem-label">
                      <span className="mem-name" title={label.name}>
                        {label.name}
                      </span>
                      {label.where && <span className="mem-where">{label.where}</span>}
                    </span>
                    <span className="usage-val">{formatMb(row.mb)}</span>
                  </div>
                );
              })}
              {/* RSS counts pages two processes share twice over. Saying so once,
                  quietly, is the difference between a reading and a claim. */}
              <div className="usage-empty">{"Resident size; shared pages counted twice."}</div>
            </section>
          </div>
        </>
      )}
    </div>
  );
}

/** A memory chip: the package and its pins. Enough at 14px to read as "this is
 *  about memory" without a word next to it. */
function ChipIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="mem-icon"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
      <path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3" />
    </svg>
  );
}
