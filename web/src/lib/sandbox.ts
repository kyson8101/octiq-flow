import { useCallback, useEffect, useState } from "react";
import { bridge } from "./bridge";

export type SandboxEnvironment = {
  id: string; chatKey: string; enabled: boolean; locked: boolean; cwd: string;
  state: "unverified" | "preparing" | "ready" | "stopped" | "error";
  checkedAt: number | null; error: string | null; urls: Record<string, string>;
  sourceRevision: string | null; sourceDirty: boolean | null; fixtureVersion: string | null;
};
export type SandboxSnapshot = { defaultEnabled: boolean; environments: Record<string, SandboxEnvironment> };

export function useSandboxes() {
  const [snapshot, setSnapshot] = useState<SandboxSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setSnapshot(await bridge.invoke<SandboxSnapshot>("sandbox_snapshot")); setError(null); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  }, []);
  useEffect(() => {
    void refresh();
    const off = bridge.on("sandbox-changed", () => { void refresh(); });
    const reconnect = bridge.onState(state => { if (state === "open") void refresh(); });
    return () => { off(); reconnect(); };
  }, [refresh]);
  return { snapshot, error, refresh };
}
