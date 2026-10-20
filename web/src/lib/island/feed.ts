// The island as the host has it, kept in step: read when the page opens and
// on each connect, and again when the host says it changed
// (`island-changed`). Nothing polls. The host's words come back as they are
// when a command is refused.
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import type { Island, WishPace } from "./model";

/** What the host said changed, for the moment it happened: a wish made, a
 *  present given. The page turns it into something a robot does. */
export type IslandChange = { rev: number; what: string; id?: string };

export type IslandFeed = {
  island: Island | null;
  /** Why the last read failed, in the host's words. */
  error: string | null;
  /** The last change the host announced since the page opened. */
  change: IslandChange | null;
  reload(): void;
  dismissWish(id: string): Promise<void>;
  grantWish(id: string): Promise<void>;
  rollWish(): Promise<void>;
  inviteBot(): Promise<void>;
  farewell(id: string): Promise<void>;
  setPace(pace: WishPace): Promise<void>;
};

const message = (reason: unknown) => String((reason as Error)?.message ?? reason);

export function useIsland(connected: boolean): IslandFeed {
  const [island, setIsland] = useState<Island | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [change, setChange] = useState<IslandChange | null>(null);
  const held = useRef<Island | null>(null);
  const asked = useRef(0);

  const reload = useCallback(() => {
    const ask = ++asked.current;
    bridge.invoke<{ island: Island }>("island_get")
      .then((answer) => {
        // A read that went out before a later one answers nothing.
        if (ask !== asked.current || !answer?.island) return;
        const next = answer.island;
        if (held.current && held.current.rev > next.rev) return;
        held.current = next;
        setIsland(next);
        setError(null);
      })
      .catch((reason) => {
        if (ask === asked.current) setError(message(reason));
      });
  }, []);

  useEffect(() => {
    if (!connected) return;
    reload();
    const offIsland = bridge.on<IslandChange>("island-changed", (payload) => {
      if (!payload) return;
      if (held.current && payload.rev <= held.current.rev) return;
      setChange(payload);
      reload();
    });
    const offStatus = bridge.on<{ key: string }>("chat-status", (payload) => {
      if (payload?.key.startsWith("chat:island-wish-")) reload();
    });
    return () => { offIsland(); offStatus(); };
  }, [connected, reload]);

  // A command answers when it is saved; the event that follows brings the
  // island. Reading again here too keeps a page whose event was missed right.
  const run = useCallback(async (cmd: string, args: Record<string, unknown> = {}) => {
    await bridge.invoke(cmd, args);
    reload();
  }, [reload]);

  return {
    island, error, change, reload,
    dismissWish: (id) => run("island_wish_dismiss", { id }),
    grantWish: (id) => run("island_wish_start", { id }),
    rollWish: () => run("island_wish_roll"),
    inviteBot: () => run("island_bot_invite"),
    farewell: (id) => run("island_bot_farewell", { id }),
    setPace: (pace) => run("island_settings_set", { wishPace: pace }),
  };
}
