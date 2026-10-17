// Jobs an agent registered with the host, as the page reads them.
import { describe, expect, it } from "vitest";

import {
  applyJobEvent,
  applyJobsRead,
  backgroundChip,
  callCommands,
  commandOfArgs,
  elapsedOf,
  isJobTurn,
  isStale,
  JOB_STALE_MS,
  jobCalls,
  jobIdOfTurn,
  jobLine,
  jobRowNote,
  jobTurnBubble,
  NO_JOBS,
  percent,
  interruptedJobs,
  readJob,
  runningJobs,
  runningSignature,
  type HeldJob,
  type Job,
} from "./jobs";
import { backgroundSummary } from "./background";
import { elapsedLabel } from "./working";
import { emptyChat, reduceChat } from "./chat";
import { noticesHeadline, presentNotice, presentNotices } from "./chatNotices";

/** A job exactly as the contract says the host sends it. */
const wire = (over: Partial<Job> = {}): Job => ({
  id: "job_1",
  chatKey: "chat:c1",
  label: "Render mp4",
  source: "wrapper",
  status: "running",
  elapsedMs: 60_000,
  sinceUpdateMs: 500,
  command: "npx remotion render src/index.ts Main out.mp4",
  wake: true,
  ...over,
});

const held = (over: Partial<Job> = {}, receivedAt = 1_000_000): HeldJob => ({ job: wire(over), receivedAt, rev: 1 });

describe("readJob", () => {
  it("keeps a job shaped like the contract", () => {
    const job = readJob({ ...wire({ phase: "Encoding", done: 120, total: 300, unit: "frames", exitCode: null, reason: "x" }) });
    expect(job).toEqual(wire({ phase: "Encoding", done: 120, total: 300, unit: "frames", exitCode: null, reason: "x" }));
  });

  it("refuses what is not a job", () => {
    expect(readJob(null)).toBeNull();
    expect(readJob({ ...wire(), id: "" })).toBeNull();
    expect(readJob({ ...wire(), status: "paused" })).toBeNull();
    expect(readJob({ ...wire(), elapsedMs: "60" })).toBeNull();
    expect(readJob({ ...wire(), sinceUpdateMs: undefined })).toBeNull();
  });

  it("drops an optional field of the wrong type rather than guessing", () => {
    const job = readJob({ ...wire(), done: "12", total: 300, unit: "parsecs", exitCode: "0" })!;
    expect(job.done).toBeUndefined();
    expect(job.unit).toBeUndefined();
    expect(job.exitCode).toBeUndefined();
    expect(percent(job)).toBeNull();
  });
});

describe("percent", () => {
  it("is the job's own count, floored", () => {
    expect(percent({ done: 120, total: 300 })).toBe(40);
    expect(percent({ done: 299, total: 300 })).toBe(99);
    expect(percent({ done: 42, total: 100 })).toBe(42);
    expect(percent({ done: 400, total: 300 })).toBe(100);
  });

  it("is null without both numbers or with no total", () => {
    expect(percent({})).toBeNull();
    expect(percent({ done: 5 })).toBeNull();
    expect(percent({ total: 5 })).toBeNull();
    expect(percent({ done: 0, total: 0 })).toBeNull();
    expect(percent({ done: 1, total: -1 })).toBeNull();
  });
});

describe("one clock", () => {
  it("counts elapsed on from receipt, on the page's clock", () => {
    const job = held({ elapsedMs: 60_000 }, 5_000);
    expect(elapsedOf(job, 5_000)).toBe(60_000);
    expect(elapsedOf(job, 35_000)).toBe(90_000);
    // A page clock that went back reads no less than the host said.
    expect(elapsedOf(job, 1_000)).toBe(60_000);
  });

  it("stops an ended job's clock where the host stopped it", () => {
    expect(elapsedOf(held({ status: "done", elapsedMs: 70_000 }, 5_000), 500_000)).toBe(70_000);
  });

  it("calls a running job stale after ten minutes with no word", () => {
    const job = held({ sinceUpdateMs: 9 * 60_000 }, 0);
    expect(isStale(job, 60_000)).toBe(false);
    expect(isStale(job, 60_001)).toBe(true);
    expect(isStale(held({ sinceUpdateMs: JOB_STALE_MS + 1 }, 0), 0)).toBe(true);
    expect(isStale(held({ status: "done", sinceUpdateMs: JOB_STALE_MS * 2 }, 0), 0)).toBe(false);
  });
});

