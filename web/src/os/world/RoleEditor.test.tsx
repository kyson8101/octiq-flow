import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RoleEditor } from "./RoleEditor";
import type { RecruitmentDraft, World } from "./types";

const draft: RecruitmentDraft = {
  id: "draft",
  orgId: "org",
  recruiterId: "recruiter",
  professionId: "tester",
  targetAgentId: null,
  brief: "Test mobile negative paths",
  professionName: "Tester",
  professionGuidance: "Test honestly",
  status: "generating",
  prompt: "",
  error: null,
  createdAt: 1,
};
const render = (drafts: RecruitmentDraft[], targetAgentId?: string) =>
  renderToStaticMarkup(
    <RoleEditor
      world={{ recruitmentDrafts: drafts } as World}
      orgId="org"
      professionId="tester"
      targetAgentId={targetAgentId}
      value="Existing prompt"
      onChange={vi.fn()}
      mutate={vi.fn()}
      busy={false}
    />,
  );
describe("recruiter role editor", () => {
  it("restores in-flight work and offers cancellation without losing the prompt", () => {
    const html = render([draft]);
    expect(html).toContain("Recruiter is polishing…");
    expect(html).toContain("Cancel polishing");
    expect(html).toContain("Existing prompt");
    expect(html).toContain("Test mobile negative paths");
  });
  it("does not restore another organization or another agent's draft", () => {
    const html = render(
      [
        { ...draft, orgId: "private-org" },
        { ...draft, targetAgentId: "other-agent" },
      ],
      "this-agent",
    );
    expect(html).not.toContain("Test mobile negative paths");
    expect(html).not.toContain("Recruiter is polishing…");
  });
  it("keeps completed drafts available for deliberate reuse", () => {
    const html = render([
      { ...draft, status: "ready", prompt: "Polished role" },
    ]);
    expect(html).toContain("Saved recruiter drafts");
    expect(html).toContain("ready · Test mobile negative paths");
    expect(html).not.toContain("Cancel polishing");
  });
});
