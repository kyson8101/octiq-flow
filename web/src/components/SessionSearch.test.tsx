import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The history module talks to the server; nothing here should.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { SessionWhere } from "./SessionSearch";
import type { HistorySession } from "../lib/history";

const session = (over: Partial<HistorySession> = {}): HistorySession => ({
  agent: "claude",
  sessionId: "s1",
  title: "Fix the rail",
  cwd: "/Users/someone/octiq-flow",
  startedAt: 0,
  updatedAt: 0,
  ...over,
});

/** The model as the history row says it, with the folder and dots taken off. */
const said = (model: string) =>
  renderToStaticMarkup(<SessionWhere session={session({ model })} />)
    .replace(/^.*<span class="resume-dot">·<\/span>/, "")
    .replace(/<\/span>$/, "");

describe("SessionWhere, the model a session ran on", () => {
  it("keeps a Claude version, drops a date and never versions an alias", () => {
    expect(said("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(said("claude-opus-5-5")).toBe("Opus 5.5");
    expect(said("claude-sonnet-5")).toBe("Sonnet 5");
    expect(said("claude-opus-4-6")).toBe("Opus 4.6");
    expect(said("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(said("claude-opus-4-5-20251101")).toBe("Opus 4.5");
    expect(said("sonnet")).toBe("Sonnet");
    expect(said("claude-opus-5-1")).toBe("Opus 5.1");
  });

  it("says a Codex model exactly as it did before", () => {
    expect(said("gpt-5.6-terra")).toBe("gpt-5.6");
    expect(said("gpt-6-astra")).toBe("gpt-6");
  });

  it("keeps the folder and the effort around it", () => {
    const out = renderToStaticMarkup(
      <SessionWhere session={session({ model: "claude-sonnet-5-5", effort: "high" })} />,
    );
    expect(out).toContain("<bdi>octiq-flow</bdi>");
    expect(out).toContain("Sonnet 5.5");
    expect(out).toMatch(/high<\/span>$/);
  });
});
