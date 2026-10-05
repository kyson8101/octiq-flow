import { bridge } from "./bridge";
import type { TaskStatus } from "./chatTask";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot, type WorkerExecution } from "./orchestration";

/** The orchestration ledger one tab holds, shared by the sidebar, the toolbar
 *  and an open run panel.
 *
 *  Each of those used to refetch the whole ledger — every run, message and
 *  notification, ~1.8 MB on a busy profile — on every `orchestration-changed`,
 *  and a running worker announces one on each tool start and end. Four workers
 *  meant several full downloads a second, per reader, per tab. Now:
 *
 *  - a worker's execution update arrives in the event and patches its attempt;
 *  - a task report arrives in `chat-task` and patches the reports;
 *  - anything else asks for a read. Reads never overlap: asks made while one is
 *    out fold into one follow-up, started no sooner than `READ_GAP_MS` after the
 *    last one began. A hidden tab defers event-driven reads until it is shown.
 *
 *  Readers are told at most every `NOTIFY_MS`, so a burst of patches costs one
 *  render, and a hidden tab is told when it is shown again. */

export const READ_GAP_MS = 1_000;
export const NOTIFY_MS = 250;

export type OrchestrationFeedState = {
  /** Null until the first read lands. */
  snapshot: OrchestrationSnapshot | null;
  error: string | null;
};

type Patch = (snapshot: OrchestrationSnapshot) => OrchestrationSnapshot;
type Waiter = { promise: Promise<void>; resolve: () => void; reject: (problem: unknown) => void; now: boolean };

export type ExecutionUpdate = { attemptId: string; execution: WorkerExecution };

/** The execution a `worker_execution` event carries. Null when the event needs
 *  a read instead: something beyond one attempt's execution changed, or an
 *  older backend sent no execution. */
export function executionUpdate(payload: unknown): ExecutionUpdate | null {
  const event = payload as { attemptId?: unknown; execution?: unknown } | null;
  if (typeof event?.attemptId !== "string" || !event.execution || typeof event.execution !== "object") return null;
  return { attemptId: event.attemptId, execution: event.execution as WorkerExecution };
}

export function withExecution(snapshot: OrchestrationSnapshot, update: ExecutionUpdate): OrchestrationSnapshot {
  return {
    ...snapshot,
    attempts: snapshot.attempts.map((attempt) =>
      attempt.id === update.attemptId ? { ...attempt, execution: update.execution } : attempt),
  };
}

/** The long text a brief read leaves out of a finished run, by list. */
const LEFT_OUT = {
  tasks: ["spec", "result"],
  attempts: ["summary"],
  messages: ["body"],
  notifications: ["body"],
} as const;
type Listed = keyof typeof LEFT_OUT;

/** A brief snapshot with the text of runs read whole put back. `texts` holds
 *  each such run's text keyed `list:id:field` (`textsOf`). Only what the brief
 *  read emptied is filled: everything else it says is newer. */
export function withTexts(snapshot: OrchestrationSnapshot, texts: ReadonlyMap<string, ReadonlyMap<string, string>>): OrchestrationSnapshot {
  if (!texts.size || !snapshot.briefRuns?.length) return snapshot;
  const brief = new Set(snapshot.briefRuns);
  const fill = <T extends { id: string; runId: string }>(list: Listed, items: T[] | undefined): T[] | undefined => items?.map((item) => {
    const run = brief.has(item.runId) ? texts.get(item.runId) : undefined;
    if (!run) return item;
    let next = item;
    for (const field of LEFT_OUT[list]) {
      const text = run.get(`${list}:${item.id}:${field}`);
      const held = (item as Record<string, unknown>)[field];
      if (text !== undefined && !held) next = { ...next, [field]: text };
    }
    return next;
  });
  return {
    ...snapshot,
    tasks: fill("tasks", snapshot.tasks)!,
    attempts: fill("attempts", snapshot.attempts)!,
    messages: fill("messages", snapshot.messages)!,
    notifications: fill("notifications", snapshot.notifications),
  };
}

/** The text of one run read whole, keyed as `withTexts` reads it. */
export function textsOf(run: OrchestrationSnapshot): Map<string, string> {
  const texts = new Map<string, string>();
  for (const list of Object.keys(LEFT_OUT) as Listed[]) {
    for (const item of (run[list] ?? []) as unknown as Record<string, unknown>[]) {
      for (const field of LEFT_OUT[list]) {
        const text = item[field];
        if (typeof text === "string" && text) texts.set(`${list}:${String(item.id)}:${field}`, text);
      }
    }
  }
  return texts;
}

