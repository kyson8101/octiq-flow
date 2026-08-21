// The search behind "resume an earlier session".
//
// The ranking is the whole feature: a machine with a thousand past sessions on
// it needs the right three at the top, not a filter that technically matches.
// So these say what should come FIRST, not merely what should be included.
//
// `history.ts` imports `bridge`, which opens a WebSocket the moment it is
// loaded. Nothing here calls `loadHistory`, so the module is stubbed out rather
// than left to reach for a socket that is not there in a test run.
import { describe, expect, it, vi } from "vitest";

vi.mock("./bridge", () => ({ bridge: { invoke: async () => [] } }));

import {
  folderName,
  isUnder,
  replaySession,
  searchSessions,
  whenLabel,
  type HistorySession,
} from "./history";

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function session(fields: Partial<HistorySession>): HistorySession {
  return {
    agent: "claude",
    sessionId: "id",
    title: "",
    cwd: "/work/app",
    startedAt: NOW,
    updatedAt: NOW,
    ...fields,
  };
}

const LIST: HistorySession[] = [
  session({ sessionId: "git", title: "fix the git panel counts", updatedAt: NOW - DAY }),
  session({
    sessionId: "notes",
    title: "write release notes",
    cwd: "/work/novel",
    agent: "codex",
    model: "gpt-5.6-terra",
    effort: "medium",
    updatedAt: NOW - 2 * DAY,
  }),
  session({ sessionId: "panel", title: "panel resizing is janky", updatedAt: NOW - 30 * DAY }),
  session({ sessionId: "login", title: "add a login page", cwd: "/work/app-v2" }),
];

/** The ids that come back, in the order they come back. */
const found = (query: string, options = {}) =>
  searchSessions(LIST, query, { now: NOW, ...options }).map((h) => h.session.sessionId);

describe("searchSessions", () => {
  it("shows the most recent sessions when nothing has been typed", () => {
    // Opening the panel and being shown nothing would be the common case: most
    // of the time the session wanted is one of the last few.
    expect(found("")).toEqual(["login", "git", "notes", "panel"]);
  });

  it("finds a session by a word in what was first asked", () => {
    expect(found("panel")).toEqual(["git", "panel"]);
  });

  it("requires every word to match, because typing more must narrow", () => {
    expect(found("panel git")).toEqual(["git"]);
    expect(found("panel kubernetes")).toEqual([]);
  });

  it("ranks a word start above the same letters inside a word", () => {
    // "login" starts a word; "panel resizing" contains no "log" at all. The
    // pairing that matters is elsewhere — see the folder test below.
    expect(found("log")).toEqual(["login"]);
  });

  it("searches the folder, the agent and the model as well as the title", () => {
    expect(found("novel")).toEqual(["notes"]);
    expect(found("codex")).toEqual(["notes"]);
    expect(found("gpt-5.6")).toEqual(["notes"]);
  });

  it("still finds a session from the shape of a phrase", () => {
    // "pnl" appears in neither title as a run of letters — only in order.
    expect(found("pnl")).toEqual(["git", "panel"]);
  });

  it("narrows to one agent when asked", () => {
    expect(found("", { agent: "codex" })).toEqual(["notes"]);
    expect(found("", { agent: "claude" })).toEqual(["login", "git", "panel"]);
  });

  it("keeps only sessions from this project when scoped to a folder", () => {
    // `/work/app-v2` is a DIFFERENT project, not a folder inside `/work/app`.
    expect(found("", { cwd: "/work/app" })).toEqual(["git", "panel"]);
  });

  it("says where the match was, so the row can show it", () => {
    const [hit] = searchSessions(LIST, "git", { now: NOW });
    expect(hit.ranges).toEqual([[8, 11]]);
    expect(hit.session.title.slice(8, 11)).toBe("git");
  });

  it("breaks a tie towards the session touched most recently", () => {
    // Both titles match "panel" the same way; only their age differs.
    expect(found("panel")).toEqual(["git", "panel"]);
  });
});

describe("isUnder", () => {
  it("counts the folder itself", () => {
    expect(isUnder("/work/app", "/work/app")).toBe(true);
    expect(isUnder("/work/app/", "/work/app")).toBe(true);
  });

  it("counts a folder inside it", () => {
    expect(isUnder("/work/app/web", "/work/app")).toBe(true);
  });

  it("does NOT count a sibling whose name merely starts the same", () => {
    expect(isUnder("/work/app-v2", "/work/app")).toBe(false);
  });

  it("is false when either side is missing", () => {
    expect(isUnder("", "/work/app")).toBe(false);
    expect(isUnder("/work/app", "")).toBe(false);
  });
});

describe("folderName", () => {
  it("is the last part, with or without a trailing slash", () => {
    expect(folderName("/work/app")).toBe("app");
    expect(folderName("/work/app/")).toBe("app");
  });
});

describe("whenLabel", () => {
  it("reads in short words at every distance", () => {
    expect(whenLabel(NOW - 30_000, NOW)).toBe("just now");
    expect(whenLabel(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(whenLabel(NOW - 5 * 60 * 60_000, NOW)).toBe("5h ago");
    expect(whenLabel(NOW - 1.5 * DAY, NOW)).toBe("yesterday");
    expect(whenLabel(NOW - 3 * DAY, NOW)).toBe("3d ago");
  });
});

// The point of `replaySession` is that there is NO second message format: the
// backend hands back the same events a live agent sends, and they fold through
// the very same reducer. These say so.
describe("replaySession", () => {
  /** A message's words, from whichever blocks carry any. */
  const textOf = (m: { blocks: { kind: string; text?: string }[] }) =>
    m.blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.text ?? "")
      .join("");

  // Content is ALWAYS a block list here. Claude's own file writes a plain user
  // turn as a bare string, but `agent_history.rs::normalise_content` widens it
  // before it leaves the backend, precisely so this side never has to know.
  const said = (role: "user" | "assistant", text: string) => ({
    type: role,
    message: { role, content: [{ type: "text", text }] },
  });

  it("folds a past session into readable messages, in the order they were said", () => {
    const chat = replaySession([
      said("user", "fix the login bug"),
      said("assistant", "on it"),
      said("user", "thanks"),
    ]);
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(textOf(chat.messages[0])).toContain("fix the login bug");
    expect(textOf(chat.messages[1])).toContain("on it");
  });

  it("is not left waiting for an answer that already came", () => {
    // A live turn ends on `result`, which a FILE never has — the session simply
    // stops. Without this the chat would show the working spinner for a
    // conversation that finished days ago.
    const chat = replaySession([said("user", "hello"), said("assistant", "hi")]);
    expect(chat.busy).toBe(false);
  });

  it("survives an empty session and a line the reducer knows nothing about", () => {
    expect(replaySession([]).messages).toEqual([]);
    const chat = replaySession([{ type: "nonsense-nobody-writes" }, said("user", "hi")]);
    expect(chat.messages).toHaveLength(1);
  });
});
