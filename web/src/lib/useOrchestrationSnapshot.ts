import { useEffect, useState } from "react";
import { bridge } from "./bridge";
import type { TaskStatus } from "./chatTask";
import { EMPTY_ORCHESTRATION, type OrchestrationSnapshot } from "./orchestration";

/** Shared by the sidebar and toolbar, even when the orchestrator panel is closed. */
export function useOrchestrationSnapshot(): OrchestrationSnapshot {
  const [snapshot, setSnapshot] = useState(EMPTY_ORCHESTRATION);
  useEffect(() => {
    let live = true;
    let revision = 0;
    const read = () => {
      const requested = ++revision;
      bridge.invoke<OrchestrationSnapshot>("orchestration_snapshot")
        .then((next) => {
          if (live && requested === revision) setSnapshot(next ?? EMPTY_ORCHESTRATION);
        })
        // Keep the last relationship data through a disconnect or an older backend.
        .catch(() => {});
    };
    const offEvent = bridge.on("orchestration-changed", read);
    const offReport = bridge.on("chat-task", (payload) => {
      const status = payload as TaskStatus;
      if (!status?.report) return;
      // Invalidate an older in-flight snapshot before applying this newer report.
      ++revision;
      setSnapshot((before) => ({ ...before, reports: { ...before.reports, [`chat:${status.chatId}`]: status.report! } }));
      read();
    });
    const offState = bridge.onState((state) => state === "open" && read());
    read();
    return () => {
      live = false;
      offEvent();
      offReport();
      offState();
    };
  }, []);
  return snapshot;
}
