// The held warning does not trust the browser's clock against the host's.
//
// A reopened task takes the warning colour once its notice has stayed
// unconfirmed for about a minute. The reopen's stamp is the host's, so it is
// never compared with the browser's clock: the minute is counted from when
// this page first saw the hold, by the page's own clock, or is read off the
// ledger itself, where a later stamp of the host's says the minute has
// passed. The ledger is the host's own (`__fixtures__/host/held_by_reopen`).
import { beforeEach, describe, expect, it } from "vitest";
import { hostFacts } from "./__fixtures__/hostFacts";
import { forgetHolds, holdDue, REOPEN_LABEL, REOPEN_LASTED_LABEL, REOPEN_LASTED_MS, seeHolds, taskHold } from "./taskHold";

const held = hostFacts.heldByReopen();
const [task] = held.tasks;
const run = held.runs[0];
const REOPENED_AT = task.reopens![0].at;
const FIVE_MINUTES = 5 * 60_000;

const read = (now: number, tasks = held.tasks) => taskHold(tasks[0], run, tasks, now);

beforeEach(() => forgetHolds());

describe("a browser whose clock is ahead of the host's", () => {
  it("does not warn the moment the hold is seen", () => {
    const browser = REOPENED_AT + FIVE_MINUTES;
    seeHolds(held.tasks, browser);
    expect(read(browser + 2_000)).toMatchObject({ kind: "reopen", label: REOPEN_LABEL, tone: null });
  });

  it("warns a minute after it first saw the hold", () => {
    const browser = REOPENED_AT + FIVE_MINUTES;
    seeHolds(held.tasks, browser);
    expect(read(browser + REOPEN_LASTED_MS - 1)).toMatchObject({ tone: null });
    expect(read(browser + REOPEN_LASTED_MS)).toMatchObject({ kind: "reopen", label: REOPEN_LASTED_LABEL, tone: "warn" });
  });
});

describe("a browser whose clock is behind the host's", () => {
  it("warns a minute after it first saw the hold, not six", () => {
    const browser = REOPENED_AT - FIVE_MINUTES;
    seeHolds(held.tasks, browser);
    expect(read(browser + 2_000)).toMatchObject({ tone: null });
    expect(read(browser + REOPEN_LASTED_MS)).toMatchObject({ label: REOPEN_LASTED_LABEL, tone: "warn" });
  });
});

describe("the first sight of a hold", () => {
  it("is kept: seeing the same hold again does not start the minute over", () => {
    seeHolds(held.tasks, 1_000);
    seeHolds(hostFacts.heldByReopen().tasks, 50_000);
    expect(read(1_000 + REOPEN_LASTED_MS)).toMatchObject({ tone: "warn" });
  });

  it("is forgotten once the notice is confirmed, and a later reopen is a new hold", () => {
    seeHolds(held.tasks, 1_000);
    seeHolds(hostFacts.reopenNoticeDelivered().tasks, 30_000);
    // Changed for this test: the same task reopened again, later.
    const again = hostFacts.heldByReopen();
    again.tasks[0].reopens = [{ ...again.tasks[0].reopens![0], at: REOPENED_AT + 90_000 }];
    seeHolds(again.tasks, 100_000);
    expect(read(100_000 + 2_000, again.tasks)).toMatchObject({ label: REOPEN_LABEL, tone: null });
    expect(read(100_000 + REOPEN_LASTED_MS, again.tasks)).toMatchObject({ tone: "warn" });
  });

  it("is what a reader without one goes by: a hold nobody has seen is never said to have lasted", () => {
    expect(read(REOPENED_AT + FIVE_MINUTES)).toMatchObject({ kind: "reopen", label: REOPEN_LABEL, tone: null });
    expect(read(0)).toMatchObject({ label: REOPEN_LABEL, tone: null });
  });
});

describe("what the ledger itself says", () => {
  it("warns at once when a later stamp of the host's shows the minute has passed", () => {
    // Changed for this test: another task of the ledger was updated by the
    // host more than a minute after the reopen, which is what a page loaded
    // late reads.
    const late = hostFacts.heldByReopen();
    late.tasks.push({ ...late.tasks[0], id: "task_other", heldByReopen: undefined, reopens: undefined, updatedAt: REOPENED_AT + REOPEN_LASTED_MS });
    const browser = REOPENED_AT - FIVE_MINUTES;
    seeHolds(late.tasks, browser);
    expect(read(browser, late.tasks)).toMatchObject({ label: REOPEN_LASTED_LABEL, tone: "warn" });
    // One stamp short of the minute says nothing yet.
    late.tasks[1].updatedAt = REOPENED_AT + REOPEN_LASTED_MS - 1;
    expect(read(browser, late.tasks)).toMatchObject({ tone: null });
  });
});

describe("when to look again", () => {
  it("is once, when the earliest hold not yet warned about turns a minute old", () => {
    seeHolds(held.tasks, 10_000);
    expect(holdDue(held.tasks, 10_000)).toBe(REOPEN_LASTED_MS);
    expect(holdDue(held.tasks, 40_000)).toBe(REOPEN_LASTED_MS - 30_000);
  });

  it("is never once every hold has lasted or nothing is held", () => {
    seeHolds(held.tasks, 10_000);
    expect(holdDue(held.tasks, 10_000 + REOPEN_LASTED_MS)).toBeNull();
    expect(holdDue(hostFacts.reopenNoticeDelivered().tasks, 10_000)).toBeNull();
  });
});
