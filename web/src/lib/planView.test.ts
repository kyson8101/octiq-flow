// What the Plan panel says of a chat's plan, over the plans the host's own
// tests answered (`__fixtures__/host/chat_plan_*.json`, never hand-written).
//
// Two things no recorded fixture holds, and both are made here and nowhere
// else, from the host's own answers:
//   - a plan and a ledger of the same tasks. The started plan's task ids are
//     from one host test and the ledgers from others, so `linkedTo` points a
//     host plan's linked ids at a host ledger's own tasks;
//   - a turn in flight. Every recorded attempt is `queued` (the host's tests
//     start no agent), so `executing` moves one running attempt's execution
//     to the state the host reports while its turn runs.
import { describe, expect, it } from "vitest";

import { hostFacts } from "./__fixtures__/hostFacts";
import type { ChatPlan, ChatPlanStartAnswer } from "./chatPlan";
import type { OrchestrationSnapshot } from "./orchestration";
import {
  DECISIONS_SHOWN, NOTHING_TO_START, NOT_CONNECTED, NOT_TOLD, NO_PLANS, countAgrees, hasPlan, ledgerSignature, moreDecisionsLabel,
  openQuestions, planHeader, planItems, planOffered, planStart, progressView, questionsLine, reducePlans, stampLabel, startNote,
  tasksInFlight, tasksLabel,
} from "./planView";
import { PLAN_START_LABEL, isPlanStartTurn, planStartBubble } from "./planTurn";
import { progressRow } from "./runProgress";

const UTC = { locale: "en-GB", timeZone: "UTC" };
const none = hostFacts.chatPlanNone;
const discussing = hostFacts.chatPlanDiscussing;
const decided = hostFacts.chatPlanDecided;
const started = hostFacts.chatPlanStarted;
/** A moment later on the day the fixtures were recorded. */
const NOW = 1791886010639 + 60_000;

describe("who is offered a plan", () => {
  it("is a chat's own agent, and nobody the host would refuse", () => {
    expect(planOffered("main")).toBe(true);
    for (const kind of ["worker", "front-desk", "seat"] as const) expect(planOffered(kind)).toBe(false);
  });
});

describe("the host's four plans, as recorded", () => {
  it("are what the readers below are asked", () => {
    expect(none()).toMatchObject({ revision: 0, items: [], awaitsStart: false });
    expect(discussing()).toMatchObject({ revision: 1, awaitsStart: true });
    expect(decided()).toMatchObject({ revision: 2, awaitsStart: true });
    expect(started()).toMatchObject({ revision: 2, awaitsStart: false, started: { revision: 1, told: true } });
  });
});

describe("whether there is a plan, and what is still open", () => {
  it("revision 0 is no plan", () => {
    expect(hasPlan(none())).toBe(false);
    expect(hasPlan(null)).toBe(false);
    for (const plan of [discussing(), decided(), started()]) expect(hasPlan(plan)).toBe(true);
  });

  it("counts open questions on the items still on the plan", () => {
    expect(openQuestions(none())).toBe(0);
    expect(openQuestions(discussing())).toBe(3);
    expect(openQuestions(decided())).toBe(0);
    // i5 and i7 have one each; the dropped i6 has none.
    expect(openQuestions(started())).toBe(2);
    expect(openQuestions(null)).toBe(0);
  });

  it("leaves a dropped item's questions out: they are asked of nobody", () => {
    const plan = discussing();
    plan.items[0].status = "dropped";
    expect(openQuestions(plan)).toBe(1);
  });

  it("says them in words, and says nothing when there are none", () => {
    expect(questionsLine(0)).toBeNull();
    expect(questionsLine(1)).toBe("1 question still open");
    expect(questionsLine(2)).toBe("2 questions still open");
  });
});

describe("the header", () => {
  it("counts the items, says whether the plan was started, and who last changed it and when", () => {
    expect(planHeader(discussing(), NOW, UTC)).toMatchObject({
      items: "2 items", started: false, state: "Not started", startedAt: null,
      // `agent` is the host's word for a chat with no registered agent.
      updated: `Updated ${stampLabel(1791886010139, NOW, UTC)} by the agent`,
    });
    expect(planHeader(started(), NOW, UTC)).toMatchObject({
      items: "6 items · 1 dropped", started: true,
      state: `Started ${stampLabel(1791886010635, NOW, UTC)}`, startedAt: 1791886010635,
      updated: `Updated ${stampLabel(1791886010639, NOW, UTC)} by OCTIQ HEAD`,
    });
  });

  it("says a time as a clock time, with the day when it is not today's", () => {
    const at = Date.UTC(2026, 9, 13, 10, 46);
    expect(stampLabel(at, at + 60_000, UTC)).toBe("10:46");
    expect(stampLabel(at, at + 26 * 60 * 60_000, UTC)).toBe("13 Oct, 10:46");
    // Never relative: nothing ticks in the panel.
    expect(stampLabel(at, at + 3 * 60_000, UTC)).not.toMatch(/ago|now/);
  });
});

