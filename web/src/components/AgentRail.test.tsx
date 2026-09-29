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

describe("AgentRail, which model each agent ran on", () => {
  const modelChips = (models: string[]) => {
    const out = renderToStaticMarkup(
      <AgentRail
        agents={[
          run({
            kind: "local_workflow",
            workers: models.map((model, index) => ({
              id: `a${index}`,
              index,
              label: `agent ${index}`,
              phaseIndex: 0,
              model,
              state: "done",
            })),
          }),
        ]}
      />,
    );
    return [...out.matchAll(/<span class="rail-kind rail-model">([^<]*)<\/span>/g)].map((m) => m[1]);
  };

  it("keeps a Claude version, drops a date and never versions an alias", () => {
    expect(
      modelChips([
        "claude-sonnet-5-5",
        "claude-opus-5-5",
        "claude-sonnet-5",
        "claude-opus-4-6",
        "claude-haiku-4-5-20251001",
        "claude-opus-4-5-20251101",
        "sonnet",
        "claude-opus-5-1",
      ]),
    ).toEqual(["Sonnet 5.5", "Opus 5.5", "Sonnet 5", "Opus 4.6", "Haiku 4.5", "Opus 4.5", "Sonnet", "Opus 5.1"]);
  });

  it("says other models exactly as it did before", () => {
    expect(modelChips(["gpt-5.6-terra", "codex-mini", "inherit"])).toEqual(["gpt", "codex", "inherit"]);
  });
});
