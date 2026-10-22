import { describe, expect, it } from "vitest";
import {
  awaitingApproval, nextPlanChanges, planDestination, planNumbers, planOwner, planPlaceKey, planPlaceNames, planStages, stageSummary,
} from "./planReview";
import type { OrchestrationTask } from "./orchestration";

const task = (id: string, dependsOn: string[] = [], extra: Partial<OrchestrationTask> = {}): OrchestrationTask => ({
  id, runId: "run", title: id, spec: "", dependsOn, status: "pending", createdAt: 1, updatedAt: 1, ...extra,
});

describe("plan revision changes", () => {
  it("names additions and withdrawals, keeping them after the settle interval", () => {
    const initial = nextPlanChanges(null, "run", 1, [task("a"), task("b")]);
    expect(initial.added).toEqual([]);
    const changed = nextPlanChanges(initial, "run", 2, [task("a", [], { status: "cancelled" }), task("b"), task("c")]);
    expect(changed.added).toEqual(["c"]);
    expect(changed.withdrawn).toEqual(["a"]);
    expect(nextPlanChanges(changed, "run", 2, [task("b"), task("c")])).toEqual(changed);
    expect(nextPlanChanges(changed, "run", 3, [task("b"), task("c")]).added).toEqual([]);
  });
  it("does not invent a previous revision on reload, an older host, or another run", () => {
    const first = nextPlanChanges(null, "one", undefined, [task("a")]);
    expect(nextPlanChanges(first, "one", 2, [task("b")]).withdrawn).toEqual([]);
    expect(nextPlanChanges(first, "two", 2, [task("b")]).added).toEqual([]);
  });
});

