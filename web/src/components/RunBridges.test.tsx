import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RunBridges } from "./RunBridges";
import type { OrchestrationRun, RunBridge } from "../lib/orchestration";

const run = (id: string, coordinator: string, extra: Partial<OrchestrationRun> = {}) =>
  ({ id, objective: `Objective ${id}`, coordinatorChatKey: coordinator, status: "running", ...extra }) as OrchestrationRun;
const open = (from: string, to: string, sends = 0): RunBridge => ({
  id: `bridge_${from}_${to}`, fromRunId: from, toRunId: to, fromCoordinatorChatKey: "chat:a",
  toCoordinatorChatKey: "chat:b", openedAt: 1,
  sends: Array.from({ length: sends }, (_, n) => ({ digest: `d${n}`, messageId: `m${n}`, sentAt: n })),
});

const a = run("run_a", "chat:a");
const b = run("run_b", "chat:b");
const draw = (props: { runs: OrchestrationRun[]; bridges?: RunBridge[]; readOnly?: boolean }) => renderToStaticMarkup(
  <RunBridges run={a} snapshot={{ runs: props.runs, bridges: props.bridges }} busy={false}
    readOnly={props.readOnly ?? false} onBridge={() => {}} />);

describe("RunBridges", () => {
  it("draws nothing when there is nothing to show or offer", () => {
    expect(draw({ runs: [a, run("run_s", "chat:a")] })).toBe("");
    expect(draw({ runs: [a, b], readOnly: true })).toBe("");
  });

  it("offers a bridge only as a choice the person still has to open", () => {
    const html = draw({ runs: [a, b] });
    expect(html).toContain("Let this mission&#x27;s main agent send notes to another mission…");
    expect(html).not.toContain("Open bridge");
  });

  it("lists open bridges both ways with their count and a Close", () => {
    const html = draw({ runs: [a, b], bridges: [open("run_a", "run_b", 3), open("run_b", "run_a")] });
    expect(html).toContain("Sends notes to <span class=\"orch-bridge-run\">“Objective run_b”</span>");
    expect(html).toContain("3 of 50 sent");
    expect(html).toContain("Receives notes from <span class=\"orch-bridge-run\">“Objective run_b”</span>");
    expect(html.match(/>Close</g)?.length).toBe(2);
    // Both ways are open, so nothing is left to offer.
    expect(html).not.toContain("send notes to another run");
  });

  it("shows open bridges read-only without controls", () => {
    const html = draw({ runs: [a, b], bridges: [open("run_a", "run_b")], readOnly: true });
    expect(html).toContain("Sends notes to");
    expect(html).not.toContain(">Close<");
  });
});