describe("events and reads", () => {
  const event = (job: Partial<Job>) => ({ chatKey: job.chatKey ?? "chat:c1", job: wire(job) });

  it("an event replaces the job it carries", () => {
    let state = applyJobEvent(NO_JOBS, event({ done: 10, total: 100 }), 1);
    state = applyJobEvent(state, event({ done: 20, total: 100 }), 2);
    expect(state.jobs.get("job_1")!.job.done).toBe(20);
    expect(state.jobs.get("job_1")!.receivedAt).toBe(2);
    expect(applyJobEvent(state, { job: { id: "x" } }, 3)).toBe(state);
  });

  it("a read that was in the air when an event landed does not put the older job back", () => {
    let state = applyJobEvent(NO_JOBS, event({ done: 10, total: 100 }), 1);
    const asked = state.rev;
    state = applyJobEvent(state, event({ done: 50, total: 100 }), 2);
    state = applyJobsRead(state, { jobs: [wire({ done: 30, total: 100 })], asked }, 3);
    expect(state.jobs.get("job_1")!.job.done).toBe(50);
  });

  it("nor drops a job an event started after the read was asked", () => {
    const asked = NO_JOBS.rev;
    let state = applyJobEvent(NO_JOBS, event({ id: "job_new" }), 1);
    state = applyJobsRead(state, { jobs: [], asked }, 2);
    expect(state.jobs.has("job_new")).toBe(true);
  });

  it("nor brings back as running a job an event ended", () => {
    let state = applyJobEvent(NO_JOBS, event({}), 1);
    const asked = state.rev;
    state = applyJobEvent(state, event({ status: "done", exitCode: 0 }), 2);
    state = applyJobsRead(state, { jobs: [wire({ status: "running" })], asked }, 3);
    expect(state.jobs.get("job_1")!.job.status).toBe("done");
  });

  it("a read replaces what it covers, and only that", () => {
    let state = applyJobEvent(NO_JOBS, event({ id: "a", chatKey: "chat:c1" }), 1);
    state = applyJobEvent(state, event({ id: "b", chatKey: "chat:c2" }), 2);
    // Scoped to c1: b is not its to drop.
    let next = applyJobsRead(state, { jobs: [], asked: state.rev, chatKey: "chat:c1" }, 3);
    expect([...next.jobs.keys()]).toEqual(["b"]);
    // Every chat: what it leaves out is gone, what it holds is taken.
    next = applyJobsRead(state, { jobs: [wire({ id: "c", chatKey: "chat:c3" })], asked: state.rev }, 3);
    expect([...next.jobs.keys()]).toEqual(["c"]);
    expect(next.jobs.get("c")!.receivedAt).toBe(3);
  });

  it("an answer that is not a list is no jobs", () => {
    const state = applyJobEvent(NO_JOBS, event({}), 1);
    expect(applyJobsRead(state, { jobs: undefined, asked: state.rev }, 2).jobs.size).toBe(0);
  });

  it("lists a chat's running jobs, oldest first, and signs them by start and end only", () => {
    let state = applyJobEvent(NO_JOBS, event({ id: "young", elapsedMs: 1_000 }), 100_000);
    state = applyJobEvent(state, event({ id: "old", elapsedMs: 50_000 }), 100_000);
    state = applyJobEvent(state, event({ id: "ended", status: "failed" }), 100_000);
    state = applyJobEvent(state, event({ id: "other", chatKey: "chat:c2" }), 100_000);
    expect(runningJobs(state, "chat:c1").map((h) => h.job.id)).toEqual(["old", "young"]);
    const signature = runningSignature(state);
    const moved = applyJobEvent(state, event({ id: "old", elapsedMs: 50_500, done: 3, total: 9 }), 100_500);
    expect(runningSignature(moved)).toBe(signature);
    const ended = applyJobEvent(state, event({ id: "old", status: "done" }), 100_500);
    expect(runningSignature(ended)).not.toBe(signature);
  });
});

