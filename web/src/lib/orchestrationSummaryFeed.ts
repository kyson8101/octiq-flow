import { bridge } from "./bridge";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot, type WorkerExecution } from "./orchestration";
import { createLegacyOrchestrationFeed, executionUpdate, withExecution, READ_GAP_MS, NOTIFY_MS, type OrchestrationFeedState } from "./orchestrationFeed";
import type { TaskStatus } from "./chatTask";
import { seeHolds } from "./taskHold";
import { valueBytes } from "./valueBytes";

export const RETAINED_RUN_DETAILS = 3;
export const RETAINED_RUN_BYTES = 4 * 1024 * 1024;

const unavailable = (e: unknown) => String(e).includes("not available on this backend");
export const RUN_LISTS = ["runs", "tasks", "attempts", "batches", "gates", "nativeDecisions", "messages", "notifications", "services", "bridges", "peerAsks"] as const;

/** Replace one run, including records removed by its latest read. All global
 * readers retain the summary; detail text is never injected into this value. */
export function replaceRun(before: OrchestrationSnapshot, next: OrchestrationSnapshot, runId: string): OrchestrationSnapshot {
  const revisions = { ...before.runRevisions }; delete revisions[runId];
  const result = { ...before, workerParents: { ...before.workerParents, ...next.workerParents }, runCoordinators: [...new Set([...(before.runCoordinators ?? []), ...(next.runCoordinators ?? [])])], runRevisions: { ...revisions, ...next.runRevisions } };
  for (const list of RUN_LISTS) {
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

/** `execRev`: the newest revision an execution-only patch carried while this
 * lease's read was in flight (see `executionOnly`). */
type Lease = { readers: number; reading: boolean; dirty: boolean; seq: number; execRev?: string; timer?: ReturnType<typeof setTimeout> };
export function createOrchestrationFeed() {
  let state: OrchestrationFeedState = { snapshot: null, error: null, details: new Map(), retainedDetails: new Map(), detailErrors: new Map(), detailPending: new Set() };
  const listeners = new Set<() => void>();
  const leases = new Map<string, Lease>();
  const sizes = new WeakMap<OrchestrationSnapshot, number>();
  const retainedSize = (detail: OrchestrationSnapshot) => {
    let size = sizes.get(detail);
    if (size === undefined) { size = valueBytes(detail, RETAINED_RUN_BYTES); sizes.set(detail, size); }
    return size;
  };
  const retain = (id: string, detail?: OrchestrationSnapshot) => {
    const kept = new Map(state.retainedDetails);
    kept.delete(id);
    if (detail && state.snapshot?.runs.some(run => run.id === id) && retainedSize(detail) <= RETAINED_RUN_BYTES) kept.set(id, detail);
    let bytes = [...kept.values()].reduce((sum, value) => sum + retainedSize(value), 0);
    for (const [key, value] of kept) {
      if (kept.size <= RETAINED_RUN_DETAILS && bytes <= RETAINED_RUN_BYTES) break;
      kept.delete(key); bytes -= retainedSize(value);
    }
    return kept;
  };
  const legacy = createLegacyOrchestrationFeed();
  let heldChatKeys: string[] = [];
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
    const ids = new Set(snapshot.runs.map(run => run.id));
    const retainedDetails = new Map([...(state.retainedDetails ?? [])].filter(([id]) => ids.has(id)));
    state = { ...state, snapshot, retainedDetails, error: null }; notify(true);
  };
  const patch = (change: (s: OrchestrationSnapshot) => OrchestrationSnapshot) => {
    if (fallback) return legacy.patch(change);
    if (reading) patches.push(change);
    if (state.snapshot) { state = { ...state, snapshot: change(state.snapshot) }; seeHolds(state.snapshot!.tasks, Date.now()); notify(); }
  };
  const detailRead = async (id: string, lease: Lease) => {
    if (lease.reading || leases.get(id) !== lease || fallback) return;
    lease.reading = true; lease.dirty = false; lease.execRev = undefined;
    // `retryDetail` abandons a read that never answers by moving this number:
    // whatever the old request says later belongs to nobody.
    const seq = lease.seq;
    try {
      let detail: OrchestrationSnapshot;
      try { detail = await bridge.invoke<OrchestrationSnapshot>("orchestration_run_detail", { runId: id }); }
      catch (e) {
        if (!unavailable(e)) throw e;
        detail = await bridge.invoke<OrchestrationSnapshot>("orchestration_snapshot", { runId: id });
      }
      // A busy worker can invalidate every read before it returns. Keep that
      // answer for display; its revision still cannot authorize a decision.
      // The dirty lease schedules a follow-up without blanking the surface.
      if (leases.get(id) !== lease || lease.seq !== seq) return;
      // Execution-only patches that landed during this read changed no plan,
      // task or approval field, so a read no structural change has outdated
      // is as current as they are (see `executionOnly`).
      if (!lease.dirty && lease.execRev && detail.runRevisions) detail = { ...detail, runRevisions: { ...detail.runRevisions, [id]: lease.execRev } };
      lease.execRev = undefined;
      const details = new Map(state.details).set(id, detail);
      const errors = new Map(state.detailErrors); errors.delete(id);
      const pending = new Set(state.detailPending);
      if (!lease.dirty) pending.delete(id);
      state = { ...state, details, detailErrors: errors, detailPending: pending }; notify(true);
    } catch (e) {
      if (leases.get(id) === lease && lease.seq === seq && !lease.dirty) {
        state = { ...state, detailErrors: new Map(state.detailErrors).set(id, String(e)) }; notify(true);
      }
    } finally {
      if (lease.seq !== seq) return;
      lease.reading = false;
      if (lease.dirty && leases.get(id) === lease) lease.timer = setTimeout(() => { lease.timer = undefined; void detailRead(id, lease); }, READ_GAP_MS);
    }
  };
  /** A worker's tool start or end rides an `orchestration-changed` that moves
   * the run's revision token yet changes nothing a plan card reads. Treating
   * it as an invalidation kept a busy run's detail never `ready`: its plan
   * card was a "Reading plan…" line for as long as a worker worked. The held
   * detail keeps pace with the token instead, but only when it matched the
   * summary before this patch; any structural event still invalidates. */
  const executionOnly = (runId: string, revision: string): boolean => {
    const lease = leases.get(runId);
    if (!lease || fallback) return false;
    if (lease.reading) { lease.execRev = revision; return true; }
    const detail = state.details?.get(runId);
    const before = state.snapshot?.runRevisions?.[runId];
    // A detail that did not match the summary before this patch is stale or
    // not read: it must be read again, or nothing ever would.
    if (!detail?.runRevisions || !before || detail.runRevisions[runId] !== before || state.detailPending?.has(runId)) return false;
    state = { ...state, details: new Map(state.details).set(runId, { ...detail, runRevisions: { ...detail.runRevisions, [runId]: revision } }) };
    return true;
  };
  const invalidateDetail = (id?: string) => {
    const errors = new Map(state.detailErrors);
    const pending = new Set(state.detailPending);
    for (const [key, lease] of leases) {
      if (id && key !== id) continue;
      lease.dirty = true; lease.execRev = undefined;
      pending.add(key);
      errors.delete(key);
      if (!lease.reading && !lease.timer) lease.timer = setTimeout(() => { lease.timer = undefined; void detailRead(key, lease); }, NOTIFY_MS);
    }
    state = { ...state, detailErrors: errors, detailPending: pending }; notify(true);
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
            let next = await bridge.invoke<OrchestrationSnapshot>("orchestration_summary", { heldChatKeys });
            for (const change of patches) next = change(next);
            publish(next ?? EMPTY_ORCHESTRATION);
          } else {
            // Sequential reads bound peak parsed payload to one run. Changes
            // during any read stay dirty for a follow-up, even with new epochs.
            for (const id of ids) {
              const run = await bridge.invoke<OrchestrationSnapshot>("orchestration_summary", { runId: id, heldChatKeys });
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
  /** Read one run's detail again now, whether or not an earlier read is still
   * out: that one is abandoned by its lease and never waited for. */
  const retryDetail = (id: string) => {
    const lease = leases.get(id);
    if (!lease || fallback) return;
    lease.seq++; lease.reading = false; lease.dirty = false; lease.execRev = undefined;
    clearTimeout(lease.timer); lease.timer = undefined;
    const errors = new Map(state.detailErrors); errors.delete(id);
    state = { ...state, detailErrors: errors, detailPending: new Set(state.detailPending).add(id) }; notify(true);
    void detailRead(id, lease);
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
        const update = executionUpdate(payload);
        const execOnly = !!update && !!payload.runId && !!payload.revision && !!state.snapshot?.attempts.some(a => a.id === update.attemptId);
        if (!(execOnly && executionOnly(payload.runId!, payload.revision!))) invalidateDetail(payload?.runId);
        if (update && state.snapshot?.attempts.some(a => a.id === update.attemptId)) patch(s => ({
          ...withExecution(s, { ...update, execution: compactExecution(update.execution) }),
          runRevisions: payload.runId && payload.revision ? { ...s.runRevisions, [payload.runId]: payload.revision } : s.runRevisions,
        }));
        else if (payload?.runId) dirty.add(payload.runId);
        else whole = true;
        schedule(false);
      }),
      bridge.on<TaskStatus>("chat-task", status => {
        if (!status?.report || fallback) return;
        const key = `chat:${status.chatId}`;
        if (!state.snapshot?.attempts.some(a => a.workerChatKey === key)) return;
        const report = { objective: "", nextStep: "", steps: status.report.steps.map(step => ({ state: step.state, title: short(step.title) })), reportedAt: status.report.reportedAt, reportedBy: status.report.reportedBy };
        // A report from an unopened historical chat must not grow the global
        // snapshot again after the host filtered that run out.
        patch(s => s.attempts.some(a => a.workerChatKey === key)
          ? { ...s, reports: { ...s.reports, [key]: report } } : s);
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
    /** Ask again for the summary and for this run's detail. */
    refreshRun(id: string) { const done = refresh(); retryDetail(id); return done; },
    holdChats(keys: string[]) {
      const next = [...new Set(keys)].sort();
      if (JSON.stringify(next) === JSON.stringify(heldChatKeys)) return;
      heldChatKeys = next;
      if (!fallback) void refresh();
    },
    patch,
    detail(id: string) {
      let lease = leases.get(id);
      if (lease) lease.readers++;
      else {
        lease = { readers: 1, reading: false, dirty: false, seq: 0 }; leases.set(id, lease);
        if (fallback) legacyReleases.set(lease, legacy.detail(id));
        else {
          // Promote only the display evidence. Even equal revisions must wait
          // for this lease's read, including invalidations while it was away.
          const details = new Map(state.details);
          const retainedDetails = new Map(state.retainedDetails);
          const retained = retainedDetails.get(id);
          if (retained) details.set(id, retained);
          retainedDetails.delete(id);
          state = { ...state, details, retainedDetails, detailPending: new Set(state.detailPending).add(id) };
          notify(true); void detailRead(id, lease);
        }
      }
      const held = lease; let released = false;
      return () => {
        if (released) return; released = true;
        if (leases.get(id) !== held || --held.readers) return;
        leases.delete(id); clearTimeout(held.timer); legacyReleases.get(held)?.(); legacyReleases.delete(held);
        const details = new Map(state.details); details.delete(id);
        const errors = new Map(state.detailErrors); errors.delete(id);
        const pending = new Set(state.detailPending); pending.delete(id);
        const retainedDetails = fallback ? state.retainedDetails : retain(id, state.details?.get(id));
        state = { ...state, details, retainedDetails, detailErrors: errors, detailPending: pending }; notify(true);
      };
    },
  };
}
export const orchestrationFeed = createOrchestrationFeed();
