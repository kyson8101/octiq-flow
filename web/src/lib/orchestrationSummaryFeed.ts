import { bridge } from "./bridge";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot, type WorkerExecution } from "./orchestration";
import { createLegacyOrchestrationFeed, executionUpdate, withExecution, READ_GAP_MS, NOTIFY_MS, type OrchestrationFeedState } from "./orchestrationFeed";
import type { TaskStatus } from "./chatTask";
import { seeHolds } from "./taskHold";

const unavailable = (e: unknown) => String(e).includes("not available on this backend");
/** Replace one run, including records removed by its latest read. All global
 * readers retain the summary; detail text is never injected into this value. */
export function replaceRun(before: OrchestrationSnapshot, next: OrchestrationSnapshot, runId: string): OrchestrationSnapshot {
  const result = { ...before, runRevisions: { ...before.runRevisions, ...next.runRevisions } };
  for (const list of ["runs", "tasks", "attempts", "gates", "nativeDecisions", "messages", "notifications", "services", "bridges", "peerAsks"] as const) {
    const old = before[list] ?? [];
    const incoming = next[list] ?? [];
    // Preserve the host's list order for an existing run.
    const at = old.findIndex(item => (list === "runs" ? item.id : (item as { runId?: string }).runId) === runId);
    const kept = old.filter(item => (list === "runs" ? item.id : (item as { runId?: string }).runId) !== runId);
    kept.splice(at < 0 ? 0 : at, 0, ...incoming as never[]);
    (result as unknown as Record<string, unknown>)[list] = kept;
  }
  const oldKeys = new Set(before.attempts.filter(a => a.runId === runId).map(a => a.workerChatKey));
  const coordinator = before.runs.find(r => r.id === runId)?.coordinatorChatKey;
  if (coordinator) oldKeys.add(coordinator);
  result.reports = Object.fromEntries(Object.entries(before.reports ?? {}).filter(([key]) => !oldKeys.has(key)));
  Object.assign(result.reports, next.reports);
  return result;
}

/** Global events keep their legacy wire shape. Store only summary-sized facts
 * here too; a report or execution patch must not smuggle full detail back in. */
const short = (text: string) => text.length <= 512 ? text : JSON.parse(JSON.stringify(text.slice(0, 512))) as string;
export function compactExecution(execution: WorkerExecution): WorkerExecution {
  const { state, lastActivityAt, lastProgressAt, currentOperation, latestError, retryCount, nextRetryAt, retryModel, stalledAt } = execution;
  return { state, lastActivityAt, lastProgressAt, retryCount, nextRetryAt, retryModel, stalledAt,
    currentOperation: typeof currentOperation === "string" ? short(currentOperation) : currentOperation,
    latestError: latestError ? { ...latestError, message: short(latestError.message) } : latestError };
}

