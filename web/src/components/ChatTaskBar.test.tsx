import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The view is pure, but it shares a file with the half that talks to the
// backend, and the socket opens itself the moment it is imported.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: vi.fn(() => () => {}) } }));

import { ChatTaskBarView } from "./ChatTaskBar";
import type { TaskStatus } from "../lib/chatTask";

const NOW = 1_800_000_000_000;

const status = (over: Partial<TaskStatus> = {}): TaskStatus => ({
  chatId: "c1",
  report: {
    objective: "Keep the chat's task and branch visible",
    nextStep: "Wiring the panel into the top bar",
    steps: [
      { title: "Design", state: "done" },
      { title: "Backend", state: "done" },
      { title: "Client", state: "active" },
      { title: "Tests", state: "pending" },
    ],
    reportedAt: NOW - 12 * 60_000,
    reportedBy: "claude",
  },
  workspace: {
    cwd: "/trees/octiq-flow/feature/chat-context",
    exists: true,
    isRepo: true,
    repoRoot: "/trees/octiq-flow/feature/chat-context",
    primaryRoot: "/repos/octiq-flow",
    branch: "feature/chat-context",
    isWorktree: true,
    changed: 6,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
  },
  delivery: {
    target: "main",
    head: "abc1234",
    onTarget: false,
    commits: 0,
    uncommitted: 6,
    pushed: false,
    merged: false,
    mergedRemote: false,
    released: null,
    releaseNote: "No release check is configured for this project.",
    stale: false,
    checkedAt: NOW - 30_000,
  },
  ...over,
});

const bar = (props: Parameters<typeof ChatTaskBarView>[0]) => renderToStaticMarkup(<ChatTaskBarView {...props} />);

describe("the status line above the chat", () => {
  it("carries the phase, the progress and the branch, and nothing else", () => {
    const html = bar({ status: status(), open: false, now: NOW, onToggle: () => {} });
    expect(html).toContain("To commit");
    expect(html).toContain("2/4");
    expect(html).toContain("feature/chat-context");
    // The panel explains; the bar does not.
    expect(html).not.toContain("Primary checkout");
    expect(html).not.toContain("/repos/octiq-flow");
  });

  it("marks a live turn, and only a live turn, with the accent", () => {
    const working = bar({ status: status(), open: false, now: NOW, busy: true, onToggle: () => {} });
    expect(working).toContain('data-tone="accent"');
    expect(working).toContain("Working");
    const owed = bar({ status: status(), open: false, now: NOW, onToggle: () => {} });
    expect(owed).toContain('data-tone="quiet"');
  });

  it("says a chat needs you above everything else", () => {
    const html = bar({ status: status(), open: false, now: NOW, busy: true, waiting: true, onToggle: () => {} });
    expect(html).toContain("Needs you");
    expect(html).toContain('data-tone="warn"');
  });

  it("opens a panel with the delivery evidence and the paths", () => {
    const html = bar({ status: status(), open: true, now: NOW, onToggle: () => {} });
    expect(html).toContain("Task &amp; workspace");
    expect(html).toContain("Keep the chat&#x27;s task and branch visible");
    expect(html).toContain("Reported by claude 12m ago.");
    expect(html).toContain("6 uncommitted");
    expect(html).toContain("Nothing committed to merge into main yet");
    expect(html).toContain("Unverified");
    expect(html).toContain("No release check is configured");
    expect(html).toContain("Task worktree");
    expect(html).toContain("/trees/octiq-flow/feature/chat-context");
  });

  it("does not invent an objective for a chat that never reported one", () => {
    const html = bar({ status: status({ report: undefined }), open: true, now: NOW, onToggle: () => {} });
    expect(html).toContain("Not reported by the agent");
    expect(html).toContain("Progress is not inferred from the conversation");
  });

  it("still answers after the worktree has been removed", () => {
    const gone = status();
    const html = bar({
      status: {
        ...gone,
        workspace: { ...gone.workspace!, exists: false, changed: 0 },
        delivery: { ...gone.delivery!, uncommitted: 0, commits: 4, merged: true, mergedRemote: true, released: true, stale: true },
      },
      open: true,
      now: NOW,
      onToggle: () => {},
    });
    expect(html).toContain("Task worktree (removed)");
    expect(html).toContain("In origin/main");
    expect(html).toContain("Released");
    expect(html).toContain("read from the primary checkout");
  });

  it("shows nothing verified as unverified rather than as a state", () => {
    const html = bar({ status: { chatId: "c1" }, open: true, now: NOW, onToggle: () => {} });
    expect(html).toContain("Unverified");
    expect(html).not.toContain("Released");
  });
});
