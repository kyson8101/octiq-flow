import { describe, expect, it, vi, beforeEach } from "vitest";

const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({}));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: (...args: unknown[]) => invoke(...args) } }));
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AgentPolicyBlock, CharCounter, TeamForm } from "./AgentsSettings";
import {
  AGENT_POLICY_MAX, PERSISTENT_PROMPT_MAX, ROLE_MAX, charCount, loadAgentPolicy, saveAgentPolicy, saveTeamAgent,
  type TeamDraft,
} from "../lib/agentsMode";

const noop = () => {};

const policyBlock = (over: Partial<Parameters<typeof AgentPolicyBlock>[0]> = {}) =>
  renderToStaticMarkup(createElement(AgentPolicyBlock, {
    saved: "", text: "", loading: false, busy: false, onChange: noop, onSave: noop, onClear: noop, ...over,
  }));

const draft = (over: Partial<TeamDraft> = {}): TeamDraft => ({
  name: "Ada", role: "Reviews code.", agent: "claude", model: "sonnet", effort: "medium", access: "auto",
  projectId: null, reportsTo: null, teamId: null, ...over,
});

const form = (d: TeamDraft) => renderToStaticMarkup(createElement(TeamForm, {
  draft: d, team: [], teams: [], projects: [], saving: false, onChange: noop, onSave: noop, onCancel: noop,
}));

describe("the agent policy editor", () => {
  it("says it is prepended to every agent's brief, and when it applies", () => {
    const html = policyBlock();
    expect(html).toContain("<h3 id=\"agent-policy-title\">Agent policy</h3>");
    expect(html).toContain("Prepended to every agent&#x27;s brief");
    expect(html).toContain("Applies to new chats and tasks.");
    expect(html).toContain(`maxLength="${AGENT_POLICY_MAX}"`);
    expect(html).toContain("0 / 4,000");
  });

  it("saves only a change, and clears only a saved policy", () => {
    // Nothing saved, nothing typed: neither button does anything.
    const empty = policyBlock();
    expect(empty).toMatch(/<button class="vault-button" type="button" disabled="">Clear<\/button>/);
    expect(empty).toMatch(/<button class="settings-primary" type="submit" disabled="">Save policy<\/button>/);
    // Typed and unsaved: Save is live.
    const typed = policyBlock({ text: "Work in a worktree." });
    expect(typed).toMatch(/<button class="settings-primary" type="submit">Save policy<\/button>/);
    expect(typed).toContain("19 / 4,000");
    // Saved and unchanged: Clear is live, Save is not.
    const saved = policyBlock({ saved: "Work in a worktree.", text: "Work in a worktree." });
    expect(saved).toMatch(/<button class="vault-button" type="button">Clear<\/button>/);
    expect(saved).toMatch(/<button class="settings-primary" type="submit" disabled="">Save policy<\/button>/);
    expect(saved).toContain(">Work in a worktree.</textarea>");
  });

  it("refuses to save text over the cap and says so", () => {
    const html = policyBlock({ text: "x".repeat(AGENT_POLICY_MAX + 1) });
    expect(html).toContain("4,001 / 4,000 · too long");
    expect(html).toContain("team-field-count is-over");
    expect(html).toMatch(/type="submit" disabled="">Save policy/);
  });

  it("holds still while it loads or saves", () => {
    expect(policyBlock({ loading: true })).toMatch(/<textarea[^>]*disabled=""/);
    expect(policyBlock({ busy: true, text: "a" })).toContain("Saving…");
  });
});

describe("the persistent prompt field", () => {
  it("sits under the role with its counter and what it is for", () => {
    const html = form(draft({ persistentPrompt: "Run pnpm test before reporting." }));
    const role = html.indexOf("<span>Role</span>");
    const prompt = html.indexOf("<span>Persistent prompt</span>");
    expect(role).toBeGreaterThan(-1);
    expect(prompt).toBeGreaterThan(role);
    expect(html).toContain(`maxLength="${PERSISTENT_PROMPT_MAX}"`);
    expect(html).toContain(`maxLength="${ROLE_MAX}"`);
    expect(html).toContain("31 / 8,000");
    expect(html).toContain(">Run pnpm test before reporting.</textarea>");
    expect(html).toContain("standing instructions");
    expect(html).toContain("never shown in the roster");
    expect(html).toContain("Applies to new chats and tasks.");
  });

  it("starts empty for an agent that has none", () => {
    const html = form(draft());
    expect(html).toContain("0 / 8,000");
    expect(html).toMatch(/aria-describedby="team-persistent-prompt-hint"[^>]*><\/textarea>/);
  });
});

describe("counting characters the way the host does", () => {
  it("counts characters, not UTF-16 units, without the trimmed space", () => {
    expect(charCount("  abc \n")).toBe(3);
    expect(charCount("🙂🙂")).toBe(2);
    expect(renderToStaticMarkup(createElement(CharCounter, { text: "🙂", max: 1 }))).toContain("1 / 1");
  });
});

describe("the agent policy API", () => {
  beforeEach(() => invoke.mockReset());

  it("reads and writes the policy through the team commands", async () => {
    invoke.mockResolvedValueOnce({ text: "Use worktrees.", updatedAt: 5 });
    expect(await loadAgentPolicy()).toEqual({ text: "Use worktrees.", updatedAt: 5 });
    expect(invoke).toHaveBeenLastCalledWith("team_policy", {});

    invoke.mockResolvedValueOnce({ text: "", updatedAt: 6 });
    expect(await saveAgentPolicy("")).toEqual({ text: "", updatedAt: 6 });
    expect(invoke).toHaveBeenLastCalledWith("team_policy_set", { text: "" });
  });

  it("reads an older backend's missing policy as empty", async () => {
    invoke.mockRejectedValueOnce(new Error("'team_policy' is not available on this backend"));
    expect(await loadAgentPolicy()).toEqual({ text: "", updatedAt: 0 });
  });

  it("sends the persistent prompt with the agent, and leaves it out to keep it", async () => {
    invoke.mockResolvedValue({});
    await saveTeamAgent(draft({ persistentPrompt: "Build first." }));
    expect(invoke).toHaveBeenLastCalledWith("team_save", {
      agent: expect.objectContaining({ persistentPrompt: "Build first." }),
    });
    await saveTeamAgent(draft());
    const sent = (invoke.mock.calls.at(-1)?.[1] as { agent: TeamDraft }).agent;
    expect("persistentPrompt" in sent).toBe(false);
  });
});
