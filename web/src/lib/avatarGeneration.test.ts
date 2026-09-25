import { describe, expect, it } from "vitest";
import { genReducer, waitLabel, type AvatarJob, type GenState } from "./avatarGeneration";
import { centreSquare, uploadProblem } from "./avatarImage";

const job = (patch: Partial<AvatarJob>): AvatarJob => ({ id: "j1", state: "running", startedAt: 1, ...patch });

describe("avatar generation states", () => {
  it("offers generation only when Codex says it can", () => {
    expect(genReducer({ kind: "checking" }, { type: "status", status: { available: true, reason: "" } })).toEqual({ kind: "idle" });
    expect(genReducer({ kind: "checking" }, { type: "status", status: { available: false, reason: "Codex is not signed in.", setup: "Run `codex login`" } }))
      .toEqual({ kind: "unavailable", reason: "Codex is not signed in.", setup: "Run `codex login`" });
    expect(genReducer({ kind: "checking" }, { type: "statusFailed", error: "no such command" }).kind).toBe("unavailable");
    // Nothing can start from unavailable.
    expect(genReducer({ kind: "unavailable", reason: "x" }, { type: "start" }).kind).toBe("unavailable");
  });

  it("runs, then offers the picture for acceptance", () => {
    let state: GenState = genReducer({ kind: "idle" }, { type: "start" });
    state = genReducer(state, { type: "started", job: job({}) });
    expect(state).toEqual({ kind: "running", jobId: "j1", startedAt: 1 });
    expect(genReducer(state, { type: "job", job: job({ state: "done" }) })).toBe(state);
    state = genReducer(state, { type: "job", job: job({ state: "done", image: "data:image/png;base64,AA==" }) });
    expect(state).toEqual({ kind: "candidate", image: "data:image/png;base64,AA==" });
    // Regenerate from a candidate.
    expect(genReducer(state, { type: "start" }).kind).toBe("starting");
    expect(genReducer(state, { type: "accept" }).kind).toBe("idle");
  });

  it("ignores results for a job it is no longer waiting for", () => {
    const running: GenState = { kind: "running", jobId: "j2", startedAt: 1 };
    expect(genReducer(running, { type: "job", job: job({ id: "j1", state: "done", image: "x" }) })).toBe(running);
    const cancelled = genReducer(running, { type: "cancel" });
    expect(cancelled).toEqual({ kind: "idle" });
    expect(genReducer(cancelled, { type: "job", job: job({ id: "j2", state: "done", image: "x" }) })).toEqual({ kind: "idle" });
  });

  it("says why a generation failed", () => {
    const running: GenState = { kind: "running", jobId: "j1", startedAt: 1 };
    expect(genReducer(running, { type: "job", job: job({ state: "failed", error: "Codex finished without saving an image." }) }))
      .toEqual({ kind: "failed", error: "Codex finished without saving an image." });
    expect(genReducer({ kind: "starting" }, { type: "startFailed", error: "boom" })).toEqual({ kind: "failed", error: "boom" });
  });

  it("words the wait without a ticking clock", () => {
    expect(waitLabel(0, 10_000)).toContain("about a minute");
    expect(waitLabel(0, 60_000)).toBe("Still drawing…");
    expect(waitLabel(0, 200_000)).toBe("Taking longer than usual…");
  });
});

describe("avatar uploads", () => {
  it("accepts only small PNG, JPEG and WebP files", () => {
    expect(uploadProblem({ type: "image/png", size: 10 })).toBeNull();
    expect(uploadProblem({ type: "image/svg+xml", size: 10 })).toMatch(/PNG, JPEG or WebP/);
    expect(uploadProblem({ type: "image/gif", size: 10 })).not.toBeNull();
    expect(uploadProblem({ type: "image/jpeg", size: 9 * 1024 * 1024 })).toMatch(/8 MB/);
    expect(uploadProblem({ type: "image/webp", size: 0 })).toMatch(/empty/);
  });

  it("crops to the centred square", () => {
    expect(centreSquare(1254, 1254)).toEqual({ sx: 0, sy: 0, side: 1254 });
    expect(centreSquare(400, 300)).toEqual({ sx: 50, sy: 0, side: 300 });
    expect(centreSquare(300, 500)).toEqual({ sx: 0, sy: 100, side: 300 });
  });
});
