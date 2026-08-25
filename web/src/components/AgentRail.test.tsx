import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentRail, RailButton } from "./AgentRail";
import type { AgentRun } from "../lib/chat";

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: "t1",
  label: "Scan changed DNS UI",
  kind: "local_agent",
  status: "completed",
  tokens: 71_000,
  durationMs: 265_000,
  ...over,
});

/** The column can be put away, which is only true if there is a ✕ on it and a
 *  way back to it — the rail draws itself only when a chat starts an agent, so
 *  a close with no counterpart is a panel that leaves and takes the knowledge
 *  it ever existed with it. */
describe("AgentRail, put away and brought back", () => {
  it("carries a name and a close when it can be closed", () => {
    const out = renderToStaticMarkup(<AgentRail agents={[run()]} onClose={() => {}} />);
    expect(out).toContain("Agents");
    expect(out).toContain("Hide agents");
  });

  it("leaves the close off when there is nothing to close it into", () => {
    const out = renderToStaticMarkup(<AgentRail agents={[run()]} />);
    expect(out).toContain("Agents");
    expect(out).not.toContain("Hide agents");
  });

  it("counts the agents on the bar, and says so in one and in many", () => {
    const one = renderToStaticMarkup(<RailButton count={1} open onToggle={() => {}} />);
    expect(one).toContain("1 agent this chat has started");
    const many = renderToStaticMarkup(<RailButton count={4} open={false} onToggle={() => {}} />);
    expect(many).toContain("4 agents this chat has started");
    // Open is a state you can see, not just one the panel knows.
    expect(one).toContain("is-on");
    expect(many).not.toContain("is-on");
  });

  it("is not on the bar at all until an agent has run", () => {
    expect(renderToStaticMarkup(<RailButton count={0} open onToggle={() => {}} />)).toBe("");
  });
});
