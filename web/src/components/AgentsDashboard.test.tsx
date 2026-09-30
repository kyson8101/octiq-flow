import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AgentMeta, AgentsDashboard } from "./AgentsDashboard";

const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("Agents page rows", () => {
  it("says what an agent runs on, how hard, where, and who it reports to", () => {
    const html = renderToStaticMarkup(createElement(AgentMeta, { row: {
      detail: "Claude Sonnet 5.5", effort: "high", scope: { id: "p1", name: "octiq-flow" },
      reportsTo: { id: "ada", name: "Ada" }, removed: false,
    } }));
    expect(text(html)).toBe("Claude Sonnet 5.5 · high · octiq-flow · Reports to Ada");
    // Each part wraps whole; the separators are not read out.
    expect(html.match(/class="dash-meta-part"/g)).toHaveLength(4);
    expect(html.match(/aria-hidden="true"> · </g)).toHaveLength(3);
  });

  it("leaves out what an agent does not have", () => {
    const html = renderToStaticMarkup(createElement(AgentMeta, { row: {
      detail: "Codex gpt-5.5", effort: null, scope: null, reportsTo: null, removed: false,
    } }));
    expect(text(html)).toBe("Codex gpt-5.5 · All projects");
  });

  it("says a removed agent is no longer registered, once", () => {
    const html = renderToStaticMarkup(createElement(AgentMeta, { row: {
      detail: "No longer registered", effort: null, scope: null, reportsTo: null, removed: true,
    } }));
    expect(text(html)).toBe("No longer registered");
  });

  it("keeps Manage agents in the page's own header when it has no top bar to write into", () => {
    const html = renderToStaticMarkup(createElement(AgentsDashboard, {
      snapshot: null, ledgerError: null, connected: false, projects: [], running: new Set<string>(), busy: new Set<string>(),
      waitingOn: () => 0, chatTitle: () => undefined, chatExists: () => false,
      onOpenChat: () => {}, onOpenRun: () => {}, onManage: () => {}, onClose: () => {},
    }));
    expect(html).toContain('<div class="workspace-actions"><button type="button" class="projects-page-secondary">Manage agents</button></div>');
    expect(html).toContain('<div class="dash-top">');
    expect(html.match(/Manage agents/g)).toHaveLength(1);
  });
});
