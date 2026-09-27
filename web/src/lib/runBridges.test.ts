import { describe, expect, it } from "vitest";
import type { OrchestrationRun, RunBridge } from "./orchestration";
import { bridgeScope, bridgeTargets, runBridges } from "./runBridges";

const run = (id: string, coordinator: string, extra: Partial<OrchestrationRun> = {}) =>
  ({ id, objective: `Objective ${id}`, coordinatorChatKey: coordinator, status: "running", ...extra }) as OrchestrationRun;

const bridge = (id: string, from: string, to: string, extra: Partial<RunBridge> = {}): RunBridge => ({
  id, fromRunId: from, toRunId: to, fromCoordinatorChatKey: "chat:a", toCoordinatorChatKey: "chat:b",
  openedAt: 1, sends: [], ...extra,
});

describe("run bridges", () => {
  const a = run("run_a", "chat:a");
  const sibling = run("run_s", "chat:a");
  const b = run("run_b", "chat:b");
  const c = run("run_c", "chat:c");
  const archived = run("run_x", "chat:x", { archivedAt: 5 });

  it("lists only open bridges, by direction", () => {
    const snapshot = { bridges: [bridge("1", "run_a", "run_b"), bridge("2", "run_c", "run_a"), bridge("3", "run_a", "run_c", { closedAt: 9 })] };
    const { outgoing, incoming } = runBridges(a, snapshot);
    expect(outgoing.map((x) => x.id)).toEqual(["1"]);
    expect(incoming.map((x) => x.id)).toEqual(["2"]);
    expect(runBridges(a, {})).toEqual({ outgoing: [], incoming: [] });
  });

  it("offers only other coordinators' live runs not already bridged that way", () => {
    const runs = [a, sibling, b, c, archived];
    expect(bridgeTargets(a, { runs, bridges: [] }).map((x) => x.id)).toEqual(["run_b", "run_c"]);
    // One open that way is not offered again; the reverse direction still is.
    expect(bridgeTargets(a, { runs, bridges: [bridge("1", "run_a", "run_b")] }).map((x) => x.id)).toEqual(["run_c"]);
    expect(bridgeTargets(b, { runs, bridges: [bridge("1", "run_a", "run_b")] }).map((x) => x.id)).toEqual(["run_a", "run_s", "run_c"]);
    // A closed bridge does not hold the pair.
    expect(bridgeTargets(a, { runs, bridges: [bridge("1", "run_a", "run_b", { closedAt: 3 })] }).map((x) => x.id)).toEqual(["run_b", "run_c"]);
    expect(bridgeTargets(archived, { runs, bridges: [] })).toEqual([]);
  });

  it("says who may send to whom, one way, and what it does not allow", () => {
    const scope = bridgeScope(a, b).join("\n");
    expect(scope).toContain("One way: the main agent of “Objective run_a” may send notes to the main agent of “Objective run_b”");
    expect(scope).toContain("50 notes of 4,000 characters");
    expect(scope).toContain("No worker of either run");
    expect(scope).toContain("nothing forwards them");
    expect(scope).toContain("grant nothing");
    expect(scope).toContain("when either run is archived");
  });
});
