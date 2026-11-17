import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: (...args: unknown[]) => invoke(...args) } }));
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { InlineAgentRow, TeamForm, teamDraftFields } from "./AgentsSettings";
import { saveTeamAgent, type TeamDraft } from "../lib/agentsMode";

const noop = () => {};
const draft = (over: Partial<TeamDraft> = {}): TeamDraft => ({
  name: "Social", role: "", agent: "codex", model: "gpt-5.6-terra", effort: "medium", access: "auto",
  projectId: null, reportsTo: null, teamId: null, ...over,
});
const form = (d: TeamDraft) => renderToStaticMarkup(createElement(TeamForm, {
  draft: d, team: [], teams: [], projects: [], saving: false, onChange: noop, onSave: noop, onCancel: noop,
}));
const row = (d: TeamDraft) => renderToStaticMarkup(createElement("table", null, createElement("tbody", null, createElement(InlineAgentRow, {
  draft: d, depth: 0, team: [], teams: [], projects: [], saving: false, onChange: noop, onSave: noop, onCancel: noop, onDetails: noop,
}))));

describe("browser and computer use for a Codex agent's workers", () => {
  it("is a switch, off by default, on Codex agents only, in both forms", () => {
    for (const draw of [form, row]) {
      const off = draw(draft());
      expect(off).toContain('aria-label="Keep my browser and computer use"');
      expect(off).not.toContain('checked=""');
      expect(draw(draft({ desktopTools: true }))).toContain('checked=""');
      expect(draw(draft({ agent: "claude", model: "sonnet" }))).not.toContain("Keep my browser and computer use");
    }
  });

  it("is switched off when the agent leaves Codex, because the host refuses it elsewhere", () => {
    const changes: TeamDraft[] = [];
    const { pickProvider } = teamDraftFields(draft({ desktopTools: true }), [], [], (next) => changes.push(next));
    pickProvider("claude");
    expect(changes[0].desktopTools).toBe(false);
    pickProvider("codex");
    expect(changes[1].desktopTools).toBe(true);
  });

  it("is sent to the host as the draft says", async () => {
    invoke.mockClear();
    await saveTeamAgent(draft({ desktopTools: true }));
    expect(invoke).toHaveBeenCalledWith("team_save", { agent: expect.objectContaining({ desktopTools: true }) });
  });
});
