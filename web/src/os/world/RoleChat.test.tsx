import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RoleChat } from "./RoleChat";
import { AgentForm } from "./Forms";
import type { Agent, World } from "./types";

const agent: Agent = {
  id: "alex",
  orgId: "a",
  name: "Alex",
  professionId: "dev",
  provider: "codex",
  model: "default",
  kind: "worker",
  allProjects: false,
  projectIds: [],
  avatar: null,
  appearance: "",
  desk: 0,
};
const world = {
  agents: [
    agent,
    { ...agent, id: "pm", name: "My PM", professionId: "pm" },
    { ...agent, id: "peer", name: "Another developer" },
    {
      ...agent,
      id: "outsider",
      name: "Other org PM",
      orgId: "b",
      professionId: "pm",
    },
  ],
  professions: [
    { id: "dev", orgId: "a", name: "Developer", kind: "dev", guidance: "" },
    { id: "pm", orgId: "a", name: "PM", kind: "pm", guidance: "" },
  ],
  projects: [],
} as unknown as World;

describe("founder-directed role setup", () => {
  it("offers discussion and a separate explicit update using only eligible helpers", () => {
    const mutate = vi.fn();
    const html = renderToStaticMarkup(
      <RoleChat agent={agent} world={world} mutate={mutate} busy={false} />,
    );
    expect(html).toContain("Discuss only");
    expect(html).toContain("Update role from this message");
    expect(html).toContain("My PM");
    expect(html).not.toContain("Other org PM");
    expect(html).not.toContain("Another developer");
    expect(mutate).not.toHaveBeenCalled();
  });
  it("restores pending work and permits cancellation without inferring permission from its text", () => {
    const saved = {
      ...world,
      roleRequests: [
        {
          id: "r",
          agentId: "alex",
          authorId: "alex",
          body: "Update my role",
          mode: "discuss",
          status: "generating",
          reply: "",
          prompt: "",
          description: "",
          error: null,
          createdAt: 0,
        },
      ],
    } as World;
    const html = renderToStaticMarkup(
      <RoleChat agent={agent} world={saved} mutate={vi.fn()} busy={false} />,
    );
    expect(html).toContain("Discussion only");
    expect(html).toContain("Cancel role response");
    expect(html).not.toContain("Role updated");
  });
  it("lets a new hire join with only an optional name and postpones role and runtime setup", () => {
    const html = renderToStaticMarkup(
      <AgentForm
        world={world}
        orgId="a"
        mutate={vi.fn()}
        done={vi.fn()}
        busy={false}
      />,
    );
    expect(html).toContain("Join and talk about role");
    expect(html).toContain("No projects yet");
    expect(html).not.toContain("required=");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('name="model"');
  });
});
