import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));

import { Composer, MODELS } from "./Composer";
import { agentIdentity, type TeamAgent } from "../lib/agentsMode";

const opus = MODELS.find((m) => m.agent === "claude" && m.flag === "opus")!;
const ryan: TeamAgent = {
  id: "agent_ryan", name: "Ryan", role: "CTO", agent: "claude", model: "opus",
  effort: "high", access: "auto", createdAt: 1, updatedAt: 1,
};

const composer = (
  identity: ReturnType<typeof agentIdentity> | null,
  extra: Partial<Parameters<typeof Composer>[0]> = {},
) => renderToStaticMarkup(
  <Composer
    {...extra}
    choice={opus}
    onChoice={() => {}}
    access="auto"
    onAccess={() => {}}
    onSend={() => {}}
    onStop={() => {}}
    busy={false}
    effort="high"
    onEffort={() => {}}
    lite={false}
    onLite={() => {}}
    identity={identity}
  />,
);

describe("the composer in agents mode", () => {
  it("names the agent instead of offering model, access and effort", () => {
    const html = composer(agentIdentity(ryan, "Ryan", opus));
    expect(html).toContain("composer-identity");
    expect(html).toContain(">Ryan<");
    // Role, provider and model are details: in the tooltip, not on the bar.
    expect(html).not.toContain(">CTO<");
    expect(html).not.toContain(`>${opus.model}<`);
    expect(html).toMatch(new RegExp(`title="Ryan\\nCTO\\nClaude ${opus.model}`));
    expect(html).toContain('placeholder="Message Ryan…"');
    expect(html).toContain("agent-avatar-initials");
    expect(html).not.toContain("model-trigger");
    expect(html).not.toContain("eff-btn");
    expect(html).not.toContain("settings-toggle");
    expect(html).not.toContain("perm-auto");
  });

  it("draws the registered avatar when there is one", () => {
    const withFace = { ...ryan, avatar: "data:image/png;base64,AA==" };
    const html = composer(agentIdentity(withFace, "Ryan", opus));
    expect(html).toContain('src="data:image/png;base64,AA=="');
  });

  it("keeps where a new task runs behind Advanced until it is opened", () => {
    const identity = agentIdentity(ryan, "Ryan", opus);
    const location = { showWorkLocation: true, projects: [{ id: "p", name: "octiq-flow" }], projectId: "p" };
    const closed = composer(identity, { ...location, advanced: { open: false, onToggle: () => {}, summary: "New worktree from develop", overridden: false } });
    expect(closed).not.toContain("work-location");
    expect(closed).toContain('aria-label="Where this task runs (Advanced)"');
    expect(closed).toContain("Automatic: New worktree from develop");
    const open = composer(identity, { ...location, advanced: { open: true, onToggle: () => {}, summary: "x", overridden: true } });
    expect(open).toContain("work-location");
    expect(open).toContain("is-overridden");
    // An ordinary chat keeps the location shelf exactly as before.
    expect(composer(null, location)).toContain("work-location");
    expect(composer(null, location)).toContain('placeholder="Ask Claude to…"');
  });

  it("keeps every control in an ordinary chat", () => {
    const html = composer(null);
    expect(html).not.toContain("composer-identity");
    expect(html).toContain("model-trigger");
    expect(html).toContain("eff-btn");
    expect(html).toContain("settings-toggle");
    expect(html).toContain("perm-auto");
  });

  it("says when the conversation's agent is no longer registered", () => {
    const identity = agentIdentity(undefined, "Ryan", opus);
    expect(identity.removed).toBe(true);
    const html = composer(identity);
    expect(html).toContain("data-removed");
    expect(html).toContain("No longer registered");
  });
});