describe("the items", () => {
  it("are in the host's order, with the dropped ones last", () => {
    expect(planItems(discussing()).map((item) => item.id)).toEqual(["i1", "i2"]);
    expect(planItems(started()).map((item) => item.id)).toEqual(["i1", "i2", "i3", "i4", "i5", "i7", "i6"]);
  });

  it("say the agent's word for each, and nothing of the agent's as a count", () => {
    expect(planItems(started()).map((item) => [item.id, item.word])).toEqual([
      ["i1", "Done"], ["i2", "In progress"], ["i3", "In progress"], ["i4", "In progress"],
      ["i5", "Discussing"], ["i7", "Discussing"], ["i6", "Dropped"],
    ]);
    expect(planItems(decided()).map((item) => item.word)).toEqual(["Decided", "Decided"]);
  });

  it("keep decisions, open questions and the note as the agent wrote them", () => {
    const [first, second] = planItems(discussing());
    expect(first).toMatchObject({
      title: "A quieter composer", decisions: ["Status rows are one line"], moreDecisions: [],
      questions: ["Do the rows fold on a phone?", "Which row is first?"], note: null, progress: null, tasks: [],
    });
    expect(second).toMatchObject({ questions: ["Desktop only?"], note: "The person sent a screenshot of the old top bar." });
  });

  it("show three decisions and put the rest behind a line that says how many", () => {
    const plan = decided();
    expect(planItems(plan)[0]).toMatchObject({ decisions: plan.items[0].decisions, moreDecisions: [] });
    plan.items[0].decisions = [...plan.items[0].decisions, "A fourth", "A fifth"];
    const [item] = planItems(plan);
    expect(item.decisions).toHaveLength(DECISIONS_SHOWN);
    expect(item.moreDecisions).toEqual(["A fourth", "A fifth"]);
    expect(moreDecisionsLabel(item.moreDecisions.length)).toBe("2 more decisions");
    expect(moreDecisionsLabel(1)).toBe("1 more decision");
  });

  it("draw an item with no linked task with no progress at all, never a zero", () => {
    for (const plan of [discussing(), decided()]) {
      for (const item of planItems(plan)) expect(item).toMatchObject({ progress: null, tasks: [] });
    }
    const byId = Object.fromEntries(planItems(started()).map((item) => [item.id, item]));
    for (const id of ["i5", "i6", "i7"]) expect(byId[id]).toMatchObject({ progress: null, tasks: [] });
  });

  it("say the host's count beside the agent's word", () => {
    const byId = Object.fromEntries(planItems(started()).map((item) => [item.id, item]));
    expect(byId.i1.progress).toMatchObject({ label: "1/2", percent: 50, parts: ["1 failed"], apart: [], spoken: "1 of 2 tasks done, 1 failed" });
    expect(byId.i2.progress).toMatchObject({ label: "0/2", percent: 0, parts: ["1 running", "1 waiting"] });
    expect(byId.i3.progress).toMatchObject({ label: "0/1", parts: ["1 failed"], spoken: "0 of 1 task done, 1 failed" });
    // A replaced task is counted nowhere but apart.
    expect(byId.i4.progress).toMatchObject({ label: "0/1", parts: ["1 waiting"], apart: ["1 closed"] });
    expect(byId.i4.tasks.map((task) => [task.title, task.word])).toEqual([["Inline questions, first try", "Closed"], ["Inline questions", "Waiting"]]);
    expect(tasksLabel(byId.i4.tasks.length)).toBe("2 tasks");
    expect(tasksLabel(1)).toBe("1 task");
  });

  it("leave the fraction out when no linked task counts as work", () => {
    expect(progressView(undefined)).toBeNull();
    expect(progressView({ total: 0, done: 0, running: 0, failed: 0, waiting: 0, closed: 0, unknown: 0 })).toBeNull();
    expect(progressView({ total: 0, done: 0, running: 0, failed: 0, waiting: 0, closed: 1, unknown: 2 }))
      .toMatchObject({ label: null, percent: null, parts: [], apart: ["1 closed", "2 not in the ledger"] });
  });
});

