import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));
import { ChoiceCard, FallbackFields } from "./ProviderFallback";

const source = { agent: "claude" as const, model: "opus", effort: "high", access: "manual" as const };
const suggestion = { ...source, agent: "codex" as const, model: "gpt-5.6-terra", effort: "low" };

describe("provider-limit choices", () => {
  it("shows the saved backup and unchanged access, with a cancel action", () => {
    const html = renderToStaticMarkup(createElement(ChoiceCard, { choice: {
      id: "choice", key: "chat:a", label: "Finish the task", source, preferred: suggestion,
      options: [{ agent: "codex", installed: true, limited: false, suggestion }],
    }, onDone: () => {} }));
    expect(html).toContain("Finish the task");
    expect(html).toContain('value="low" selected=""');
    expect(html).toContain("Access stays <strong>manual</strong>");
    expect(html).toContain(">Cancel</button>");
    expect(html).toContain("Continue with selection");
  });
  it("keeps cancel available when all compatible alternatives are limited", () => {
    const html = renderToStaticMarkup(createElement(ChoiceCard, { choice: {
      id: "choice", key: "chat:a", label: "Finish the task", source,
      options: [{ agent: "codex", installed: true, limited: true, suggestion }],
    }, onDone: () => {} }));
    expect(html).toContain("No compatible provider is available");
    expect(html).toMatch(/disabled=""[^>]*>Continue with selection/);
    expect(html).toContain('class="vault-button">Cancel</button>');
  });
  it("uses model-encoded effort for Antigravity", () => {
    const html = renderToStaticMarkup(createElement(FallbackFields, {
      value: { agent: "antigravity", model: "gemini-3.1-pro-high", effort: null }, onChange: () => {},
    }));
    expect(html).toMatch(/Effort<select[^>]*disabled=""/);
    expect(html).toContain("Included in model");
  });
});
