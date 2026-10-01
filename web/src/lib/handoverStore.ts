// The handovers the host holds, kept current over the socket. One list for
// the whole page: a card in the source chat and the one in the new chat read
// the same record, so they cannot disagree.
import { useCallback, useEffect, useState } from "react";
import { bridge } from "./bridge";
import { mergeHandover, type Handover } from "./handover";

export function useHandovers(enabled = true) {
  const [handovers, setHandovers] = useState<Handover[]>([]);

  const refresh = useCallback(async () => {
    try {
      const list = await bridge.invoke<Handover[]>("handover_list");
      setHandovers([...list].sort((a, b) => a.createdAt - b.createdAt));
    } catch {
      // An older server has no handovers; nothing to draw.
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const off = bridge.on<Handover>("handover-changed", (record) => {
      setHandovers((list) => mergeHandover(list, record));
    });
    // A reload or reconnect reads the durable list again: a card decided on
    // another device while this one was away shows its decision.
    const reconnect = bridge.onState((state) => { if (state === "open") void refresh(); });
    return () => { off(); reconnect(); };
  }, [enabled, refresh]);

  /** The person's decision. Only this socket can make it; an agent cannot. */
  const decide = useCallback(async (id: string, confirm: boolean): Promise<Handover> => {
    const record = await bridge.invoke<Handover>(confirm ? "handover_confirm" : "handover_decline", { id });
    setHandovers((list) => mergeHandover(list, record));
    return record;
  }, []);

  return { handovers, decide, refresh };
}
