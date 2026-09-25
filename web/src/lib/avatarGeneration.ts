// The avatar generator's states, as a reducer so every transition — including
// the late, cancelled and failed ones — is a test rather than a hope.
//
// Generation runs on the server through the person's own Codex sign-in
// (`agent_avatar.rs`). It takes about a minute, reports by a broadcast, and
// can be cancelled; its picture only ever becomes the avatar when the person
// accepts it. A result that arrives for a job this editor has moved on from —
// cancelled, replaced by a regenerate, or from another tab — is ignored.

export type GenerationStatus = { available: boolean; reason: string; setup?: string };

export type AvatarJob = {
  id: string;
  state: "running" | "done" | "failed" | "cancelled";
  error?: string;
  image?: string;
  startedAt: number;
};

export type GenState =
  | { kind: "checking" }
  | { kind: "unavailable"; reason: string; setup?: string }
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "running"; jobId: string; startedAt: number }
  | { kind: "candidate"; image: string }
  | { kind: "failed"; error: string };

export type GenEvent =
  | { type: "status"; status: GenerationStatus }
  | { type: "statusFailed"; error: string }
  | { type: "start" }
  | { type: "started"; job: AvatarJob }
  | { type: "job"; job: AvatarJob }
  | { type: "startFailed"; error: string }
  | { type: "cancel" }
  | { type: "accept" }
  | { type: "discard" };

export function genReducer(state: GenState, event: GenEvent): GenState {
  switch (event.type) {
    case "status":
      if (state.kind !== "checking" && state.kind !== "unavailable") return state;
      return event.status.available
        ? { kind: "idle" }
        : { kind: "unavailable", reason: event.status.reason, setup: event.status.setup };
    case "statusFailed":
      return state.kind === "checking"
        ? { kind: "unavailable", reason: `Could not check avatar generation: ${event.error}` }
        : state;
    case "start":
      return state.kind === "idle" || state.kind === "candidate" || state.kind === "failed"
        ? { kind: "starting" }
        : state;
    case "started":
      return state.kind === "starting"
        ? { kind: "running", jobId: event.job.id, startedAt: event.job.startedAt }
        : state;
    case "startFailed":
      return state.kind === "starting" ? { kind: "failed", error: event.error } : state;
    case "job": {
      // Only the job this editor is waiting for moves it.
      if (state.kind !== "running" || state.jobId !== event.job.id) return state;
      if (event.job.state === "running") return state;
      if (event.job.state === "done") {
        return event.job.image
          ? { kind: "candidate", image: event.job.image }
          : state; // done, but the picture is fetched separately
      }
      if (event.job.state === "cancelled") return { kind: "idle" };
      return { kind: "failed", error: event.job.error || "Generation failed." };
    }
    case "cancel":
      return state.kind === "running" || state.kind === "starting" ? { kind: "idle" } : state;
    case "accept":
    case "discard":
      return state.kind === "candidate" ? { kind: "idle" } : state;
  }
}

/** "about a minute" style wait copy; never a per-second counter. */
export function waitLabel(startedAt: number, now: number): string {
  const seconds = Math.max(0, (now - startedAt) / 1000);
  if (seconds < 45) return "Drawing… usually about a minute";
  if (seconds < 120) return "Still drawing…";
  return "Taking longer than usual…";
}
