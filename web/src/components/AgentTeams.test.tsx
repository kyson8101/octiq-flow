import { describe, expect, it, vi } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: (...args: unknown[]) => invoke(...args) } }));
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { TeamForm, TeamsBlock } from "./AgentsSettings";
import { PeerHelpLog, peerHelpSummary } from "./PeerHelpLog";
import {
  joinableTeams, saveAgentTeam, saveTeamAgent, teamOf,
  type AgentTeam, type TeamAgent, type TeamDraft,
} from "../lib/agentsMode";
import { taskPeerAsks, type PeerAsk } from "../lib/orchestration";

const web: AgentTeam = { id: "team_web", name: "Web", createdAt: 1, updatedAt: 1 };
const data: AgentTeam = { id: "team_data", name: "Data", projectId: "p1", createdAt: 1, updatedAt: 1 };
const agent = (id: string, over: Partial<TeamAgent> = {}): TeamAgent => ({
  id, name: id.toUpperCase(), role: "", agent: "claude", model: "sonnet", access: "auto", createdAt: 1, updatedAt: 1, ...over,
});
const PROJECTS = [{ id: "p1", name: "octiq-flow" }, { id: "p2", name: "pandahrms" }];
const noop = () => {};

describe("agent teams in Settings", () => {
  it("lists each team with its member count and scope, and offers rename and remove", () => {
    const html = renderToStaticMarkup(createElement(TeamsBlock, {
      teams: [web, data],
      agents: [agent("ada", { teamId: "team_web" }), agent("bo", { teamId: "team_web" }), agent("cy", { teamId: "team_data" }), agent("di")],
      draft: null,
      projects: PROJECTS,
      projectName: (id: string) => PROJECTS.find((p) => p.id === id)?.name,
      onDraft: noop, onSave: noop, onRemove: noop,
    }));
    expect(html).toContain("<h3>Teams</h3>");
    expect(html).toContain("Add team");
    expect(html).toContain("2 agents · Every project");
    expect(html).toContain("1 agent · octiq-flow");
    expect(html).toContain('aria-label="Rename Web"');
    expect(html).toContain('aria-label="Remove team Data"');
    expect(html).toContain("changes no one&#x27;s manager");
    // No editor until one is asked for.
    expect(html).not.toContain('aria-label="Team name"');
  });

  it("opens a new team's editor above the list and a rename in place", () => {
    const props = {
      teams: [web], agents: [], projects: PROJECTS, projectName: () => undefined,
      onDraft: noop, onSave: noop, onRemove: noop,
    };
    const fresh = renderToStaticMarkup(createElement(TeamsBlock, { ...props, draft: { name: "", projectId: null } }));
    expect(fresh).toContain('aria-label="New team"');
    expect(fresh).toMatch(/<button class="settings-primary" type="submit" disabled="">Add<\/button>/);
    const rename = renderToStaticMarkup(createElement(TeamsBlock, { ...props, draft: { id: "team_web", name: "Web", projectId: null } }));
    expect(rename).toContain('aria-label="Rename team"');
    expect(rename).toContain('value="Web"');
    expect(rename).not.toContain('aria-label="Rename Web"');
  });

  it("offers a project agent only global teams and its own project's, with None", () => {
    const draft = (projectId: string | null, teamId: string | null = null): TeamDraft => ({
      name: "Ada", role: "", agent: "claude", model: "sonnet", effort: "medium", access: "auto", projectId, reportsTo: null, teamId,
    });
    const form = (d: TeamDraft) => renderToStaticMarkup(createElement(TeamForm, {
      draft: d, team: [], teams: [web, data, { ...data, id: "team_other", name: "Other", projectId: "p2" }],
      projects: PROJECTS, saving: false, onChange: noop, onSave: noop, onCancel: noop,
    }));
    const inP1 = form(draft("p1", "team_data"));
    expect(inP1).toContain("<span>Team</span>");
    expect(inP1).toContain('<option value="">None</option>');
    expect(inP1).toContain('<option value="team_web">Web</option>');
    expect(inP1).toContain('<option value="team_data" selected="">Data</option>');
    expect(inP1).not.toContain("Other");
    // A global agent may join any team.
    const global = form(draft(null));
    expect(global).toContain(">Other</option>");
    expect(global).toContain('<option value="" selected="">None</option>');
  });

  it("filters joinable teams and finds an agent's team the way the host does", () => {
    const other = { ...data, id: "team_other", projectId: "p2" };
    expect(joinableTeams([web, data, other], "p1").map((t) => t.id)).toEqual(["team_web", "team_data"]);
    expect(joinableTeams([web, data, other], null).map((t) => t.id)).toEqual(["team_web", "team_data", "team_other"]);
    expect(teamOf({ teamId: "team_web" }, [web])).toBe(web);
    expect(teamOf({ teamId: "team_gone" }, [web])).toBeNull();
    expect(teamOf({}, [web])).toBeNull();
  });

  it("always tells the host which team an edited agent is on", async () => {
    invoke.mockClear();
    const base: TeamDraft = { name: "Ada", role: "", agent: "claude", model: "sonnet", access: "auto" };
    await saveTeamAgent({ ...base, teamId: null });
    await saveTeamAgent({ ...base, teamId: "team_web" });
    await saveTeamAgent(base);
    const sent = invoke.mock.calls.map(([, args]) => (args as { agent: TeamDraft }).agent.teamId);
    // null is "take it off" (""), an id puts it on, absent keeps it.
    expect(sent).toEqual(["", "team_web", undefined]);
    await saveAgentTeam({ name: "Web", projectId: "" });
    expect(invoke).toHaveBeenLastCalledWith("agent_team_save", { team: { name: "Web", projectId: null } });
  });
});

