import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({})));
vi.mock("../lib/bridge", () => ({ bridge: { invoke, on: () => () => {} } }));
import { AgentDetailsDialog, agentDetailsPatch, InlineAgentRow, ModelFields, RegisteredAgentsTable, teamDraftFields } from "./AgentsSettings";
import { saveTeamAgent, teamModels, type AgentTeam, type TeamAgent, type TeamDraft } from "../lib/agentsMode";

const agent = (id: string, over: Partial<TeamAgent> = {}): TeamAgent => ({
  id, name: id, role: "Owns the frontend.\nChecks responsive layouts.", persistentPrompt: "Run pnpm test.",
  agent: "claude", model: "sonnet", effort: "medium", access: "auto", createdAt: 1, updatedAt: 1, ...over,
});
const lead = agent("Lead", { model: "fable" });
const report = agent("Report", { reportsTo: lead.id, projectId: "p1", teamId: "web" });
const teams: AgentTeam[] = [{ id: "web", name: "Web", projectId: "p1", createdAt: 1, updatedAt: 1 }];
const projects = [{ id: "p1", name: "OctiqFlow" }, { id: "p2", name: "Other" }];
const noop = () => {};
const props = { team: [lead, report], teams, projects, draft: null, saving: false, onDraft: noop, onSave: noop, onRemove: noop, onDetails: noop };

// Inspect the real stateless row's controls; browser QA exercises mounting,
// modal focus, keyboard input and host refresh through the full App.
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) => isValidElement(child)
    ? [child as ReactElement<Record<string, unknown>>, ...nodes((child.props as { children?: ReactNode }).children)] : []);
}

beforeEach(() => invoke.mockClear());

