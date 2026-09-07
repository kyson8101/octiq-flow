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
const world = (...items: SecretaryDraft[]): World => ({
  orgs: [{ id: "org", name: "Studio", description: "" }],
  projects: [], professions: [], agents: [secretary], workflows: [], tasks: [], meetings: [],
  secretaryDrafts: items, memories: [], runs: [], usage: [], xp: [], revision: 1,
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
    const [conversation, blueprint] = html.split('aria-label="Blueprint preview"');
    expect(conversation).toContain("Which project should QA access?");
    expect(blueprint).not.toContain("Which project should QA access?");
    expect(html).toContain("Reply in conversation");
    expect(html).toMatch(/disabled=""[^>]*>Confirm and apply blueprint/);
  });

  it("restores all org turns in order and previews the latest revision", () => {
    const revised = { ...draft, id: "revised", message: "Use Project B instead", blueprint: { ...draft.blueprint!, summary: "Updated to Project B", projects: [{ name: "Project B", context: "New context" }] } };
    const foreign = { ...draft, id: "foreign", orgId: "other", message: "PRIVATE OTHER ORG" };
    const html = renderToStaticMarkup(<SecretaryDesk world={world(draft, foreign, revised)} orgId="org" secretary={secretary} mutate={vi.fn()} busy={false} />);
    const [conversation, blueprint] = html.split('aria-label="Blueprint preview"');
    expect(conversation.indexOf(draft.message)).toBeLessThan(conversation.indexOf(revised.message));
    expect(html).not.toContain("PRIVATE OTHER ORG");
    expect(html).not.toContain("<select");
    expect(blueprint).toContain("Updated to Project B");
    expect(blueprint).toContain("ow-blueprint-changed");
    expect(blueprint).toContain("LIVE PREVIEW · v2");
  });

  it.each(["queued", "generating", "failed", "cancelled"] as const)("keeps the last preview but prevents applying it after a %s follow-up", (status) => {
    const next = { ...draft, id: "next", message: "Change the team", status, blueprint: null };
    const html = renderToStaticMarkup(<SecretaryDesk world={world(draft, next)} orgId="org" secretary={secretary} mutate={vi.fn()} busy={false} />);
    expect(html).toContain("Quinn");
    expect(html).toContain(next.message);
    expect(html).toMatch(/disabled=""[^>]*>Confirm and apply blueprint/);
    if (["queued", "generating"].includes(status)) {
      expect(html).toContain(">Stop</button>");
      expect(html).toContain("Thinking through your request");
    }
  });

  it("opens an empty conversation with a disabled confirmation", () => {
    const html = renderToStaticMarkup(<SecretaryDesk world={world()} orgId="org" secretary={secretary} mutate={vi.fn()} busy={false} />);
    expect(html).toContain("Start with a conversation.");
    expect(html).toContain("Message your Secretary");
    expect(html).toMatch(/disabled=""[^>]*>Confirm and apply blueprint/);
  });
});