type Lease = { readers: number; reading: boolean; dirty: boolean; timer?: ReturnType<typeof setTimeout> };
export function createOrchestrationFeed() {
  let state: OrchestrationFeedState = { snapshot: null, error: null, details: new Map(), detailErrors: new Map() };
  const listeners = new Set<() => void>();
  const leases = new Map<string, Lease>();
  const legacy = createLegacyOrchestrationFeed();
  let fallback = false, detachLegacy: (() => void) | undefined;
  let detach: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, notifyTimer: ReturnType<typeof setTimeout> | undefined;
  let reading = false, whole = false, lastRead = -Infinity, unseen = false;
  let dirty = new Set<string>();
  let patches: Array<(s: OrchestrationSnapshot) => OrchestrationSnapshot> = [];
  let waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  const hidden = () => typeof document !== "undefined" && document.hidden;
  const notify = (now = false) => {
    unseen = true;
    if (hidden()) return;
    const tell = () => { notifyTimer = undefined; if (hidden()) return; unseen = false; for (const fn of [...listeners]) fn(); };
    if (now) { clearTimeout(notifyTimer); tell(); }
    else notifyTimer ??= setTimeout(tell, NOTIFY_MS);
  };
  const publish = (snapshot: OrchestrationSnapshot) => {
    seeHolds(snapshot.tasks, Date.now());
    state = { ...state, snapshot, error: null }; notify(true);
  };
  const patch = (change: (s: OrchestrationSnapshot) => OrchestrationSnapshot) => {
    if (fallback) return legacy.patch(change);
    if (reading) patches.push(change);
    if (state.snapshot) { state = { ...state, snapshot: change(state.snapshot) }; seeHolds(state.snapshot!.tasks, Date.now()); notify(); }
  };
  const detailRead = async (id: string, lease: Lease) => {
    if (lease.reading || leases.get(id) !== lease || fallback) return;
    lease.reading = true; lease.dirty = false;
    try {
      let detail: OrchestrationSnapshot;
      try { detail = await bridge.invoke<OrchestrationSnapshot>("orchestration_run_detail", { runId: id }); }
      catch (e) {
        if (!unavailable(e)) throw e;
        detail = await bridge.invoke<OrchestrationSnapshot>("orchestration_snapshot", { runId: id });
      }
      if (leases.get(id) !== lease) return;
      const details = new Map(state.details).set(id, detail);
      const errors = new Map(state.detailErrors); errors.delete(id);
      state = { ...state, details, detailErrors: errors }; notify(true);
    } catch (e) {
      if (leases.get(id) === lease) {
        state = { ...state, detailErrors: new Map(state.detailErrors).set(id, String(e)) }; notify(true);
      }
    } finally {
      lease.reading = false;
      if (lease.dirty && leases.get(id) === lease) lease.timer = setTimeout(() => { lease.timer = undefined; void detailRead(id, lease); }, READ_GAP_MS);
    }
  };
  const invalidateDetail = (id?: string) => {
    for (const [key, lease] of leases) {
      if (id && key !== id) continue;
      lease.dirty = true;
      if (!lease.reading && !lease.timer) lease.timer = setTimeout(() => { lease.timer = undefined; void detailRead(key, lease); }, NOTIFY_MS);
    }
  };
  const runRead = async () => {
    if (reading || (!whole && !dirty.size && !waiters.length)) return;
    const all = whole || !state.snapshot;
    const ids = dirty; dirty = new Set(); whole = false;
    const settled = waiters; waiters = [];
    reading = true; patches = []; lastRead = Date.now();
    try {
      if (fallback) { await legacy.refresh(); }
      else {
        try {
          if (all) {
            let next = await bridge.invoke<OrchestrationSnapshot>("orchestration_summary");
            for (const change of patches) next = change(next);
            publish(next ?? EMPTY_ORCHESTRATION);
          } else {
            // Sequential reads bound peak parsed payload to one run. Changes
            // during any read stay dirty for a follow-up, even with new epochs.
            for (const id of ids) {
              const run = await bridge.invoke<OrchestrationSnapshot>("orchestration_summary", { runId: id });
              let next = replaceRun(state.snapshot!, run, id);
              for (const change of patches) next = change(next);
              publish(next);
            }
          }
        } catch (e) {
          if (!unavailable(e)) throw e;
          fallback = true;
          detachLegacy = legacy.subscribe(() => { state = legacy.getState(); notify(true); });
          // subscribe starts the legacy read; refresh would enqueue a second.
          await new Promise<void>((resolve, reject) => {
            const check = () => { const s = legacy.getState(); if (!s.snapshot && !s.error) return; off(); s.error ? reject(new Error(s.error)) : resolve(); };
            const off = legacy.subscribe(check); check();
          });
          for (const [id, lease] of leases) legacyReleases.set(lease, legacy.detail(id));
        }
      }
      for (const waiter of settled) waiter.resolve();
    } catch (e) {
      state = { ...state, error: String(e) }; notify(true);
      for (const waiter of settled) waiter.reject(e);
    } finally {
      reading = false; patches = []; schedule(false);
    }
  };
  const schedule = (now: boolean) => {
    if (reading || (!whole && !dirty.size && !waiters.length) || (!now && hidden())) return;
    if (now) { clearTimeout(timer); timer = undefined; void runRead(); }
    else timer ??= setTimeout(() => { timer = undefined; void runRead(); }, Math.max(0, lastRead + READ_GAP_MS - Date.now()));
  };
  const refresh = () => {
    whole = true; invalidateDetail();
    const promise = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }));
    promise.catch(() => {}); schedule(true); return promise;
  };
  const legacyReleases = new Map<Lease, () => void>();
  const attach = () => {
    if (fallback) detachLegacy = legacy.subscribe(() => { state = legacy.getState(); notify(true); });
    const offs = [
      bridge.on<{ runId?: string; revision?: string }>("orchestration-changed", payload => {
        if (fallback) return; // legacy owns its event listeners
        invalidateDetail(payload?.runId);
        const update = executionUpdate(payload);
        if (update && state.snapshot?.attempts.some(a => a.id === update.attemptId)) patch(s => withExecution(s, { ...update, execution: compactExecution(update.execution) }));
        else if (payload?.runId) dirty.add(payload.runId);
        else whole = true;
        schedule(false);
      }),
      bridge.on<TaskStatus>("chat-task", status => {
        if (!status?.report || fallback) return;
        const key = `chat:${status.chatId}`;
        const report = { objective: "", nextStep: "", steps: status.report.steps.map(step => ({ state: step.state, title: short(step.title) })), reportedAt: status.report.reportedAt, reportedBy: status.report.reportedBy };
        patch(s => ({ ...s, reports: { ...s.reports, [key]: report } }));
      }),
      bridge.on("safety-block-expired", () => { if (!fallback) { whole = true; invalidateDetail(); schedule(false); } }),
      bridge.on("orchestration-auto-plan", () => { if (!fallback) void refresh(); }),
      bridge.onState(connection => { if (connection === "open" && !fallback) void refresh(); }),
    ];
    const visible = () => { if (!hidden()) { if (unseen) notify(true); schedule(false); } };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", visible);
    return () => { offs.forEach(off => off()); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", visible); detachLegacy?.(); detachLegacy = undefined; };
  };
  return {
    getState: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn); detach ??= attach();
      return () => { listeners.delete(fn); if (!listeners.size) { detach?.(); detach = undefined; clearTimeout(timer); timer = undefined; clearTimeout(notifyTimer); notifyTimer = undefined; } };
    },
    refresh,
    patch,
    detail(id: string) {
      let lease = leases.get(id);
      if (lease) lease.readers++;
      else {
        lease = { readers: 1, reading: false, dirty: false }; leases.set(id, lease);
        if (fallback) legacyReleases.set(lease, legacy.detail(id));
        else void detailRead(id, lease);
      }
      const held = lease; let released = false;
      return () => {
        if (released) return; released = true;
        if (leases.get(id) !== held || --held.readers) return;
        leases.delete(id); clearTimeout(held.timer); legacyReleases.get(held)?.(); legacyReleases.delete(held);
        const details = new Map(state.details); details.delete(id);
        const errors = new Map(state.detailErrors); errors.delete(id);
        state = { ...state, details, detailErrors: errors }; notify(true);
      };
    },
  };
}
export const orchestrationFeed = createOrchestrationFeed();
