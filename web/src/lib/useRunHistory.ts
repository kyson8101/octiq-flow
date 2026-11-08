import { useContext, useEffect, useState } from "react";
import { bridge } from "./bridge";
import type { OrchestrationSnapshot } from "./orchestration";
import { runWaits } from "./runWaits";
import { RUN_LISTS } from "./orchestrationSummaryFeed";
import { RunDetailOnScreen } from "./useOrchestrationSnapshot";

/** The picker/archive list belongs to its visible panel, never the app-wide
 * feed. Releasing the panel releases historical rows as well as their text. */
export function useRunHistory(current: OrchestrationSnapshot, coordinatorChatKey?: string, workspaceId?: string, enabled = true) {
  const shown = useContext(RunDetailOnScreen);
  const summary = current.summary;
  const [reading, setReading] = useState<{ key: string; snapshot?: OrchestrationSnapshot; error?: string }>();
  const key = JSON.stringify([coordinatorChatKey, workspaceId]);
  useEffect(() => {
    setReading(undefined);
    if (!shown || !summary || !enabled) return;
    let live = true, busy = false, dirty = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (busy) { dirty = true; return; }
      busy = true; dirty = false;
      try {
        const snapshot = await bridge.invoke<OrchestrationSnapshot>("orchestration_summary", { includeEnded: true, coordinatorChatKey, workspaceId });
        if (live && !dirty) setReading({ key, snapshot });
      } catch (error) {
        if (live && !dirty) setReading(previous => ({ key, snapshot: previous?.key === key ? previous.snapshot : undefined, error: String(error) }));
      }
      finally { busy = false; if (live && dirty) timer = setTimeout(() => { timer = undefined; void read(); }, 1000); }
    };
    const changed = () => { dirty = true; if (!busy && !timer) timer = setTimeout(() => { timer = undefined; void read(); }, 1000); };
    const off = bridge.on("orchestration-changed", changed);
    const state = bridge.onState(connection => { if (connection === "open") void read(); });
    return () => { live = false; clearTimeout(timer); off(); state(); };
  }, [shown, summary, coordinatorChatKey, workspaceId, key, enabled]);
  const history = shown && reading?.key === key ? reading.snapshot : undefined;
  return { snapshot: history ? withRunHistory(current, history) : current, error: shown && reading?.key === key ? reading.error : undefined };
}

/** The global reading owns live facts, including absence. */
export function withRunHistory(current: OrchestrationSnapshot, history: OrchestrationSnapshot): OrchestrationSnapshot {
  const own = new Set(current.runs.map(run => run.id));
  // History may contribute ended runs only. Absence from the current global
  // reading must never resurrect a formerly active plan or decision.
  const ended = new Set(history.runs.filter(run => runWaits(history, run).ended).map(run => run.id));
  const result = { ...current, runRevisions: { ...history.runRevisions, ...current.runRevisions }, reports: { ...history.reports, ...current.reports } };
  for (const list of RUN_LISTS) {
    const historical = (history[list] ?? []).filter(row => {
      const id = list === "runs" ? row.id : (row as { runId: string }).runId;
      return ended.has(id) && !own.has(id);
    });
    (result as unknown as Record<string, unknown>)[list] = [...historical, ...(current[list] ?? [])];
  }
  return result;
}
