import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentLogo } from "./AgentLogo";

describe("AgentLogo", () => {
  /** The mark stands in for the agent's NAME — beside it the button says only
   *  "Opus" or "Sol", which names the model and not who is running it. So it
   *  carries meaning, and anything carrying meaning has to say so out loud. */
  it("names the agent it stands for", () => {
    expect(renderToStaticMarkup(<AgentLogo agent="claude" />)).toContain('aria-label="Claude"');
    expect(renderToStaticMarkup(<AgentLogo agent="codex" />)).toContain('aria-label="Codex"');
    expect(renderToStaticMarkup(<AgentLogo agent="antigravity" />)).toContain('aria-label="Antigravity"');
    expect(renderToStaticMarkup(<AgentLogo agent="pi" />)).toContain('aria-label="pi.dev"');
  });

  it("draws a different mark for each agent", () => {
    const claude = renderToStaticMarkup(<AgentLogo agent="claude" />);
    const codex = renderToStaticMarkup(<AgentLogo agent="codex" />);
    const antigravity = renderToStaticMarkup(<AgentLogo agent="antigravity" />);
    const pi = renderToStaticMarkup(<AgentLogo agent="pi" />);
    expect(new Set([claude, codex, antigravity, pi]).size).toBe(4);
  });

  /** Toolbar icons here are 14px and sized by their caller, never by a
   *  hardcoded width — the same mark is wanted bigger in the settings sheet. */
  it("takes its size from the caller", () => {
    expect(renderToStaticMarkup(<AgentLogo agent="claude" size={20} />)).toContain('width="20"');
  });
});
