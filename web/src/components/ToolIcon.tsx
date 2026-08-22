// One picture per family of tool call.
//
// Line icons, 24-grid, stroked in `currentColor` — the same drawing style as
// the sidebar's, so a chat row and a sidebar row look like the same product.
// Colour is not set here: the badge around the icon owns the tint (styles.css,
// `.tool-icon[data-kind]`), so a kind's colour is stated once.
//
// They are decoration, not information: every row still carries the tool's name
// in words beside it. So they are `aria-hidden` and a reader that cannot see
// them loses nothing.
import type React from "react";
import type { ToolKind } from "../lib/toolKind";

const PATHS: Record<ToolKind, React.ReactNode> = {
  // A page with lines on it.
  read: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  // A pencil: something on disk is about to be different.
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  // A shell prompt.
  run: (
    <>
      <path d="M4 17l5-5-5-5" />
      <path d="M12 19h8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.6-3.6" />
    </>
  ),
  web: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z" />
    </>
  ),
  // Sparkles: another agent thinking on your behalf.
  agent: (
    <>
      <path d="M11 3l1.7 4.3L17 9l-4.3 1.7L11 15l-1.7-4.3L5 9l4.3-1.7z" />
      <path d="M18 14.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </>
  ),
  // A puzzle piece: a skill is a packaged piece that clicks into the agent.
  skill: (
    <path d="M9 6a2 2 0 1 1 4 0h3a1 1 0 0 1 1 1v3a2 2 0 1 1 0 4v3a1 1 0 0 1-1 1h-3a2 2 0 1 0-4 0H6a1 1 0 0 1-1-1v-3a2 2 0 1 0 0-4V7a1 1 0 0 1 1-1z" />
  ),
  // A plug: this one left the app and talked to something else.
  mcp: (
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v4" />
    </>
  ),
  plan: (
    <>
      <path d="M4 7l1.8 1.8L9 5.6" />
      <path d="M4 16l1.8 1.8L9 14.6" />
      <path d="M13 7h7M13 17h7" />
    </>
  ),
  other: (
    <path d="M14.6 6.3a1 1 0 0 0 0 1.4l1.7 1.7a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
  ),
};

export function ToolIcon({ kind }: { kind: ToolKind }) {
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
    >
      {PATHS[kind]}
    </svg>
  );
}

/** How a call ended, in the smallest mark that says it.
 *
 *  A finished call is the common case and the boring one — a whole column of
 *  the word "done" is noise, so it gets a tick and nothing else. Running,
 *  failed and stopped keep their words: those are the rows a reader is looking
 *  for. */
export function ToolState({ state }: { state: "running" | "done" | "error" | "stopped" }) {
  if (state === "running") {
    return (
      <span className="tool-state is-running">
        <span className="tool-spinner" aria-hidden="true" />
        running
      </span>
    );
  }
  if (state === "error") return <span className="tool-state is-error">failed</span>;
  // The turn was stopped before this call could answer. Said plainly and left
  // quiet: nothing went wrong here, the reader ended it on purpose.
  if (state === "stopped") return <span className="tool-state is-stopped">stopped</span>;
  return (
    <span className="tool-state" aria-label="done">
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  );
}
