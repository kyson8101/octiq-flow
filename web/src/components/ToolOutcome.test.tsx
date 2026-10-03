// The badge on one failed call's row, inside the expanded run.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Tool } from "../lib/toolGroups";
import { ToolCard } from "./ToolCard";
import { ToolState } from "./ToolIcon";

describe("a failed row's origin badge", () => {
  it("says OctiqFlow and why, in the warning colour, for an expired card", () => {
    const markup = renderToStaticMarkup(
      <ToolState
        state="error"
        outcome={{ origin: "octiqflow", reasonClass: "approval-expired", severity: "warning" }}
      />,
    );
    expect(markup).toContain('data-origin="octiqflow"');
    expect(markup).toContain('data-severity="warning"');
    expect(markup).toContain(">OctiqFlow<");
    expect(markup).toContain(" · approval expired");
    expect(markup).toContain('title="OctiqFlow · approval expired"');
    expect(markup).not.toContain("failed");
  });

  it("names the provider and its reason for a provider failure", () => {
    const markup = renderToStaticMarkup(
      <ToolState
        state="error"
        outcome={{ origin: "provider", reasonClass: "rate-limit", providerName: "Codex", severity: "warning" }}
      />,
    );
    expect(markup).toContain(">Codex<");
    expect(markup).toContain(" · rate limit");
    const error = renderToStaticMarkup(
      <ToolState
        state="error"
        outcome={{ origin: "provider", reasonClass: "model-unavailable", providerName: "Claude", severity: "error" }}
      />,
    );
    expect(error).toContain('data-severity="error"');
    expect(error).toContain('title="Claude · model unavailable"');
  });

  it("says failed, as before, when the host said nothing", () => {
    expect(renderToStaticMarkup(<ToolState state="error" />)).toBe(
      '<span class="tool-state is-error">failed</span>',
    );
  });

  it("is drawn on the tool card itself", () => {
    const tool: Tool = {
      kind: "tool",
      id: "toolu_1",
      name: "mcp__octiq__agent_update",
      argsJson: "",
      args: { agent: "Nova" },
      state: "error",
      result: "The person did not answer within 180 seconds, so nothing was changed.",
      outcome: { origin: "octiqflow", reasonClass: "approval-denied", severity: "warning" },
    };
    const markup = renderToStaticMarkup(<ToolCard tool={tool} />);
    expect(markup).toContain('title="OctiqFlow · approval denied"');
    // A warning's row is tinted as a warning, not as a breakage.
    expect(markup).toMatch(/class="tool tool-error is-warning/);
    const broken = renderToStaticMarkup(
      <ToolCard tool={{ ...tool, outcome: { origin: "octiqflow", reasonClass: "scope-refused", severity: "error" } }} />,
    );
    expect(broken).not.toContain("is-warning");
  });
});
