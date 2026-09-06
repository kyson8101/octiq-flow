import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SecretaryDesk } from "./Secretary";
import type { Agent, SecretaryDraft, World } from "./types";

const secretary: Agent = {
  id: "secretary",
  orgId: "org",
  name: "Secretary",
  professionId: "secretary-role",
  provider: "codex",
  model: "default",
  kind: "consultant",
  allProjects: false,
  projectIds: [],
  avatar: null,
  appearance: "Friendly owl",
  desk: 0,
};
const draft: SecretaryDraft = {
  id: "draft",
  orgId: "org",
  secretaryId: "secretary",
  message: "Create Project A with QA",
  status: "ready",
  blueprint: {
    summary: "Create a project and its QA delivery path.",
    projects: [{ name: "Project A", context: "Product context" }],
    professions: [{ name: "QA", kind: "tester", guidance: "Test risks" }],
    agents: [{ name: "Quinn", profession: "QA", provider: "codex", model: "default", memberType: "worker", allProjects: false, projects: ["Project A"], appearance: "Fox", rolePrompt: "Test", roleDescription: "QA" }],
    workflows: [{ name: "Review", professions: ["QA"] }],
    questions: [],
    warnings: [],
  },
  error: null,
  baseSignature: 1,
  createdAt: 1,
};
const world = (item: SecretaryDraft): World => ({
  orgs: [{ id: "org", name: "Studio", description: "" }],
  projects: [], professions: [], agents: [secretary], workflows: [], tasks: [], meetings: [],
  secretaryDrafts: [item], memories: [], runs: [], usage: [], xp: [], revision: 1,
});

describe("Secretary reception", () => {
  it("shows a readable inert blueprint and explicit confirmation", () => {
    const html = renderToStaticMarkup(<SecretaryDesk world={world(draft)} orgId="org" secretary={secretary} mutate={vi.fn()} busy={false} />);
    expect(html).toContain("PROPOSED BLUEPRINT");
    expect(html).toContain("Project A");
    expect(html).toContain("Quinn");
    expect(html).toContain("Review");
    expect(html).toContain("Confirm and apply blueprint");
    expect(html).toContain("Nothing changes until you confirm");
  });

  it("blocks confirmation while the Secretary needs a material answer", () => {
    const needsAnswer = { ...draft, blueprint: { ...draft.blueprint!, questions: ["Which project should QA access?"] } };
    const html = renderToStaticMarkup(<SecretaryDesk world={world(needsAnswer)} orgId="org" secretary={secretary} mutate={vi.fn()} busy={false} />);
    expect(html).toContain("Your Secretary needs a decision");
    expect(html).toContain("Which project should QA access?");
    expect(html).toMatch(/disabled=""[^>]*>Confirm and apply blueprint/);
  });
});