describe("Registered agents table", () => {
  it("shows every field, hierarchy, tags and a one-line role button", () => {
    const html = renderToStaticMarkup(<RegisteredAgentsTable {...props} />);
    expect(html).toContain('<table class="agents-table" aria-label="Registered agents">');
    for (const column of ["Agent", "Model", "Access", "Reports to", "Available in", "Team", "Role", "Actions"]) {
      expect(html).toContain(`scope="col">${column}</th>`);
    }
    expect(html).toContain("--team-depth:1");
    expect(html).toContain("lead only");
    expect(html).toContain("team-badge");
    expect(html).toContain('data-label="Reports to">Lead</td>');
    expect(html).toContain('data-label="Available in">OctiqFlow</td>');
    expect(html).toContain("Edit role, prompt and avatar for Report");
    expect(html).not.toContain("Run pnpm test.");
    expect(html).not.toContain("<textarea");
  });

  it("starts editing from all stored values and keeps another row disabled", () => {
    const onDraft = vi.fn();
    const tree = RegisteredAgentsTable({ ...props, onDraft });
    const edit = nodes(tree).find((node) => node.props["aria-label"] === "Edit Report")!;
    (edit.props.onClick as () => void)();
    expect(onDraft).toHaveBeenCalledWith({ ...report, reportsTo: "Lead", projectId: "p1", teamId: "web" });
    const html = renderToStaticMarkup(<RegisteredAgentsTable {...props} draft={report} />);
    expect(html.match(/class="agents-edit-row"/g)).toHaveLength(1);
    expect(html).toMatch(/disabled="" aria-label="Edit Lead"/);
    expect(html).not.toContain("<textarea");
  });

  it("adds a blank row before saved agents, and retains a draft across roster refresh/removal", () => {
    const draft: TeamDraft = { ...report, id: undefined, name: "" };
    const html = renderToStaticMarkup(<RegisteredAgentsTable {...props} draft={draft} />);
    expect(html.indexOf('aria-label="New agent"')).toBeLessThan(html.indexOf('aria-label="Edit Lead"'));
    const refreshed = renderToStaticMarkup(<RegisteredAgentsTable {...props} team={[lead]} draft={{ ...report, name: "Unsaved" }} />);
    expect(refreshed).toContain('value="Unsaved"');
    expect(refreshed).toContain('aria-label="Editing Unsaved"');
  });

  it("saves the edited row payload and cancels without saving", async () => {
    let draft: TeamDraft = { ...report };
    const onSave = vi.fn(() => saveTeamAgent(draft));
    const onCancel = vi.fn();
    const row = () => InlineAgentRow({ ...props, draft, depth: 1, onChange: (next) => { draft = next; }, onSave, onCancel });
    const name = nodes(row()).find((node) => node.type === "input")!;
    (name.props.onChange as (event: unknown) => void)({ target: { value: "OCTIQ FE" } });
    const model = nodes(row()).find((node) => node.type === ModelFields)!;
    (model.props.onProvider as (value: string) => void)("codex");
    const save = nodes(row()).find((node) => node.type === "button" && node.props.children === "Save")!;
    await (save.props.onClick as () => Promise<unknown>)();
    expect(invoke).toHaveBeenLastCalledWith("team_save", { agent: {
      ...report, name: "OCTIQ FE", agent: "codex", model: teamModels("codex")[0].flag,
    } });
    invoke.mockClear();
    const cancel = nodes(row()).find((node) => node.type === "button" && node.props.children === "Cancel")!;
    (cancel.props.onClick as () => void)();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("filters descendants and invisible managers; changing project clears incompatible teams", () => {
    const below = agent("Below", { reportsTo: report.id, projectId: "p1" });
    const hidden = agent("Hidden", { projectId: "p2" });
    const change = vi.fn();
    const fields = teamDraftFields(report, [lead, report, below, hidden], teams, change);
    expect(fields.managers.map((item) => item.id)).toEqual(["Lead"]);
    fields.pickProject("p2");
    expect(change).toHaveBeenCalledWith({ ...report, projectId: "p2", teamId: null });
    fields.pickProvider("antigravity");
    expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ agent: "antigravity", model: teamModels("antigravity")[0].flag }));
    const html = renderToStaticMarkup(<table><tbody><InlineAgentRow {...props} draft={{ ...report, agent: "antigravity" }} depth={1} onChange={noop} onCancel={noop} /></tbody></table>);
    expect(html).toContain("team-field-note");
  });

  it("saves on Enter and cancels on Escape, excluding composition, held keys and buttons", () => {
    class Button {}
    vi.stubGlobal("HTMLButtonElement", Button);
    try {
      const onSave = vi.fn();
      const onCancel = vi.fn();
      const row = InlineAgentRow({ ...props, draft: report, depth: 1, onChange: noop, onSave, onCancel });
      const press = (key: string, over = {}) => (row.props.onKeyDown as (event: unknown) => void)({
        key, target: {}, nativeEvent: { isComposing: false }, repeat: false,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over,
      });
      press("Enter");
      expect(onSave).toHaveBeenCalledOnce();
      press("Enter", { repeat: true });
      press("Enter", { target: new Button() });
      press("Enter", { nativeEvent: { isComposing: true } });
      expect(onSave).toHaveBeenCalledOnce();
      press("Escape");
      expect(onCancel).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });
});

describe("Agent details modal", () => {
  it("edits long text and avatar with the prompt limit/hint, saying when changes persist", () => {
    const modal = (staged: boolean) => renderToStaticMarkup(<AgentDetailsDialog draft={report} staged={staged} saving={false} error="" onChange={noop} onSave={noop} onClose={noop} />);
    const html = modal(true);
    expect(html).toContain("<dialog");
    expect(html).toContain("Changes stay in this row until you save the row.");
    expect(html).toContain("Owns the frontend.\nChecks responsive layouts.");
    expect(html).toContain("Run pnpm test.");
    expect(html).toContain("14 / 8,000");
    expect(html).toContain("team-persistent-prompt-hint");
    expect(html).toContain("avatar-editor");
    expect(modal(false)).toContain("Save updates this agent");
  });

  it("limits modal Save to role, prompt and avatar, preserving the current row's other fields", async () => {
    const current = { ...report, name: "Renamed elsewhere", access: "read" as const };
    const edited = { ...report, role: "New role", persistentPrompt: "New runbook", avatar: "" };
    await saveTeamAgent({ ...current, ...agentDetailsPatch(edited) });
    expect(invoke).toHaveBeenLastCalledWith("team_save", { agent: {
      ...current, role: "New role", persistentPrompt: "New runbook", avatar: "",
    } });
  });
});