describe("an item's mark", () => {
  it("is never done on the agent's word alone when the host's count disagrees", () => {
    // i1: the agent calls it done; one of its two tasks failed its check.
    const [first] = planItems(started());
    expect(first).toMatchObject({ id: "i1", status: "done", word: "Done", mark: "quiet" });
    expect(countAgrees(started().items[0].progress)).toBe(false);
  });

  it("is done when the agent says so and the count agrees, or there is nothing to count", () => {
    const plan = started();
    Object.assign(plan.items[0].progress!, { done: 2, failed: 0 });
    expect(planItems(plan)[0].mark).toBe("done");
    const bare = decided();
    bare.items[0].status = "done";
    expect(planItems(bare)[0].mark).toBe("done");
    expect(countAgrees(undefined)).toBe(true);
    expect(countAgrees({ total: 0, done: 0, running: 0, failed: 0, waiting: 0, closed: 1, unknown: 0 })).toBe(true);
  });

  it("is grey for everything else, and muted for a dropped item", () => {
    expect(planItems(discussing()).map((item) => item.mark)).toEqual(["quiet", "quiet"]);
    expect(planItems(decided()).map((item) => item.mark)).toEqual(["quiet", "quiet"]);
    // No ledger on the page: the host's `running` alone lights nothing.
    expect(planItems(started()).map((item) => item.mark)).toEqual(["quiet", "quiet", "quiet", "quiet", "quiet", "quiet", "dropped"]);
  });
});

/** The host's started plan with i2's two linked tasks pointed at the first
 *  two tasks of a host ledger. */
function linkedTo(snapshot: OrchestrationSnapshot): ChatPlan {
  const plan = started();
  const item = plan.items[1];
  const ids = snapshot.tasks.slice(0, 2).map((task) => task.id);
  item.tasks = ids;
  item.linked = item.linked!.slice(0, ids.length).map((task, at) => ({ ...task, id: ids[at], runId: snapshot.tasks[at].runId }));
  return plan;
}

/** The host's two running attempts, the first with its turn in flight. */
function executing(): OrchestrationSnapshot {
  const ledger = hostFacts.usageContext();
  const attempt = ledger.attempts.find((item) => item.id === ledger.tasks[0].activeAttemptId)!;
  expect(attempt).toMatchObject({ status: "running", execution: { state: "queued" } });
  attempt.execution = { ...attempt.execution!, state: "executing" };
  return ledger;
}

describe("the accent", () => {
  it("is on nothing for a task whose attempt is only queued: the host's two running attempts, as recorded", () => {
    const ledger = hostFacts.usageContext();
    const now = Math.max(...ledger.tasks.map((task) => task.updatedAt)) + 5_000;
    expect(ledger.tasks.slice(0, 2).map((task) => task.status)).toEqual(["running", "running"]);
    const plan = linkedTo(ledger);
    expect(tasksInFlight(plan, ledger, now).size).toBe(0);
    // The host's `running` count for the item is 1 all the same: it counts an
    // attempt being prepared, which is not a turn.
    expect(plan.items[1].progress?.running).toBe(1);
    expect(planItems(plan, tasksInFlight(plan, ledger, now))[1].mark).toBe("quiet");
  });

  it("is on an item only while a linked task's worker has a turn in flight, by the run panel's own reader", () => {
    const ledger = executing();
    const now = Math.max(...ledger.tasks.map((task) => task.updatedAt)) + 5_000;
    const plan = linkedTo(ledger);
    const flying = tasksInFlight(plan, ledger, now);
    // Exactly the rows the run panel calls in flight.
    const rows = ledger.tasks.filter((task) => plan.items[1].tasks.includes(task.id)
      && progressRow(ledger, ledger.runs.find((run) => run.id === task.runId)!, task, now).flight).map((task) => task.id);
    expect(rows).toEqual([ledger.tasks[0].id]);
    expect([...flying].sort()).toEqual([...rows].sort());
    const items = planItems(plan, flying);
    expect(items.filter((item) => item.mark === "live").map((item) => item.id)).toEqual(["i2"]);
    expect(items[1].tasks.filter((task) => task.live).map((task) => task.id).sort()).toEqual([...rows].sort());
  });

  it("is on nothing when the page holds no ledger, when the task is not executing, or when the item was dropped", () => {
    const ledger = executing();
    const now = Math.max(...ledger.tasks.map((task) => task.updatedAt)) + 5_000;
    expect(tasksInFlight(linkedTo(ledger), null, now).size).toBe(0);
    expect(tasksInFlight(null, ledger, now).size).toBe(0);
    // The host's own started plan links tasks no ledger here holds.
    expect(tasksInFlight(started(), ledger, now).size).toBe(0);
    // A failed task that waits on the person has no turn in flight.
    const failed = hostFacts.failureAwaitsPerson();
    expect(tasksInFlight(linkedTo(failed), failed, now).size).toBe(0);
    const dropped = linkedTo(ledger);
    dropped.items[1].status = "dropped";
    expect(tasksInFlight(dropped, ledger, now).size).toBe(0);
    expect(planItems(dropped, tasksInFlight(linkedTo(ledger), ledger, now)).find((item) => item.id === "i2")).toMatchObject({ mark: "dropped", tasks: [], progress: null });
  });

  it("outranks the agent's word: a turn in flight is a fact", () => {
    const ledger = executing();
    const now = Math.max(...ledger.tasks.map((task) => task.updatedAt)) + 5_000;
    const plan = linkedTo(ledger);
    plan.items[1].status = "done";
    expect(planItems(plan, tasksInFlight(plan, ledger, now))[1].mark).toBe("live");
  });
});

