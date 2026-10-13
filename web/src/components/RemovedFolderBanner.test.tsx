import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The line is pure, but it shares a file with the half that asks the backend,
// and the socket opens itself the moment it is imported.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn(), on: vi.fn(() => () => {}) } }));

import { RemovedFolderLine } from "./RemovedFolderBanner";
import type { TaskWorkspace } from "../lib/chatTask";
import sheet from "./ChatStatus.css?raw";

const workspace = (over: Partial<TaskWorkspace> = {}): TaskWorkspace => ({
  cwd: "/trees/octiq-flow/feature/chat-context",
  exists: false,
  isRepo: true,
  repoRoot: "/trees/octiq-flow/feature/chat-context",
  primaryRoot: "/repos/octiq-flow",
  branch: "feature/chat-context",
  isWorktree: true,
  changed: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: false,
  ...over,
});

describe("the line that says a chat's folder is gone", () => {
  it("is not drawn while the folder is there, or before anything is known", () => {
    expect(renderToStaticMarkup(<RemovedFolderLine workspace={workspace({ exists: true })} />)).toBe("");
    expect(renderToStaticMarkup(<RemovedFolderLine />)).toBe("");
  });

  it("is one line folded: what happened and what the next message does", () => {
    const html = renderToStaticMarkup(<RemovedFolderLine workspace={workspace()} projectPath="/repos/octiq-flow" />);
    expect(html).toContain('<span class="status-row-label">Worktree removed</span>');
    expect(html).toContain('<span class="status-row-text">next message rebuilds it from its branch</span>');
    // It reports; it does not ask.
    expect(html).toContain('role="status"');
    // The path and the whole sentences are not on the folded row, and not in
    // a tooltip either: a phone has none.
    expect(html).not.toContain("/trees/octiq-flow");
    expect(html).not.toContain("Uncommitted");
    expect(html).not.toContain("title=");
    expect(html).not.toContain("status-row-panel");
  });

  it("has one control, and it only opens the row: nothing here can hold a message back", () => {
    const html = renderToStaticMarkup(<RemovedFolderLine workspace={workspace()} projectPath="/repos/octiq-flow" />);
    expect(html.match(/<button /g)).toHaveLength(1);
    // A button, so a pointer, a finger and the keyboard all reach it.
    const id = /<button type="button" class="status-row-main" aria-expanded="false" aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(id).toBeTruthy();
    const open = renderToStaticMarkup(<RemovedFolderLine open workspace={workspace()} projectPath="/repos/octiq-flow" />);
    expect(open).toContain('aria-expanded="true"');
    expect(open).toMatch(/<div class="status-row-panel" id="[^"]+">/);
  });

  it("opened, gives the whole path and every sentence", () => {
    const html = renderToStaticMarkup(<RemovedFolderLine open workspace={workspace()} projectPath="/repos/octiq-flow" />);
    expect(html).toContain('<p class="chat-folder-gone-path">/trees/octiq-flow/feature/chat-context</p>');
    expect(html).toContain("<p>Your next message rebuilds it from its branch with committed work only.</p>");
    expect(html).toContain("<p>Uncommitted and untracked files are not restored.</p>");
    expect(html).toContain("<p>If it cannot be rebuilt, this chat moves to the project&#x27;s own folder.</p>");
  });

  it("says where a chat that was not in a worktree continues", () => {
    const gone = workspace({ isWorktree: false, cwd: "/repos/old", primaryRoot: "/repos/old" });
    const html = renderToStaticMarkup(<RemovedFolderLine workspace={gone} projectPath="/repos/octiq-flow" />);
    expect(html).toContain('<span class="status-row-label">Folder removed</span>');
    expect(html).toContain('<span class="status-row-text">next message moves this chat to octiq-flow</span>');
    const open = renderToStaticMarkup(<RemovedFolderLine open workspace={gone} projectPath="/repos/octiq-flow" />);
    expect(open).toContain('<p class="chat-folder-gone-path">/repos/old</p>');
    expect(open).toContain("<p>Your next message moves this chat to /repos/octiq-flow.</p>");
  });
});

/* The bug in the person's screenshot: the title was drawn above the box's
   top border and the last word of the hint below its bottom one. The row had
   a `min-height`, which takes the place of a flex item's own minimum, so the
   column squeezed it to that and its wrapped words spilled out. */
describe("a row of the group is never drawn outside itself", () => {
  const code = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
  const body = (selector: string) =>
    [...code.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((rule) => rule[1].trim() === selector)?.[2] ?? "";

  it("cannot be squeezed by the column it sits in", () => {
    expect(body(".chat-status")).toMatch(/flex: 0 0 auto;/);
  });

  it("keeps its words on one line and cuts them inside the row, at any width", () => {
    for (const selector of [".status-row-label", ".status-row-text"]) {
      expect(body(selector), selector).toMatch(/min-width: 0;/);
      expect(body(selector), selector).toMatch(/overflow: hidden;/);
      expect(body(selector), selector).toMatch(/white-space: nowrap;/);
      expect(body(selector), selector).toMatch(/text-overflow: ellipsis;/);
    }
    // The words give way first: the label is cut only once they are gone.
    const shrink = (selector: string) => Number(/flex: 0 (\d+) auto;/.exec(body(selector))?.[1]);
    expect(shrink(".status-row-text")).toBeGreaterThan(shrink(".status-row-label") * 1000);
    // What is opened wraps wherever it must, a path with no space included.
    expect(body(".status-row-panel")).toMatch(/overflow-wrap: anywhere;/);
  });

  it("has no fill and no box of its own, and takes its colours from tokens", () => {
    for (const selector of [".chat-status", ".status-row", ".status-row-main", ".chat-folder-gone"]) {
      expect(body(selector), selector).not.toMatch(/background: (?!transparent)/);
      expect(body(selector), selector).not.toMatch(/border: [1-9]/);
    }
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(code).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch)\(/);
    // A reporting row never takes the accent: that is a turn in flight.
    expect(code).not.toMatch(/var\(--accent/);
  });

  it("brings a row's dismiss with the pointer and the focus, and always on touch", () => {
    expect(body(".status-row-dismiss")).toMatch(/opacity: 0;/);
    expect(code).toMatch(/\.status-row:hover \.status-row-dismiss,\s*\.status-row:focus-within \.status-row-dismiss \{\s*opacity: 1;/);
    // A touch laptop hovers with its trackpad and taps with a finger.
    expect(code).toMatch(/@media \(hover: none\), \(any-pointer: coarse\) \{\s*\.status-row-dismiss \{ opacity: 1; \}/);
  });
});