describe("jobLine and the strip", () => {
  it("says the phase and the job's percent", () => {
    const line = jobLine(held({ phase: "Encoding", done: 120, total: 300, unit: "frames" }), 1_000_000);
    expect(line).toMatchObject({ label: "Render mp4", phase: "Encoding", percent: 40, stale: false });
    expect(line.title).toBe("Render mp4 · Encoding\n120 of 300 frames");
  });

  it("says no percent for a job that gave no count", () => {
    const line = jobLine(held({ command: undefined }), 1_030_000);
    expect(line.percent).toBeNull();
    expect(line.elapsedMs).toBe(90_000);
  });

  it("joins the background roster, and the oldest entry leads", () => {
    const job = held({ elapsedMs: 600_000, done: 1, total: 4 }, 1_000_000);
    const summary = backgroundSummary(
      [{ id: "t", label: "codex exec", kind: "local_bash", startedAt: 900_000 }],
      1_000_000,
      [job],
    )!;
    expect(summary.count).toBe(2);
    expect(summary.label).toBe("Render mp4");
    expect(summary.job?.percent).toBe(25);
    // A background command older than the job leads, and carries no job line.
    const older = backgroundSummary(
      [{ id: "t", label: "codex exec", kind: "local_bash", startedAt: 1 }],
      1_000_000,
      [job],
    )!;
    expect(older.label).toBe("codex exec");
    expect(older.job).toBeNull();
  });

  it("a worker's row says the job: phase and percent, else label and elapsed", () => {
    expect(jobRowNote(jobLine(held({ phase: "Encoding", done: 60, total: 100 }), 1_000_000), elapsedLabel)).toBe("Encoding · 60%");
    expect(jobRowNote(jobLine(held({ done: 60, total: 100 }), 1_000_000), elapsedLabel)).toBe("Render mp4 · 60%");
    expect(jobRowNote(jobLine(held({}), 1_000_000), elapsedLabel)).toBe("Render mp4 · 1m 00s");
  });
});

describe("which card started a job", () => {
  const card = (id: string, command: string) => ({ id, command });

  it("reads a command from a call's arguments", () => {
    expect(commandOfArgs({ command: "ls -la" })).toBe("ls -la");
    expect(commandOfArgs({ command: ["bash", "-lc", "make"] })).toBe("bash -lc make");
    expect(commandOfArgs({ cmd: "make" })).toBe("make");
    expect(commandOfArgs({ file_path: "/x" })).toBe("");
    expect(commandOfArgs(null)).toBe("");
  });

  it("collects every call that ran a command", () => {
    const messages = [{ blocks: [
      { kind: "text" as const, text: "hi" },
      { kind: "tool" as const, id: "t1", name: "Bash", argsJson: "", args: { command: "octiq-job -- make" } },
      { kind: "tool" as const, id: "t2", name: "Read", argsJson: "", args: { file_path: "/x" } },
    ] }];
    expect(callCommands(messages as never)).toEqual([{ id: "t1", command: "octiq-job -- make" }]);
  });

  it("marks the one card that ran octiq-job with the job's command", () => {
    const calls = [
      card("t1", "ls"),
      card("t2", `octiq-job --label "Render mp4" -- npx remotion render src/index.ts Main out.mp4`),
    ];
    expect([...jobCalls(calls, [held()]).keys()]).toEqual(["t2"]);
  });

  it("matches by the label when the job names no command", () => {
    const calls = [card("t1", `octiq-job --label 'Render mp4' -- ffmpeg -i a.mov b.mp4`)];
    expect([...jobCalls(calls, [held({ command: undefined })]).keys()]).toEqual(["t1"]);
  });

  it("never a card that did not run octiq-job", () => {
    expect(jobCalls([card("t1", "npx remotion render src/index.ts Main out.mp4")], [held()]).size).toBe(0);
    expect(jobCalls([card("t1", "my-octiq-jobs -- npx remotion render src/index.ts Main out.mp4")], [held()]).size).toBe(0);
  });

  it("marks none when two cards match one job", () => {
    const line = "octiq-job -- npx remotion render src/index.ts Main out.mp4";
    expect(jobCalls([card("t1", line), card("t2", line)], [held()]).size).toBe(0);
  });

  it("marks none when two jobs match one card", () => {
    const calls = [card("t1", "octiq-job --label build -- cargo build --release")];
    const jobs = [
      held({ id: "a", label: "build", command: "cargo build" }),
      held({ id: "b", label: "build", command: "cargo build --release" }),
    ];
    expect(jobCalls(calls, jobs).size).toBe(0);
  });

  it("marks nothing for a job that ended", () => {
    const calls = [card("t1", "octiq-job -- npx remotion render src/index.ts Main out.mp4")];
    expect(jobCalls(calls, [held({ status: "done" })]).size).toBe(0);
  });

  it("the card's chip says the job's percent, or the plain words", () => {
    expect(backgroundChip({ done: 42, total: 100 })).toBe("in background · 42%");
    expect(backgroundChip({})).toBe("in background");
  });
});