const ask = (over: Partial<PeerAsk> = {}): PeerAsk => ({
  id: "peer_1", runId: "run_1", taskId: "t1", attemptId: "att_1",
  asker: { id: "ada", name: "Ada" }, helper: { id: "bo", name: "Bo" },
  helperAgent: "claude", helperModel: "sonnet", helperEffort: "high",
  question: "Which lock guards the ledger?", status: "answered",
  answer: "The store's inner mutex.", usage: { inputTokens: 1200, outputTokens: 300 },
  askedAt: 1_000, answeredAt: 2_000, ...over,
});

describe("peer help in the task view", () => {
  it("keeps a task's own asks, oldest first", () => {
    const asks = [ask({ id: "b", askedAt: 3 }), ask({ id: "x", taskId: "t2" }), ask({ id: "a", askedAt: 2 })];
    expect(taskPeerAsks({ peerAsks: asks }, "t1").map((a) => a.id)).toEqual(["a", "b"]);
    expect(taskPeerAsks({}, "t1")).toEqual([]);
  });

  it("logs who asked whom, the question and the answer behind a disclosure", () => {
    const html = renderToStaticMarkup(createElement(PeerHelpLog, {
      asks: [
        ask({ contextPaths: ["src/a.rs"] }),
        ask({ id: "peer_2", status: "failed", answer: undefined, error: "Not logged in", usage: undefined }),
        ask({ id: "peer_3", status: "asking", answer: undefined, usage: undefined, truncated: false }),
      ],
      ago: () => "just now",
    }));
    expect(html).toMatch(/^<details class="orch-peer-help">/);
    expect(html).not.toContain("<details class=\"orch-peer-help\" open");
    expect(html).toContain("3 questions · 1 waiting");
    expect(html).toContain("<strong><bdi>Ada</bdi></strong> asked <strong><bdi>Bo</bdi></strong>");
    expect(html).toContain("Which lock guards the ledger?");
    expect(html).toContain("The store&#x27;s inner mutex.");
    expect(html).toContain("1.5k tokens");
    expect(html).toContain("<code>src/a.rs</code>");
    expect(html).toContain("Not logged in");
    expect(html).toContain("Waiting for an answer");
    expect(renderToStaticMarkup(createElement(PeerHelpLog, { asks: [], ago: () => "" }))).toBe("");
  });

  it("marks an answer cut at the limit", () => {
    const html = renderToStaticMarkup(createElement(PeerHelpLog, { asks: [ask({ truncated: true })], ago: () => "" }));
    expect(html).toContain("answer cut at the length limit");
    expect(peerHelpSummary([ask()])).toBe("1 question");
  });
});
