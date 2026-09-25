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

const composer = (identity: ReturnType<typeof agentIdentity> | null) => renderToStaticMarkup(
  <Composer
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
    expect(html).toContain(">CTO<");
    expect(html).toContain(opus.model);
    expect(html).not.toContain("model-trigger");
    expect(html).not.toContain("eff-btn");
    expect(html).not.toContain("settings-toggle");
    expect(html).not.toContain("perm-auto");
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
