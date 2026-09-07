import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentInspector } from "./Inspectors";
import type { Agent, Snapshot } from "./types";

vi.mock("../../lib/bridge", () => ({ bridge: { invoke: vi.fn() } }));

const agent: Agent = {
  id: "alex",
  orgId: "studio",
  name: "Alex",
  professionId: "dev",
  provider: "claude",
  model: "test",
  kind: "worker",
  allProjects: true,
  projectIds: [],
  avatar: null,
  appearance: "A friendly fox",
  desk: 0,
};
const snapshot = {
  world: { projects: [], professions: [], memories: [], runs: [] },
  stats: [],
  providers: { image: true, higgsfield: true },
} as unknown as Snapshot;
const render = (member: Agent) =>
  renderToStaticMarkup(
    <AgentInspector
      agent={member}
      initialTab="profile"
      openTask={vi.fn()}
      snapshot={snapshot}
      mutate={vi.fn()}
      busy={false}
      task={vi.fn()}
      meeting={vi.fn()}
    />,
  );

describe("persistent avatar generation", () => {
  it("uses the configured Higgsfield provider in the profile", () => {
    expect(render(agent)).toContain("Generate with Higgsfield");
  });
  it("restores generating state after reopening while keeping task intake available", () => {
    const html = render({
      ...agent,
      avatarGeneration: {
        requestId: "request",
        provider: "Higgsfield",
        status: "generating",
        error: null,
        startedAt: 1,
      },
    });
    expect(html).toMatch(/<button disabled="">Generating…<\/button>/);
    expect(html).toContain("Creating with Higgsfield");
    expect(html).toMatch(/<button class="ow-primary">Give task<\/button>/);
  });
  it("shows a saved failure and enables an explicit retry", () => {
    const html = render({
      ...agent,
      avatarGeneration: {
        requestId: "request",
        provider: "Higgsfield",
        status: "failed",
        error: "Check generation history before retrying.",
        startedAt: 1,
      },
    });
    expect(html).toContain(
      'role="alert">Check generation history before retrying.',
    );
    expect(html).toContain("<button>Generate with Higgsfield</button>");
  });
});
