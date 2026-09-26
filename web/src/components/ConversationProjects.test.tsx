import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConversationProjectInfo } from "../lib/conversationProjects";
import { ConversationProjectAvatar, ConversationProjects } from "./ConversationProjects";

const info = (over: Partial<ConversationProjectInfo>): ConversationProjectInfo => ({
  status: "projects", destinations: [], taskCount: 0, unknownTaskCount: 0, ...over,
});

describe("ConversationProjects", () => {
  it("shows two destination chips, a compact overflow, and task count", () => {
    const html = renderToStaticMarkup(<ConversationProjects projects={[]}
      info={info({ taskCount: 4, destinations: [
        { projectId: "one", projectName: "OctiqFlow", repository: "/one" },
        { projectId: "two", projectName: "Starfall", repository: "/two" },
        { projectId: "three", projectName: "Archive", repository: "/three" },
      ] })} />);
    expect(html).toContain(">OctiqFlow</span>");
    expect(html).toContain(">Starfall</span>");
    expect(html).not.toContain(">Archive</span>");
    expect(html).toContain(">+1</span>");
    expect(html).toContain(">4 tasks</span>");
    expect(html).toContain("OctiqFlow, Starfall, Archive");
  });

  it("prefers the current project name and discloses unconfirmed destinations", () => {
    const html = renderToStaticMarkup(<ConversationProjects projects={[{ id: "one", name: "Renamed" }]}
      info={info({ taskCount: 2, unknownTaskCount: 1, destinations: [
        { projectId: "one", projectName: "Old name", repository: "/one" },
      ] })} />);
    expect(html).toContain(">Renamed</span>");
    expect(html).toContain(">+?</span>");
    expect(html).toContain("1 task has no confirmed project");
  });

  it("names discussion, loading, and unknown states without inventing a project", () => {
    expect(renderToStaticMarkup(<ConversationProjects projects={[]} info={info({ status: "discussion" })} />)).toContain("Discussion");
    expect(renderToStaticMarkup(<ConversationProjects projects={[]} info={info({ status: "loading" })} />)).toContain("Projects loading…");
    expect(renderToStaticMarkup(<ConversationProjects projects={[]} info={info({ status: "unknown" })} />)).toContain("Project unknown");
  });

  it("leaves the visible count to a status line that already has one, but keeps it in the label", () => {
    const html = renderToStaticMarkup(<ConversationProjects projects={[]} taskCount={false}
      info={info({ taskCount: 2, destinations: [{ projectId: "one", projectName: "OctiqFlow", repository: "/one" }] })} />);
    expect(html).not.toContain("conversation-project-task-count");
    expect(html).toContain('aria-label="Work projects: OctiqFlow, 2 tasks"');
  });
});

describe("ConversationProjectAvatar", () => {
  const avatar = (status: ConversationProjectInfo["status"]) =>
    renderToStaticMarkup(<ConversationProjectAvatar projects={[]} info={info({ status })} />);

  it("marks a discussion instead of leaving an empty tile", () => {
    expect(avatar("discussion")).toContain("is-discussion");
    expect(avatar("discussion")).toContain("<svg");
  });

  it("stays blank only while the ledger loads, and says ? when the project is unknown", () => {
    expect(avatar("loading")).toMatch(/is-neutral"[^>]*><\/span>$/);
    expect(avatar("unknown")).toContain(">?</span>");
  });
});