describe("planStages", () => {
  it("puts independent tasks side by side and dependants after them", () => {
    const stages = planStages([task("c", ["a", "b"]), task("a"), task("b"), task("d", ["c"])]);
    expect(stages.map((stage) => stage.tasks.map((t) => t.id))).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(stages.every((stage) => !stage.blocked)).toBe(true);
    expect([...planNumbers(stages)]).toEqual([["a", 1], ["b", 2], ["c", 3], ["d", 4]]);
  });

  it("ignores a dependency outside the plan", () => {
    expect(planStages([task("a", ["elsewhere"])])[0]).toMatchObject({ blocked: false });
  });

  it("flags a cycle instead of looping on it", () => {
    const stages = planStages([task("a"), task("b", ["c"]), task("c", ["b"])]);
    expect(stages).toHaveLength(2);
    expect(stages[1]).toMatchObject({ blocked: true });
    expect(stages[1].tasks.map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("is empty for an empty plan", () => {
    expect(planStages([])).toEqual([]);
  });
});

describe("planOwner", () => {
  it("prefers the registered agent, then the worker, then says it is open", () => {
    expect(planOwner(task("a", [], { assignee: { id: "m", name: "Maya" }, worker: { agent: "codex", access: "auto" } }))).toEqual({ agent: "codex", label: "Maya" });
    expect(planOwner(task("a", [], { worker: { agent: "claude", access: "auto", model: "claude-sonnet-5" } }))).toEqual({ agent: "claude", label: "claude-sonnet-5" });
    expect(planOwner(task("a")).label).toBe("Chosen at dispatch");
  });
});

describe("planDestination", () => {
  const run = { workspaceId: "p1", rootPath: "/repos/octiq/" };
  it("reads the task's own destination first", () => {
    const routed = task("a", [], { destination: { projectId: "shop", projectName: "Shop", repository: "/repos/shop/api" } });
    expect(planDestination(routed, run)).toEqual({ project: "Shop", repository: "api", path: "/repos/shop/api" });
  });
  it("falls back to the run's own checkout for a task without one", () => {
    expect(planDestination(task("a"), run, () => "OctiqFlow")).toEqual({ project: "OctiqFlow", repository: "octiq", path: "/repos/octiq/" });
    expect(planDestination(task("a"), run).project).toBe("This project");
  });
});

describe("a stage on one line", () => {
  const run = { workspaceId: "p1", rootPath: "/src/octiq-flow" };
  const to = (id: string, name: string, project: string, repository: string, projectId = project) =>
    task(id, [], { assignee: { id: name, name }, destination: { projectId, projectName: project, repository } });
  const line = (tasks: OrchestrationTask[], plan = tasks) => stageSummary({ tasks, blocked: false }, run, undefined, plan);

  it("never takes two destinations with one folder name for one", () => {
    // The reviewer's stage: three tasks in /src/octiq-flow, a fourth by
    // another agent in /prod/octiq-flow. It read "… +1 · octiq-flow".
    const tasks = [
      to("a", "OCTIQ FE", "OctiqFlow", "/src/octiq-flow"),
      to("b", "OCTIQ BE", "OctiqFlow", "/src/octiq-flow"),
      to("c", "OCTIQ QA", "OctiqFlow", "/src/octiq-flow"),
      to("d", "STAR MUSIC", "Production", "/prod/octiq-flow"),
    ];
    expect(line(tasks)).toBe(
      "4 tasks · OCTIQ FE, OCTIQ BE, OCTIQ QA, STAR MUSIC · OctiqFlow · octiq-flow, Production · octiq-flow",
    );
  });

  it("names a destination by its folder while that names one place", () => {
    expect(line([to("a", "Ada", "Shop", "/repos/shop/api"), to("b", "Bo", "Shop", "/repos/shop/web/")]))
      .toBe("2 tasks · Ada, Bo · api, web");
    // The same place written with and without a trailing slash is one place.
    expect(line([to("a", "Ada", "Shop", "/repos/shop/api"), to("b", "Bo", "Shop", "/repos/shop/api/")]))
      .toBe("2 tasks · Ada, Bo · api");
    // A task with no destination of its own runs in the run's checkout.
    expect(stageSummary({ tasks: [task("a")], blocked: false }, run, () => "OctiqFlow")).toBe("1 task · Chosen at dispatch · octiq-flow");
  });

  it("adds the parent folder when the project is shared too, and the path when that is as well", () => {
    expect(line([to("a", "Ada", "Shop", "/src/api"), to("b", "Bo", "Shop", "/prod/api")]))
      .toBe("2 tasks · Ada, Bo · Shop · src/api, Shop · prod/api");
    expect(line([to("a", "Ada", "Shop", "/one/src/api"), to("b", "Bo", "Shop", "/two/src/api")]))
      .toBe("2 tasks · Ada, Bo · Shop · /one/src/api, Shop · /two/src/api");
    // One path under two projects is two destinations.
    expect(line([to("a", "Ada", "Shop", "/src/api"), to("b", "Bo", "Depot", "/src/api")]))
      .toBe("2 tasks · Ada, Bo · Shop · api, Depot · api");
    // Two projects that share a name are told apart by where they are.
    expect(line([to("a", "Ada", "Shop", "/src/api", "p-1"), to("b", "Bo", "Shop", "/prod/api", "p-2")]))
      .toBe("2 tasks · Ada, Bo · Shop · src/api, Shop · prod/api");
  });

  it("calls a destination the same thing on every stage of a plan", () => {
    // Alone on its stage the folder name would do; in this plan it does not.
    const first = to("a", "Ada", "OctiqFlow", "/src/octiq-flow");
    const second = to("b", "Bo", "Production", "/prod/octiq-flow");
    expect(line([first], [first, second])).toBe("1 task · Ada · OctiqFlow · octiq-flow");
    expect(line([second], [first, second])).toBe("1 task · Bo · Production · octiq-flow");
    expect(planPlaceNames([first, second], run).get(planPlaceKey(second, run))).toBe("Production · octiq-flow");
  });

  it("names every destination up to four, then counts the rest in words", () => {
    const five = ["a", "b", "c", "d", "e"].map((id) => to(id, "Ada", "Shop", `/repos/${id}`));
    expect(line(five.slice(0, 4))).toBe("4 tasks · Ada · a, b, c, d");
    expect(line(five)).toBe("5 tasks · Ada · a, b, c, d +1 more destination");
    expect(line([...five, to("f", "Ada", "Shop", "/repos/f")])).toBe("6 tasks · Ada · a, b, c, d +2 more destinations");
  });

  it("names every agent up to six, then counts the rest in words, never as a bare +1", () => {
    const seven = ["Ada", "Bo", "Cy", "Di", "Ed", "Flo", "Gus"].map((name) => to(name, name, "Shop", "/repos/shop"));
    expect(line(seven.slice(0, 6))).toBe("6 tasks · Ada, Bo, Cy, Di, Ed, Flo · shop");
    expect(line(seven)).toBe("7 tasks · Ada, Bo, Cy, Di, Ed, Flo +1 more agent · shop");
    expect(line([...seven, to("Hal", "Hal", "Shop", "/repos/shop")])).toBe("8 tasks · Ada, Bo, Cy, Di, Ed, Flo +2 more agents · shop");
    // Four agents used to be three and "+1".
    expect(line(seven.slice(0, 4))).not.toMatch(/\+\d/);
  });

  it("counts an agent once, and two agents with one name twice", () => {
    expect(line([to("a", "Ada", "Shop", "/r/s"), to("b", "Ada", "Shop", "/r/s")])).toBe("2 tasks · Ada · s");
    const twin = task("b", [], { assignee: { id: "ada-2", name: "Ada" }, destination: { projectId: "Shop", projectName: "Shop", repository: "/r/s" } });
    expect(line([to("a", "Ada", "Shop", "/r/s"), twin])).toBe("2 tasks · Ada, Ada · s");
  });
});

describe("awaitingApproval", () => {
  it("is the lead's own unapproved tasks, never a manager's subtasks", () => {
    const tasks = [
      task("a", [], { approvedAt: 1 }),
      task("b"),
      task("c", [], { parentTaskId: "a", splitBy: "attempt_manager" }),
    ];
    expect(awaitingApproval(tasks)).toEqual(["b"]);
  });

  // The host's rule (`approval_parent`): a parent id alone is not a split.
  // A task the lead put under an approved parent is new work, and the host
  // refuses an approval whose task set leaves it out.
  it("includes a task the lead put under a parent, which no manager split", () => {
    const tasks = [task("a", [], { approvedAt: 1 }), task("c", [], { parentTaskId: "a" })];
    expect(awaitingApproval(tasks)).toEqual(["c"]);
  });
});