describe("the wake turn", () => {
  it("is known by its id and names its job", () => {
    expect(isJobTurn("octiq-job-job_1")).toBe(true);
    expect(isJobTurn("octiq-complete-1")).toBe(false);
    expect(isJobTurn(undefined)).toBe(false);
    expect(jobIdOfTurn("octiq-job-job_1")).toBe("job_1");
  });

  it("says how the job ended, from the job the page holds", () => {
    const turn = { turnId: "octiq-job-job_1" };
    expect(jobTurnBubble(turn, wire({ status: "done", exitCode: 0 }))).toEqual({ label: "Job finished", detail: "Render mp4 · exit 0" });
    expect(jobTurnBubble(turn, wire({ status: "failed", exitCode: 1 }))).toEqual({ label: "Job failed", detail: "Render mp4 · exit 1" });
    expect(jobTurnBubble(turn, wire({ status: "interrupted", exitCode: null }))).toEqual({ label: "Job interrupted", detail: "Render mp4 · no exit code" });
    expect(jobTurnBubble(turn, wire({ status: "ended", source: "registered", exitCode: null }))).toEqual({ label: "Job ended", detail: "Render mp4 · no exit code" });
    // A wrapper killed by a signal failed with no exit code to give.
    expect(jobTurnBubble(turn, wire({ status: "failed", exitCode: null }))).toEqual({ label: "Job failed", detail: "Render mp4 · no exit code" });
    // Absent is not null: nothing is said of it.
    expect(jobTurnBubble(turn, wire({ status: "ended" }))).toEqual({ label: "Job ended", detail: "Render mp4" });
  });

  it("reads nothing out of the host's words for a job it does not hold", () => {
    expect(jobTurnBubble({ turnId: "octiq-job-gone" }, undefined)).toEqual({ label: "Job ended", detail: "" });
    expect(jobTurnBubble({ turnId: "turn-1" }, wire())).toBeNull();
  });
});

describe("jobs a restart interrupted", () => {
  // The host's own sentence (`chat_jobs.rs`, `octiq_job_interrupted`).
  const one = "OctiqFlow restarted while 1 job(s) ran and can no longer follow them: Render mp4. Check their output before starting them again.";
  const two = "OctiqFlow restarted while 2 job(s) ran and can no longer follow them: Build, Render mp4. Check their output before starting them again.";

  it("reads the count and the jobs' names", () => {
    expect(interruptedJobs(one)).toEqual({ count: 1, labels: "Render mp4" });
    expect(interruptedJobs(two)).toEqual({ count: 2, labels: "Build, Render mp4" });
    expect(interruptedJobs("1 background task(s) interrupted when the provider process ended: a1. Retained output")).toBeNull();
  });

  it("is a notice of the chat, said once however often the line is read", () => {
    const event = { type: "octiq_job_interrupted", job_ids: ["job_1"], message: one };
    let state = reduceChat(emptyChat(), event);
    state = reduceChat(state, event);
    expect(state.notices).toEqual([one]);
  });

  it("is folded as a count, with the host's sentence in the panel", () => {
    expect(presentNotice(one)).toMatchObject({ title: "1 job interrupted", detail: one });
    expect(presentNotice(two).title).toBe("2 jobs interrupted");
    expect(noticesHeadline(presentNotices([one]), 1)).toBe("1 job interrupted");
  });
});
