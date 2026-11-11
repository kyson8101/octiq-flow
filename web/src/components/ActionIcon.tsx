import type { ReactNode } from "react";
import "./ActionIcon.css";

// One fixed vocabulary for actions throughout the client. Answers that share
// a card have different silhouettes; colour only marks the primary answer.
const glyphs = {
  copy: <><rect x="9" y="9" width="11" height="12" rx="2" /><path d="M5 15H4V3h11v2" /></>,
  retry: <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6" /></>,
  refresh: <><path d="M20 7a8 8 0 0 0-13-1L4 9m0-6v6h6M4 17a8 8 0 0 0 13 1l3-3m0 6v-6h-6" /></>,
  expand: <path d="m6 9 6 6 6-6" />,
  collapse: <path d="m6 15 6-6 6 6" />,
  edit: <><path d="m15 4 5 5M4 20l5-1L21 7l-4-4L5 15zM13 21h8" /></>,
  delete: <><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6m4-6v6" /></>,
  cancel: <><path d="m8 4-5 5 5 5M3 9h11a6 6 0 0 1 0 12" /></>,
  dismiss: <path d="m6 6 12 12M18 6 6 18" />,
  deny: <><circle cx="12" cy="12" r="9" /><path d="m6 6 12 12" /></>,
  allow: <path d="m4 12 5 5L20 6" />,
  always: <><path d="m2 12 5 5L18 6M12 17l3 3 7-7" /></>,
  alwaysProject: <><rect x="11" y="11" width="10" height="10" rx="2" /><path d="M13 11V8a3 3 0 0 1 6 0v3M2 9l3 3 5-6M16 15v2" /></>,
  alwaysEverywhere: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18M8 11l3 3 5-6" /></>,
  approve: <><path d="m12 2 3 2 4 1 1 4 2 3-2 3-1 4-4 1-3 2-3-2-4-1-1-4-2-3 2-3 1-4 4-1z" /><path d="m7 12 3 3 7-7" /></>,
  safer: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" /><path d="m8 12 3 3 5-6" /></>,
  send: <><path d="m4 12 16-8-5 16-3-7-8-1zM12 13l8-9" /></>,
  answer: <><path d="M4 4h16v13H9l-5 4zM8 9h8M8 13h5" /></>,
  handover: <><path d="M10 4H4v16h6M10 12h11m-5-5 5 5-5 5" /></>,
  keep: <><path d="m3 11 9-8 9 8M5 10v11h14V10M10 21v-7h4v7" /></>,
  keepWorktree: <><path d="M12 7H3V4h6l3 3h9v4M3 7v13h8" /><rect x="13" y="14" width="8" height="7" rx="1" /><path d="M15 14v-2a2 2 0 0 1 4 0v2" /></>,
  reopen: <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6M12 8v8m-4-4h8" /></>,
  cleanup: <><path d="m14 3 7 7-9 11-9-9zM7 8l9 9M4 16l4 4M16 2l6 6" /></>,
  confirm: <><circle cx="12" cy="12" r="9" /><path d="m7 12 3 3 7-7" /></>,
  complete: <><path d="M20 11v9H4V4h11M8 10l4 4L21 3" /></>,
  history: <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6M12 7v6l4 2" /></>,
  back: <path d="M20 12H4m6-6-6 6 6 6" />,
  new: <path d="M12 4v16M4 12h16" />,
  tasks: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16M13 9h4m-4 5h4" /></>,
  git: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="6" r="2" /><path d="M6 7v10M8 16h3a7 7 0 0 0 7-7V8" /></>,
  focus: <path d="M9 4H4v5m11-5h5v5M4 15v5h5m6 0h5v-5" />,
  details: <><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></>,
  agents: <><circle cx="9" cy="7" r="3" /><path d="M3 21v-4a6 6 0 0 1 12 0v4M17 4a3 3 0 0 1 0 6m1 4a5 5 0 0 1 3 5v2" /></>,
  pinned: <><path d="m9 3 12 12-5 1-4 4-2-6-7-2 4-4zM3 21l5-5" /></>,
  width: <><g className="chat-width-arrows chat-width-arrows-in"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M16 21h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" /></g><g className="chat-width-arrows chat-width-arrows-out"><path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M16 21v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3" /></g></>,
  run: <><circle cx="5" cy="12" r="2" /><circle cx="19" cy="5" r="2" /><circle cx="19" cy="19" r="2" /><path d="M7 12h4a3 3 0 0 0 3-3V8a3 3 0 0 1 3-3M7 12h4a3 3 0 0 1 3 3v1a3 3 0 0 0 3 3" /></>,
  more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  save: <><path d="M4 3h13l4 4v14H4zM8 3v6h8V3M8 21v-8h9v8" /></>,
  preview: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
} satisfies Record<string, ReactNode>;

export type ActionName = keyof typeof glyphs;
export const ACTION_NAMES = Object.keys(glyphs) as ActionName[];

/** The containing button owns its full accessible name and tooltip.
 * Decisions and panel actions pass a short visible label; utilities and the
 * ActionBar omit it. The decorative glyph stays 16px in either case. */
export function ActionIcon({ name, label }: { name: ActionName; label?: string }) {
  return <><svg className="action-icon" data-action-icon={name} width="16" height="16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">{glyphs[name]}</svg>{label && <span className="action-label" aria-hidden="true">{label}</span>}</>;
}
