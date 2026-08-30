// When a notification is owed, and what it says.
//
// The two halves of the feature that can be tested without a browser: the rule
// that decides whether you were watching, and the words the notification is
// built from. `show()` is not here — it is the one line that touches the
// Notification constructor, and there is no DOM in this runner.
import { describe, expect, it } from "vitest";

import { bannerTitle, isWatching, lastSaid, noticeFor, owed, preview } from "./notify";

const HERE = { hidden: false, focused: true, reading: "chat-1" };

describe("isWatching", () => {
  it("is true only with the chat on screen in a focused, visible tab", () => {
    expect(isWatching(HERE, "chat-1")).toBe(true);
  });

  it("is false when the tab is hidden", () => {
    expect(isWatching({ ...HERE, hidden: true }, "chat-1")).toBe(false);
  });

  it("is false when the window has lost focus", () => {
    expect(isWatching({ ...HERE, focused: false }, "chat-1")).toBe(false);
  });

  it("is false when another chat is on screen", () => {
    expect(isWatching(HERE, "chat-2")).toBe(false);
  });

  it("is false when nothing is on screen", () => {
    expect(isWatching({ ...HERE, reading: null }, "chat-1")).toBe(false);
  });
});

describe("owed", () => {
  const ON = { enabled: true, permission: "granted" as const };

  it("is owed for a chat you are not looking at", () => {
    expect(owed(ON, HERE, "chat-2")).toBe(true);
  });

  it("is owed for the chat on screen once the window is behind something", () => {
    expect(owed(ON, { ...HERE, focused: false }, "chat-1")).toBe(true);
  });

  it("is not owed for the chat you are reading", () => {
    expect(owed(ON, HERE, "chat-1")).toBe(false);
  });

  it("is not owed when the setting is off", () => {
    expect(owed({ ...ON, enabled: false }, HERE, "chat-2")).toBe(false);
  });

  it("is not owed until the browser has granted permission", () => {
    expect(owed({ ...ON, permission: "default" }, HERE, "chat-2")).toBe(false);
    expect(owed({ ...ON, permission: "denied" }, HERE, "chat-2")).toBe(false);
  });
});

describe("preview", () => {
  it("collapses the whitespace a transcript is full of", () => {
    expect(preview("Done.\n\n  Two files changed.")).toBe("Done. Two files changed.");
  });

  it("cuts a long answer short rather than filling the banner", () => {
    const long = "x".repeat(300);
    const short = preview(long);
    expect(short.length).toBeLessThanOrEqual(121);
    expect(short.endsWith("…")).toBe(true);
  });

  it("gives nothing back for nothing", () => {
    expect(preview("   ")).toBe("");
  });
});

describe("bannerTitle", () => {
  it("puts the project in front, so a clipped title still says which one", () => {
    expect(bannerTitle("OctiqFlow", "Fix the top bar")).toBe("OctiqFlow · Fix the top bar");
  });

  it("stands on whichever half it has", () => {
    // A chat is untitled until its first turn; a project can be gone or not
    // loaded yet. Either way the banner says what it can rather than trailing
    // a separator with nothing after it.
    expect(bannerTitle("OctiqFlow", "")).toBe("OctiqFlow");
    expect(bannerTitle("", "Fix the top bar")).toBe("Fix the top bar");
    expect(bannerTitle("  ", "  ")).toBe("OctiqFlow");
  });
});

describe("noticeFor", () => {
  it("titles every notice after the project and the chat, so the banner names the work", () => {
    const n = noticeFor({ kind: "done", conversationId: "c1", projectName: "OctiqFlow", chatTitle: "Fix the top bar", detail: "All three tests pass." });
    expect(n.title).toBe("OctiqFlow · Fix the top bar");
    expect(n.body).toBe("All three tests pass.");
  });

  it("says the turn ended even when the agent left no words", () => {
    const n = noticeFor({ kind: "done", conversationId: "c1", projectName: "OctiqFlow", chatTitle: "Fix the top bar", detail: "" });
    expect(n.body).toBe("Finished.");
  });

  it("marks a permission ask as needing you", () => {
    const n = noticeFor({ kind: "permission", conversationId: "c1", projectName: "OctiqFlow", chatTitle: "Fix the top bar", detail: "Edit — web/src/App.tsx" });
    expect(n.body).toBe("Needs permission: Edit — web/src/App.tsx");
  });

  it("quotes the question the agent is blocked on", () => {
    const n = noticeFor({ kind: "question", conversationId: "c1", projectName: "OctiqFlow", chatTitle: "Fix the top bar", detail: "Which theme?" });
    expect(n.body).toBe("Asked: Which theme?");
  });

  it("tags one notice per chat per kind, so a second replaces the first", () => {
    const a = noticeFor({ kind: "done", conversationId: "c1", projectName: "P", chatTitle: "One", detail: "a" });
    const b = noticeFor({ kind: "done", conversationId: "c1", projectName: "P", chatTitle: "One", detail: "b" });
    const other = noticeFor({ kind: "permission", conversationId: "c1", projectName: "P", chatTitle: "One", detail: "a" });
    expect(a.tag).toBe(b.tag);
    expect(a.tag).not.toBe(other.tag);
  });

  it("names an untitled chat after its project rather than showing an empty banner", () => {
    const n = noticeFor({ kind: "done", conversationId: "c1", projectName: "OctiqFlow", chatTitle: "", detail: "hi" });
    expect(n.title).toBe("OctiqFlow");
  });

  it("falls back to the app's own name when it knows neither", () => {
    const n = noticeFor({ kind: "done", conversationId: "c1", projectName: "", chatTitle: "", detail: "hi" });
    expect(n.title).toBe("OctiqFlow");
  });
});

describe("lastSaid", () => {
  const said = (role: "user" | "assistant", ...texts: string[]) =>
    ({ id: role + texts.join(), role, streaming: false, blocks: texts.map((text) => ({ kind: "text" as const, text })) }) as never;

  it("takes the agent's closing words, not yours", () => {
    expect(lastSaid([said("assistant", "Done."), said("user", "thanks")])).toBe("Done.");
  });

  it("joins the paragraphs of one answer", () => {
    expect(lastSaid([said("assistant", "Done.", "Two files changed.")])).toBe("Done. Two files changed.");
  });

  it("walks back past a turn that was all tool calls", () => {
    const toolOnly = { id: "t", role: "assistant", streaming: false, blocks: [{ kind: "tool", id: "1", name: "Bash", argsJson: "", args: null, state: "done" }] } as never;
    expect(lastSaid([said("assistant", "Looking now."), toolOnly])).toBe("Looking now.");
  });

  it("gives nothing back for a chat with no answer in it", () => {
    expect(lastSaid([said("user", "hello")])).toBe("");
  });
});
