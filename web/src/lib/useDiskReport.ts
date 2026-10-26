import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { readDiskProgress, readDiskState, type DiskState } from "./diskReport";

const message = (error: unknown) => String((error as Error)?.message ?? error);

/** No scan on mount or timer: reads only reconnect and host events. */
export function useDiskReport(connected: boolean) {
  const [state, setState] = useState<DiskState>({ running: null, report: null });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const revision = useRef(0);
  const mounted = useRef(false);
  const current = useRef(state);
  const finished = useRef(new Set<string>());
  const update = useCallback((next: DiskState) => { current.current = next; setState(next); }, []);
  const reload = useCallback(async () => {
    const rev = ++revision.current;
    try {
      const result = await bridge.invoke<unknown>("disk_scan_state", {});
      if (!mounted.current || rev !== revision.current) return;
      const next = readDiskState(result);
      if (next.running && finished.current.has(next.running.scanId)) next.running = null;
      update(next);
      setError(null);
    } catch (reason) {
      if (mounted.current && rev === revision.current) setError(message(reason));
    } finally {
      if (mounted.current && rev === revision.current) setLoading(false);
    }
  }, [update]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; ++revision.current; };
  }, []);
  useEffect(() => {
    if (!connected) { setLoading(false); return; }
    // Subscribe before asking for state, so a done event cannot fall in a gap.
    const offProgress = bridge.on<unknown>("disk-scan-progress", payload => {
      const progress = readDiskProgress(payload);
      if (!progress || finished.current.has(progress.scanId)) return;
      if (current.current.running && current.current.running.scanId !== progress.scanId) return;
      ++revision.current;
      update({ ...current.current, running: progress });
      setLoading(false);
    });
    const offDone = bridge.on<{ scanId?: string; ok?: boolean; error?: string }>("disk-scan-done", payload => {
      if (!payload?.scanId) return;
      finished.current.add(payload.scanId);
      if (current.current.running?.scanId === payload.scanId) update({ ...current.current, running: null });
      void reload().then(() => {
        if (mounted.current && payload.error) setError(String(payload.error));
      });
    });
    void reload();
    return () => { offProgress(); offDone(); ++revision.current; };
  }, [connected, reload, update]);
  const scan = useCallback(async () => {
    if (!connected || pending) return;
    setPending(true);
    setError(null);
    const running = current.current.running;
    try {
      await bridge.invoke(running ? "disk_scan_cancel" : "disk_scan_start", running ? { scanId: running.scanId } : {});
      if (mounted.current) await reload();
    } catch (reason) {
      if (mounted.current) setError(message(reason));
    } finally { if (mounted.current) setPending(false); }
  }, [connected, pending, reload]);
  return { ...state, error, pending, loading, scan };
}
