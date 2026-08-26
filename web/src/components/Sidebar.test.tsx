// The project column can be put away, and the control that does it exists only
// where there is a column to put away.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { Conversation } from "../lib/store";
import { Sidebar, type Project } from "./Sidebar";

const projects: Project[] = [{ id: "p1", name: "octiq-flow" }];

const html = (over: { onHide?: () => void } = {}) =>
  renderToStaticMarkup(
    <Sidebar
      projects={projects}
      shelved={[]}
      onShowShelved={() => {}}
      onShowBoard={() => {}}
      onShowAgents={() => {}}
      agentName="Claude"
      conversations={new Map<string, Conversation[]>()}
      currentProject="p1"
      currentConversation={null}
      running={new Set()}
      busy={new Set()}
      expanded={new Set()}
      onToggle={() => {}}
      onPickProject={() => {}}
      onPickConversation={() => {}}
      onNewChat={() => {}}
      onDelete={() => {}}
      onSettings={() => {}}
      onNewProject={() => {}}
      {...over}
    />,
  );

describe("Sidebar", () => {
  it("offers to put the column away when there is a column", () => {
    expect(html({ onHide: () => {} })).toContain('aria-label="Hide projects"');
  });

  it("offers nothing to put away when the sidebar is the drawer", () => {
    // Below 860px the sidebar IS the drawer, and the scrim and the top bar's
    // own title already close it. A third way to shut it is a third control
    // saying the same thing.
    expect(html()).not.toContain('aria-label="Hide projects"');
  });
});