describe("Start", () => {
  it("is offered exactly while the host says the plan awaits it", () => {
    expect(planStart(discussing(), NOW)).toEqual({ kind: "start", revision: 1, label: "Start", questions: "3 questions still open", off: null });
    expect(planStart(decided(), NOW)).toEqual({ kind: "start", revision: 2, label: "Start", questions: null, off: null });
    expect(planStart(none(), NOW)).toEqual({ kind: "none" });
    expect(planStart(null, NOW)).toEqual({ kind: "none" });
  });

  it("is not worked out from the items: the host's word decides", () => {
    // Items that look startable, on a plan the host says does not await Start.
    const plan = decided();
    plan.awaitsStart = false;
    expect(planStart(plan, NOW)).toEqual({ kind: "nothing", state: NOTHING_TO_START });
  });

  it("says Nothing to start for a plan whose items were all dropped, and draws no button", () => {
    const plan = decided();
    for (const item of plan.items) item.status = "dropped";
    plan.awaitsStart = false;
    expect(planStart(plan, NOW)).toEqual({ kind: "nothing", state: "Nothing to start" });
  });

  it("is switched off, with the reason, while the page is not connected", () => {
    expect(planStart(decided(), NOW, { connected: false })).toMatchObject({ kind: "start", off: NOT_CONNECTED });
  });

  it("is replaced by Started and the time once the agent has its turn", () => {
    expect(planStart(started(), NOW, { connected: true }, UTC)).toEqual({ kind: "started", state: `Started ${stampLabel(1791886010635, NOW, UTC)}` });
  });

  it("says both halves apart while the agent was not told, and offers the same command again", () => {
    const plan = started();
    plan.started!.told = false;
    expect(planStart(plan, NOW, { connected: true }, UTC)).toEqual({
      kind: "tell", revision: 2, label: "Tell the agent",
      state: `Started ${stampLabel(1791886010635, NOW, UTC)}`, note: NOT_TOLD, off: null,
    });
    expect(NOT_TOLD).toBe("the agent has not been told yet");
  });

  it("reads why a recorded Start's turn was not handed over from the answer, and nothing when it was", () => {
    const told: ChatPlanStartAnswer = { plan: started(), turnId: "octiq-plan-start-1", delivered: true, state: "queued" };
    expect(startNote(told)).toBeNull();
    const untold: ChatPlanStartAnswer = { plan: started(), turnId: "octiq-plan-start-2", delivered: false, notDelivered: "The profile folder is not available right now." };
    expect(startNote(untold)).toBe("The profile folder is not available right now.");
  });
});

