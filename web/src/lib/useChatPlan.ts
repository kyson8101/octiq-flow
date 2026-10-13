// The plan of the chat on screen, kept in step with the host.
//
// The host owns the plan (`chat_plan.rs`). This hook mirrors it: one
// `chat_plan_get` when the chat opens, one when the panel opens, one on
// every connect (an event has no replay), then the `chat-plan` event.
// Nothing polls. The host's count of an item's tasks moves with the ledger
// and no event says so (`docs/chat-plan.md`), so the plan is read again when
// what the ledger says of its linked tasks changes
// (`planView.ledgerSignature`), and at no other tick.
//
// The folding is `lib/planView.reducePlans`. Start is the page's command and
// nobody else's; it is sent from here and decided by the host.
//
// One Start is out for a chat at a time (`askPlanStart`, `lib/inFlight`).
// That is held here, in the sender, and not in the control that was
// pressed: the panel unmounts when it is shut, when the view changes and
// when a phone leaves its Plan page, and a control drawn again knew nothing
// of the request still out. What the host said of the last Start is kept
// here too, for the same reason: the control that asked may be gone when
// the answer comes.
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge, type ConnectionState } from "./bridge";
import type { ChatPlan, ChatPlanEvent, ChatPlanStartAnswer } from "./chatPlan";
import { IN_FLIGHT, once, planFlight } from "./inFlight";
import type { OrchestrationSnapshot } from "./orchestration";
import { NO_PLANS, ledgerSignature, reducePlans, startNote, type PlanAction, type Plans } from "./planView";

const said = (error: unknown) => String((error as Error)?.message ?? error);

/** What the host said of a chat's last Start that is left to say under the
 *  control, and the revision it was said of: a plan the agent has changed
 *  since is another plan. */
export type StartSaid = { revision: number; text: string };

/** Send a chat's Start, or the same command again for a plan whose agent
 *  was not told, unless one is already out for that chat: then nothing is
 *  sent and the answer is `IN_FLIGHT`. Start and `Tell the agent` are one
 *  command and share the hold, whichever surface asked. Throws the host's
 *  words when nothing was recorded. */
export function askPlanStart(
  id: string, revision: number, settings: Record<string, unknown>,
): Promise<ChatPlanStartAnswer | typeof IN_FLIGHT> {
  return once(planFlight(id), async () => {
    const ask = () => bridge.invoke<ChatPlanStartAnswer>("chat_plan_start", { chatId: id, revision, start: settings });
    try {
      return await ask();
    } catch (error) {
      // Another tab started the chat between the host's two looks at it.
      if (!said(error).includes("already running")) throw new Error(said(error));
      return await ask().catch((again) => { throw new Error(said(again)); });
    }
  });
}

export function useChatPlan(
  conn: ConnectionState,
  /** The chat whose plan is wanted, or `null` for a chat that keeps none. */
  chatId: string | null,
  /** Whether the panel is on screen. */
  open: boolean,
  snapshot: OrchestrationSnapshot | null | undefined,
) {
  const [plans, setPlans] = useState<Plans>(NO_PLANS);
  const held = useRef(plans);
  /** The latest read asked of each chat: an older one that answers late is
   *  not the plan. */
  const asked = useRef<Record<string, number>>({});

  const dispatch = useCallback((action: PlanAction) => {
    const next = reducePlans(held.current, action);
    if (next === held.current) return;
    held.current = next;
    setPlans(next);
  }, []);

  const read = useCallback((id: string) => {
    const rev = held.current[id]?.rev ?? 0;
    const mine = (asked.current[id] ?? 0) + 1;
    asked.current[id] = mine;
    bridge.invoke<ChatPlan>("chat_plan_get", { chatId: id }).then(
      (plan) => { if (asked.current[id] === mine) dispatch({ type: "read", chatId: id, plan, rev }); },
      (error) => { if (asked.current[id] === mine) dispatch({ type: "unread", chatId: id, error: said(error), rev }); },
    );
  }, [dispatch]);

  useEffect(() => bridge.on<ChatPlanEvent>("chat-plan", (payload) => {
    if (typeof payload?.chatId !== "string" || !payload.plan) return;
    dispatch({ type: "said", chatId: payload.chatId, plan: payload.plan });
  }), [dispatch]);

  // The chat opened, the panel opened, or the socket came back. Closing the
  // panel asks nothing.
  const wasOpen = useRef(false);
  const seen = useRef("");
  useEffect(() => {
    const opened = open && !wasOpen.current;
    wasOpen.current = open;
    if (conn !== "open" || !chatId) { seen.current = ""; return; }
    const key = `${chatId}`;
    if (seen.current === key && !opened) return;
    seen.current = key;
    read(chatId);
  }, [conn, chatId, open, read]);

  // The ledger moved under a plan that links tasks. Only a change of the
  // ledger's own: a plan that changed came with its count.
  const plan = chatId ? plans[chatId]?.plan ?? null : null;
  const signature = ledgerSignature(plan, snapshot);
  const counted = useRef<{ plan: ChatPlan | null; signature: string }>({ plan: null, signature: "" });
  useEffect(() => {
    const before = counted.current;
    counted.current = { plan, signature };
    if (conn !== "open" || !chatId || !plan || before.plan !== plan) return;
    if (!before.signature || !signature || before.signature === signature) return;
    read(chatId);
  }, [conn, chatId, plan, signature, read]);

  /** What the host said of each chat's last Start, for the control to say. */
  const [notes, setNotes] = useState<Readonly<Record<string, StartSaid | null>>>({});

  /** The person's Start, or the same command again for a plan whose agent
   *  was not told. `start` is what the page would start the chat with; the
   *  host uses it only for a chat with no process. Answers `IN_FLIGHT`, and
   *  sends nothing, while one is out for the chat. Throws the host's words
   *  when nothing was recorded. */
  const start = useCallback(async (id: string, revision: number, settings: Record<string, unknown>) => {
    const note = (next: StartSaid | null) => setNotes((before) => (before[id] === next ? before : { ...before, [id]: next }));
    try {
      const answer = await askPlanStart(id, revision, settings);
      // Nothing was sent: what the request that is out comes to say stands.
      if (answer === IN_FLIGHT) return answer;
      const left = startNote(answer);
      note(left ? { revision: answer.plan?.revision ?? revision, text: left } : null);
      if (answer?.plan) dispatch({ type: "answered", chatId: id, plan: answer.plan });
      return answer;
    } catch (error) {
      // A refusal recorded nothing: the host's words, for the revision asked.
      note({ revision, text: said(error) });
      throw error;
    }
  }, [dispatch]);

  return { held: chatId ? plans[chatId] : undefined, plan, read, start, said: chatId ? notes[chatId] ?? null : null };
}
