// The folded row, as it actually reaches the page.
//
// `groupSummary` is tested on its own in lib/toolGroups.test.ts. These checks
// cover the wiring that keeps the compact row honest: it names what happened,
// counts the whole run, and leaves the exact paths behind its disclosure.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Tool } from "../lib/toolGroups";
import { ToolGroup } from "./ToolGroup";

const read = (id: string, file_path: string): Tool => ({
  kind: "tool",
  id,
  name: "Read",
  argsJson: "",
  args: { file_path },
  state: "done",
});

const write = (id: string, file_path: string, content: string): Tool => ({
  kind: "tool",
  id,
  name: "Write",
  argsJson: "",
  args: { file_path, content },
  state: "done",
});

const bash = (id: string, command: string): Tool => ({
  kind: "tool",
  id,
  name: "Bash",
  argsJson: "",
  args: { command },
  state: "done",
});

const failedBash = (id: string, command: string): Tool => ({
  ...bash(id, command),
  state: "error",
  result: "exit code 1",
});

/** The turn from the screenshot this change came out of: read, edit, read,
 *  edit, then the tests. Before edits folded it was eight cards in a column. */
const run = [
  read("1", "/Users/k/octiq/web/src/lib/chat.ts"),
  write("2", "/Users/k/octiq/web/src/lib/chat.ts", "one\ntwo\nthree\n"),
  read("3", "/Users/k/octiq/web/src/lib/chat.ts"),
  write("4", "/Users/k/octiq/web/src/lib/chat.ts", "one\ntwo\n"),
];

const html = () =>
  renderToStaticMarkup(<ToolGroup tools={run} newest={bash("5", "pnpm vitest run")} />);

describe("a run with edits folded into it", () => {
  it("describes the work as a compact action sentence", () => {
    const markup = html();
    expect(markup).toContain("Edited files");
    expect(markup).toContain("ran a command");
  });

  it("keeps counts in its disclosure label, not in the settled activity line", () => {
    // Finished activity is just the short sentence. The exact call total is
    // still available to a reader who hovers or opens the disclosure.
    const markup = html();
    expect(markup).toContain('title="Show all 5 calls"');
    expect(markup).not.toContain(">5</span>");
  });

  it("keeps the compact row clear of repeated paths and raw tool names", () => {
    expect(html()).not.toContain("/Users/k/octiq/web/src/lib");
    expect(html()).not.toContain("Write");
  });

  it("says nothing about working once every call in the run has finished", () => {
    // What a reloaded transcript renders: no call is in flight, so the row is
    // history and must not spin or claim to be working.
    const markup = html();
    expect(markup).not.toContain("Working");
    expect(markup).not.toContain('aria-label="running"');
  });

  it("does not flash live detail while a new call is under two seconds old", () => {
    const markup = renderToStaticMarkup(
      <ToolGroup tools={run} newest={{ ...bash("5", "pnpm vitest run"), state: "running" }} />,
    );
    // Static markup is the first frame, before the delayed hook's two-second
    // timer may reveal the live command and its spinner.
    expect(markup).not.toContain("pnpm vitest run");
    expect(markup).not.toContain('aria-label="running"');
  });
});

describe("a run containing failed calls", () => {
  it("groups failures but keeps both outcome counts visible", () => {
    const markup = renderToStaticMarkup(
      <ToolGroup
        tools={[
          failedBash("1", "npm test -- --runInBand"),
          bash("2", "npm run lint"),
          failedBash("3", "npm run type-check"),
        ]}
        newest={failedBash("4", "npm run build")}
      />,
    );

    expect(markup).toContain("ran 4 commands");
    expect(markup).toContain("1 ok");
    expect(markup).toContain("3 failed");
    expect(markup).toContain('title="Show all 4 calls"');
    expect(markup).toContain("tool-error");
  });

  it("shows the successful calls beside a single failure", () => {
    const markup = renderToStaticMarkup(
      <ToolGroup tools={[bash("1", "npm run lint")]} newest={failedBash("2", "npm test")} />,
    );

    expect(markup).toContain("1 ok");
    expect(markup).toContain("1 failed");
  });
});

describe("failures say whose they were", () => {
  const agentUpdate = (id: string, outcome?: Tool["outcome"]): Tool => ({
    kind: "tool",
    id,
    name: "mcp__octiq__agent_update",
    argsJson: "",
    args: { agent: "Nova" },
    state: "error",
    ...(outcome ? { outcome } : {}),
  });
  const expired = { origin: "octiqflow", reasonClass: "approval-expired", severity: "warning" } as const;
  const codexLimit = { origin: "provider", reasonClass: "rate-limit", providerName: "Codex", severity: "warning" } as const;
  const claudeAuth = { origin: "provider", reasonClass: "auth", providerName: "Claude", severity: "error" } as const;

  it("collapses seven expired cards to one short line naming OctiqFlow, and nothing more", () => {
    const markup = renderToStaticMarkup(
      <ToolGroup
        tools={[bash("1", "ls"), bash("2", "pwd"), bash("3", "git status"), ...[4, 5, 6, 7, 8, 9].map((n) => agentUpdate(String(n), expired))]}
        newest={agentUpdate("10", expired)}
      />,
    );
    expect(markup).toContain("3 ok");
    expect(markup).toContain("7 not answered (OctiqFlow)");
    // The phone's short form: one count per origin.
    expect(markup).toContain('<span class="tool-result-short">');
    expect(markup).toContain(">7 OctiqFlow<");
    expect(markup).not.toMatch(/>\d+ failed/);
    // A run whose failures are all warnings is not painted as broken.
    expect(markup).toContain("is-warning");
    expect(markup).toContain('data-severity="warning"');
    // The collapsed line names no reason class and no badge: those are inside.
    expect(markup).not.toContain("approval expired");
    expect(markup).not.toContain("tool-outcome");
  });

  it("keeps the provider's apart without naming the provider", () => {
    const markup = renderToStaticMarkup(
      <ToolGroup
        tools={[bash("1", "ls"), agentUpdate("2", expired), agentUpdate("3", codexLimit)]}
        newest={agentUpdate("4", claudeAuth)}
      />,
    );
    expect(markup).toContain("1 ok");
    expect(markup).toContain("1 not answered (OctiqFlow)");
    expect(markup).toContain("1 rate-limited (provider)");
    expect(markup).toContain("1 failed (provider)");
    expect(markup).not.toContain("Codex");
    expect(markup).not.toContain("Claude");
    // One real error among them, so the run is not a warning-only run.
    expect(markup).not.toContain("is-warning");
  });

  it("draws an old run with no outcomes exactly as before", () => {
    const markup = renderToStaticMarkup(
      <ToolGroup tools={[bash("1", "ls")]} newest={agentUpdate("2")} />,
    );
    expect(markup).toContain("1 failed");
    expect(markup).not.toContain("OctiqFlow");
    expect(markup).not.toContain("is-warning");
  });
});