describe("what the page holds of a plan", () => {
  const id = "chat-1";
  const read = (plans = NO_PLANS, plan = discussing(), rev = plans[id]?.rev ?? 0) => reducePlans(plans, { type: "read", chatId: id, plan, rev });

  it("takes a read, and an event after it", () => {
    let plans = read();
    expect(plans[id]).toMatchObject({ plan: { revision: 1 }, error: null });
    plans = reducePlans(plans, { type: "said", chatId: id, plan: decided() });
    expect(plans[id].plan?.revision).toBe(2);
  });

  it("does not let a read that was in the air put an older plan back over an event", () => {
    // Asked at rev 0; the event arrives before the answer.
    const said = reducePlans(NO_PLANS, { type: "said", chatId: id, plan: decided() });
    const late = reducePlans(said, { type: "read", chatId: id, plan: discussing(), rev: 0 });
    expect(late).toBe(said);
    expect(late[id].plan?.revision).toBe(2);
  });

  it("keeps the last plan when a read fails, and says why", () => {
    const plans = reducePlans(read(), { type: "unread", chatId: id, error: "The profile folder is not available right now.", rev: 0 });
    expect(plans[id]).toMatchObject({ plan: { revision: 1 }, error: "The profile folder is not available right now." });
    // A failure that answers after an event is about an older moment.
    const said = reducePlans(read(), { type: "said", chatId: id, plan: decided() });
    expect(reducePlans(said, { type: "unread", chatId: id, error: "late", rev: 0 })).toBe(said);
  });

  it("takes a Start's answer, unless what it heard since says more", () => {
    const awaiting = read(NO_PLANS, decided());
    const startedPlan = { ...decided(), awaitsStart: false, started: { at: 1, revision: 2, turnId: "octiq-plan-start-1", told: false } };
    const told = { ...startedPlan, started: { ...startedPlan.started, told: true } };
    expect(reducePlans(awaiting, { type: "answered", chatId: id, plan: told })[id].plan?.started?.told).toBe(true);
    // The `told` event arrived first; the answer to an earlier try does not undo it.
    const heard = reducePlans(awaiting, { type: "said", chatId: id, plan: told });
    expect(reducePlans(heard, { type: "answered", chatId: id, plan: startedPlan })).toBe(heard);
    // Nor does an answer put back a plan with no Start on it, or an older list.
    expect(reducePlans(heard, { type: "answered", chatId: id, plan: decided() })).toBe(heard);
    expect(reducePlans(heard, { type: "answered", chatId: id, plan: discussing() })).toBe(heard);
  });

  it("keeps each chat's plan apart", () => {
    const plans = reducePlans(read(), { type: "said", chatId: "chat-2", plan: started() });
    expect(plans[id].plan?.revision).toBe(1);
    expect(plans["chat-2"].plan?.started?.told).toBe(true);
  });
});

describe("when the plan is read again for the ledger's sake", () => {
  it("never for a plan that links no task", () => {
    const ledger = hostFacts.usageContext();
    for (const plan of [none(), discussing(), decided()]) expect(ledgerSignature(plan, ledger)).toBe("");
    expect(ledgerSignature(null, ledger)).toBe("");
    expect(ledgerSignature(started(), null)).toBe("");
  });

  it("when a linked task's state moves, and not when another task's does", () => {
    const ledger = hostFacts.usageContext();
    const plan = linkedTo(ledger);
    const before = ledgerSignature(plan, ledger);
    expect(before).not.toBe("");
    expect(ledgerSignature(plan, hostFacts.usageContext())).toBe(before);
    const moved = hostFacts.usageContext();
    moved.tasks[0].status = "blocked";
    expect(ledgerSignature(plan, moved)).not.toBe(before);
    const attempt = hostFacts.usageContext();
    attempt.attempts.find((item) => item.taskId === attempt.tasks[0].id)!.status = "failed";
    expect(ledgerSignature(plan, attempt)).not.toBe(before);
    const stopped = hostFacts.usageContext();
    stopped.runs[0].status = "stopped";
    expect(ledgerSignature(plan, stopped)).not.toBe(before);
    // A task the plan does not link.
    const other = hostFacts.usageContext();
    other.tasks.push({ ...other.tasks[0], id: "task_other", status: "failed" });
    expect(ledgerSignature(plan, other)).toBe(before);
  });
});

describe("the turn that tells the agent its plan was started", () => {
  it("is known by the host's prefix, which the host's own Start carries", () => {
    expect(isPlanStartTurn(started().started!.turnId)).toBe(true);
    expect(isPlanStartTurn("octiq-complete-1")).toBe(false);
    expect(isPlanStartTurn("3f1c")).toBe(false);
    expect(isPlanStartTurn(null)).toBe(false);
  });

  it("is named, not quoted", () => {
    const turnId = started().started!.turnId;
    expect(planStartBubble({ turnId, delivery: "queued" })).toEqual({ label: PLAN_START_LABEL, detail: "Telling the agent after the current reply" });
    expect(planStartBubble({ turnId, delivery: "dispatched", echo: "e1" })).toEqual({ label: "Plan started", detail: "The agent was told to begin" });
    expect(planStartBubble({ turnId: "3f1c" })).toBeNull();
  });
});