export function createOrchestrationFeed() {
  let state: OrchestrationFeedState = { snapshot: null, error: null };
  /** Text of finished runs the panel has shown, by run, put back after every
   *  read. A run that is active again reads whole, and its kept text goes:
   *  when it finishes again, its text is asked for again. */
  const texts = new Map<string, Map<string, string>>();
  const detailed = new Set<string>();
  const forgetActive = (snapshot: OrchestrationSnapshot) => {
    const brief = new Set(snapshot.briefRuns ?? []);
    for (const runId of [...detailed]) {
      if (brief.has(runId)) continue;
      detailed.delete(runId);
      texts.delete(runId);
    }
  };
  const listeners = new Set<() => void>();
  let detach: (() => void) | null = null;

  let reading = false;
  let waiter: Waiter | null = null;
  let readTimer: ReturnType<typeof setTimeout> | null = null;
  let lastRead = -Infinity;
  /** Patches applied while a read was out; its older answer must not undo them. */
  let sinceRead: Patch[] = [];

  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  let unseen = false;

  const hidden = () => typeof document !== "undefined" && document.hidden;

  const notify = (now = false) => {
    unseen = true;
    if (hidden()) return;
    if (now) {
      if (notifyTimer) clearTimeout(notifyTimer);
      notifyTimer = null;
      unseen = false;
      for (const fn of [...listeners]) fn();
      return;
    }
    notifyTimer ??= setTimeout(() => {
      notifyTimer = null;
      if (!unseen || hidden()) return;
      unseen = false;
      for (const fn of [...listeners]) fn();
    }, NOTIFY_MS);
  };

  const patch = (change: Patch) => {
    state = { ...state, snapshot: change(state.snapshot ?? EMPTY_ORCHESTRATION) };
    if (reading) sinceRead.push(change);
    notify();
  };

  const start = () => {
    const settle = waiter!;
    waiter = null;
    reading = true;
    sinceRead = [];
    lastRead = Date.now();
    bridge.invoke<OrchestrationSnapshot>("orchestration_snapshot", { brief: true }).then(
      (result) => {
        const read = result ?? EMPTY_ORCHESTRATION;
        forgetActive(read);
        let next = withTexts(read, texts);
        for (const change of sinceRead) next = change(next);
        state = { snapshot: next, error: null };
        notify(true);
        settle.resolve();
      },
      (problem) => {
        // Keep the last ledger through a disconnect or an older backend.
        state = { ...state, error: String((problem as Error)?.message ?? problem) };
        notify(true);
        settle.reject(problem);
      },
    ).finally(() => {
      reading = false;
      sinceRead = [];
      if (waiter) schedule();
    });
  };

  const schedule = () => {
    if (reading || !waiter) return;
    if (!waiter.now && hidden()) return; // shown again → visibilitychange asks
    const wait = waiter.now ? 0 : Math.max(0, lastRead + READ_GAP_MS - Date.now());
    if (readTimer) {
      if (wait > 0) return;
      clearTimeout(readTimer);
      readTimer = null;
    }
    if (wait === 0) start();
    else readTimer = setTimeout(() => { readTimer = null; schedule(); }, wait);
  };

  /** Resolves once a read that began after this call has landed. `now` skips
   *  the gap and the hidden-tab deferral — a person just acted. */
  const ask = (now: boolean): Promise<void> => {
    if (!waiter) {
      let resolve!: () => void;
      let reject!: (problem: unknown) => void;
      const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
      // Event-driven asks are never awaited; a failure is already in `error`.
      promise.catch(() => {});
      waiter = { promise, resolve, reject, now };
    }
    waiter.now ||= now;
    const { promise } = waiter;
    schedule();
    return promise;
  };

  const attach = () => {
    const offChanged = bridge.on("orchestration-changed", (payload) => {
      const update = executionUpdate(payload);
      if (update && state.snapshot?.attempts.some((attempt) => attempt.id === update.attemptId)) {
        patch((snapshot) => withExecution(snapshot, update));
      } else {
        void ask(false);
      }
    });
    const offReport = bridge.on("chat-task", (payload) => {
      const status = payload as TaskStatus;
      if (!status?.report || !state.snapshot) return;
      patch((snapshot) => ({ ...snapshot, reports: { ...snapshot.reports, [`chat:${status.chatId}`]: status.report! } }));
    });
    const offState = bridge.onState((connection) => connection === "open" && void ask(true));
    const offDecision = bridge.on("safety-block-expired", () => void ask(false));
    const onVisible = () => {
      if (hidden()) return;
      if (unseen) notify(true);
      schedule();
    };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);
    // Not yet connected: the open above asks. Asking here too sent a second
    // whole-ledger read straight after the first on every page load.
    if (bridge.state === "open") void ask(true);
    return () => {
      offChanged();
      offReport();
      offState();
      offDecision();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
    };
  };

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      detach ??= attach();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && detach) {
          detach();
          detach = null;
        }
      };
    },
    /** Read the ledger now, e.g. after a person's action. Rejects if it fails. */
    refresh: () => ask(true),
    /** Fill in the text a brief read left out of one finished run, once. */
    detail(runId: string) {
      if (detailed.has(runId)) return;
      detailed.add(runId);
      bridge.invoke<OrchestrationSnapshot>("orchestration_snapshot", { runId }).then(
        (run) => {
          texts.set(runId, textsOf(run ?? EMPTY_ORCHESTRATION));
          patch((snapshot) => withTexts(snapshot, texts));
        },
        () => detailed.delete(runId),
      );
    },
    patch,
  };
}

export const orchestrationFeed = createOrchestrationFeed();
