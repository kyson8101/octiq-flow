import { useCallback, useEffect, useState } from "react";
import { bridge } from "./bridge";

export type SandboxSource = { path: string; revision: string | null; dirty: boolean; digest: string | null };
export type SandboxEnvironment = {
  id: string; chatKey: string; enabled: boolean; locked: boolean; cwd: string;
  /** "stale": its sources, recipe or fixture moved after the check.
   *  "unhealthy": a service it needs was found stopped or unhealthy. Both
   *  keep `checkedAt`, the last check that passed. */
  state: "unverified" | "preparing" | "ready" | "stale" | "unhealthy" | "stopped" | "error";
  checkedAt: number | null; error: string | null; urls: Record<string, string>;
  sourceRevision: string | null; sourceDirty: boolean | null; fixtureVersion: string | null;
  /** What the last passing check covered: every repository built from. */
  fingerprint?: { sources: SandboxSource[]; recipe: string | null; fixtureVersion: string | null } | null;
  invalidated?: { kind: string; reason: string; at: number } | null;
  /** The person keeps it running; the host's lifecycle leaves it alone. */
  lease?: { by: string; at: number } | null;
  stopped?: { by: string; reason: string; at: number } | null;
  /** When a health probe last looked. */
  probedAt?: number | null;
};
export type SandboxCapacity = {
  limit: number;
  live: string[];
  waiting: { label: string; keys: string[]; since: number }[];
};
export type SandboxSnapshot = {
  defaultEnabled: boolean;
  environments: Record<string, SandboxEnvironment>;
  capacity?: SandboxCapacity | null;
};

export function useSandboxes(enabled = true) {
  const [snapshot, setSnapshot] = useState<SandboxSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setSnapshot(await bridge.invoke<SandboxSnapshot>("sandbox_snapshot")); setError(null); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const off = bridge.on("sandbox-changed", () => { void refresh(); });
    const reconnect = bridge.onState(state => { if (state === "open") void refresh(); });
    return () => { off(); reconnect(); };
  }, [refresh, enabled]);
  return { snapshot, error, refresh };
}
