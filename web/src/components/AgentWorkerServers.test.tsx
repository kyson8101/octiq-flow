// The extra MCP servers an agent's workers get (team.rs `worker_servers`):
// what is typed in Settings → Agents is what the host is sent.
import { describe, expect, it, vi } from "vitest";

vi.mock("react", async (original) =>
  (await import("../lib/__fixtures__/pressTree")).withStubbedHooks(await original<typeof import("react")>()));
const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: (...args: unknown[]) => invoke(...args) } }));

import { byLabel, draw } from "../lib/__fixtures__/pressTree";
import { WorkerServersField } from "./AgentsSettingsBlocks";
import { InlineAgentRow, TeamForm, teamDraftFields } from "./AgentsSettings";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { saveTeamAgent, type TeamDraft } from "../lib/agentsMode";

const LABEL = "Extra MCP servers for this agent's workers";
const draft = (over: Partial<TeamDraft> = {}): TeamDraft => ({
  name: "Maker", role: "", agent: "claude", model: "sonnet", effort: "medium", access: "auto",
  projectId: null, reportsTo: null, teamId: null, ...over,
});

describe("extra MCP servers for an agent's workers", () => {
  it("sends the names typed in the field to the host in team_save", async () => {
    const patches: Partial<TeamDraft>[] = [];
    const tree = draw(WorkerServersField, { draft: draft(), saving: false, set: (patch) => { patches.push(patch); } });
    const onChange = byLabel(tree, LABEL, "input").props.onChange as (event: { target: { value: string } }) => void;
    onChange({ target: { value: " higgsfield, sume,, higgsfield " } });
    expect(patches).toEqual([{ workerServers: ["higgsfield", "sume"] }]);
    invoke.mockClear();
    await saveTeamAgent({ ...draft(), ...patches[0] });
    expect(invoke).toHaveBeenCalledWith("team_save", { agent: expect.objectContaining({ workerServers: ["higgsfield", "sume"] }) });
  });

  it("is a Claude and Codex field of both forms, cleared when the agent moves to another provider", () => {
    const props = { team: [], teams: [], projects: [], saving: false, onChange: () => {}, onSave: () => {}, onCancel: () => {} };
    const forms = (d: TeamDraft) => [
      renderToStaticMarkup(createElement(TeamForm, { ...props, draft: d })),
      renderToStaticMarkup(createElement("table", null, createElement("tbody", null,
        createElement(InlineAgentRow, { ...props, draft: d, depth: 0, onDetails: () => {} })))),
    ];
    for (const html of [...forms(draft()), ...forms(draft({ agent: "codex", model: "gpt-5.6-terra" }))]) {
      expect(html).toContain(`aria-label="${LABEL.replace("'", "&#x27;")}"`);
    }
    for (const html of forms(draft({ agent: "pi", model: "gpt-5.6-sol" }))) expect(html).not.toContain("Extra MCP servers");
    const changes: TeamDraft[] = [];
    const { pickProvider } = teamDraftFields(draft({ workerServers: ["sume"] }), [], [], (next) => changes.push(next));
    pickProvider("codex");
    pickProvider("pi");
    expect(changes.map((next) => next.workerServers)).toEqual([["sume"], []]);
  });
});
