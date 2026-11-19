import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { ConnectionState } from "./bridge";
import { loadUnfinishedDeskChats, type TeamAgent, type UnfinishedDeskChat } from "./agentsMode";
import { continuableDeskChats } from "./frontDesk";
import { isRoute, type Handover } from "./handover";

export function useContinuableDeskChats(
  deskOnScreen: boolean,
  frontDesk: TeamAgent | null,
  conn: ConnectionState,
  handovers: Handover[],
): {
  deskChatsToContinue: UnfinishedDeskChat[];
  setUnfinishedDesk: Dispatch<SetStateAction<UnfinishedDeskChat[]>>;
} {
  // The way back to a front-desk conversation left before it routed: no list
  // shows one, so the new-chat screen offers it. Asked for each time that
  // screen shows the front desk; a route confirmed since drops out at once.
  const [unfinishedDesk, setUnfinishedDesk] = useState<UnfinishedDeskChat[]>([]);
  useEffect(() => {
    if (!deskOnScreen || conn !== "open") return;
    let alive = true;
    void loadUnfinishedDeskChats().then((chats) => { if (alive) setUnfinishedDesk(chats); });
    return () => { alive = false; };
  }, [deskOnScreen, frontDesk?.id, conn]);
  const deskChatsToContinue = useMemo(() => {
    const routedFrom = new Set(
      handovers.filter((h) => isRoute(h) && h.status === "confirmed").map((h) => h.sourceChatKey),
    );
    return continuableDeskChats(unfinishedDesk, frontDesk, routedFrom);
  }, [unfinishedDesk, frontDesk, handovers]);
  return { deskChatsToContinue, setUnfinishedDesk };
}
