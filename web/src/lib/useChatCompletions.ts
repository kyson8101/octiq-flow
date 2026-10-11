// Which chats are completing, kept in step with the host.
//
// The host owns the state (`ChatManager::completing`). This hook mirrors it:
// the two events while the page is watching, and two reads after a reload,
// because an event has no replay. `chat_activity` names every chat that is
// completing, for the list; `chat_queue_state` adds the wrap-up's turn id for
// the chat on screen. The folding is `lib/chatComplete`.
//
// It also holds the one thing that comes AFTER a completion: the offer to
// close a mission the chat coordinated. That stays the person's own action.
// The page asks git about the mission once the chat has completed (the
// wrap-up is what stops the run, so nothing before it can say), and offers
// Close only where the host says it would go through. Nothing here closes one.
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge, type ConnectionState } from "./bridge";
import {
  NO_COMPLETIONS,
  closeOffer,
  missionsOf,
  receiptOutcome,
  reduceCompletions,
  type CompleteOutcome,
  type CompletePreview,
  type CompletionAction,
  type Completions,
  type CoordinatedRun,
} from "./chatComplete";

const chatOf = (key: unknown) => (typeof key === "string" && key.startsWith("chat:") ? key.slice(5) : null);
const said = (error: unknown) => String((error as Error)?.message ?? error);

type Started = { turnId: string; state: "started" | "queued" };

/** A mission the chat coordinated that Close would go through for. */
export type MissionOffer = { run: CoordinatedRun; closing?: boolean; error?: string };

export function useChatCompletions(
  conn: ConnectionState,
  openChatId: string | null,
  /** The host finished one, either way. `ok` is the chat ticked and stopped. */
  onEnded?: (chatId: string, ok: boolean) => void,
) {
  const [state, setState] = useState<Completions>(NO_COMPLETIONS);
  const [offers, setOffers] = useState<Record<string, MissionOffer[]>>({});
  const held = useRef(state);
  const ended = useRef(onEnded);
  ended.current = onEnded;
  /** The missions each chat coordinated when its completion was confirmed. */
  const missions = useRef<Record<string, string[]>>({});

  const dispatch = useCallback((action: CompletionAction) => {
    const next = reduceCompletions(held.current, action);
    if (next === held.current) return;
    held.current = next;
    setState(next);
  }, []);

  /** Ask git where the chat's missions stand, then the host whether Close
   *  would go through. Read-only: the refresh is the panel's "Check merge". */
  const findOffers = useCallback(async (chatId: string) => {
    const runs = missions.current[chatId] ?? [];
    delete missions.current[chatId];
    if (runs.length === 0) return;
    const actorChatKey = `chat:${chatId}`;
    for (const runId of runs) {
      await bridge.invoke("orchestration_mission_refresh", { actorChatKey, runId }).catch(() => {});
    }
    const preview = await bridge.invoke<CompletePreview>("chat_complete_preview", { chatKey: actorChatKey }).catch(() => undefined);
    const open = closeOffer(preview).filter((run) => runs.includes(run.runId));
    if (open.length) setOffers((before) => ({ ...before, [chatId]: open.map((run) => ({ run })) }));
  }, []);

  /** Fold one action in, and say whether it ended the chat's completion on
   *  this page. An end that belongs to another completion than the one on
   *  screen changes nothing here and is announced to nobody. */
  const settle = useCallback((chatId: string, action: CompletionAction) => {
    const before = held.current.ended[chatId];
    dispatch(action);
    const end = held.current.ended[chatId];
    if (!end || end === before) return;
    if (end.ok) void findOffers(chatId);
    else delete missions.current[chatId];
    ended.current?.(chatId, end.ok);
  }, [dispatch, findOffers]);

  useEffect(() => {
    const offStart = bridge.on<{ chatKey?: string; turnId?: string; state?: string }>("chat-completing", (payload) => {
      const chatId = chatOf(payload?.chatKey);
      if (!chatId || !payload.turnId) return;
      dispatch({ type: "completing", chatId, turnId: payload.turnId, state: payload.state === "queued" ? "queued" : "started" });
    });
    const offEnd = bridge.on<{ chatKey?: string; turnId?: string; ok?: boolean; doneAt?: number; reason?: string }>("chat-completed", (payload) => {
      const chatId = chatOf(payload?.chatKey);
      if (!chatId) return;
      settle(chatId, {
        type: "completed", chatId, turnId: payload.turnId || undefined,
        ok: payload.ok === true, reason: payload.reason, doneAt: payload.doneAt,
      });
    });
    return () => {
      offStart();
      offEnd();
    };
  }, [dispatch, settle]);

  // Every connect, not once: a backend restart forgets every completion, and
  // a page that went on showing one would be showing something nobody holds.
  useEffect(() => {
    if (conn !== "open") return;
    let current = true;
    const rev = held.current.rev;
    bridge
      .invoke<{ key: string; completing?: boolean }[]>("chat_activity")
      .then((rows) => {
        if (!current) return;
        const completing = (rows ?? []).filter((row) => row.completing).map((row) => chatOf(row.key))
          .filter((id): id is string => !!id);
        dispatch({ type: "activity", completing, rev });
      })
      // An older backend has no such command; the events still work.
      .catch(() => {});
    return () => { current = false; };
  }, [conn, dispatch]);

  useEffect(() => {
    if (conn !== "open" || !openChatId) return;
    let current = true;
    const chatId = openChatId;
    const rev = held.current.rev[chatId] ?? 0;
    bridge
      .invoke<{ completingTurnId?: string }>("chat_queue_state", { key: `chat:${chatId}` })
      .then((queue) => {
        if (current) dispatch({ type: "queue", chatId, completingTurnId: queue?.completingTurnId, rev });
      })
      .catch(() => {});
    return () => { current = false; };
  }, [conn, openChatId, dispatch]);

  /** Ask the host to complete a chat. `start` is what the page would start
   *  the chat with; the host uses it only when the chat has no process.
   *  `preview` is what the confirm showed. Answers what became of it by the
   *  time the host's answer was in: `refused`, still `completing`, or already
   *  `ended` (the events for a quick one arrive before the answer does). */
  const complete = useCallback(async (
    chatId: string,
    start: Record<string, unknown>,
    preview?: CompletePreview,
  ): Promise<CompleteOutcome> => {
    dispatch({ type: "asked", chatId });
    setOffers((before) => {
      if (!before[chatId]) return before;
      const next = { ...before };
      delete next[chatId];
      return next;
    });
    missions.current[chatId] = missionsOf(preview);
    const ask = () => bridge.invoke<Started>("chat_complete", { chatKey: `chat:${chatId}`, start });
    try {
      let answer: Started;
      try {
        answer = await ask();
      } catch (error) {
        // Another tab started the chat between the host's two looks at it.
        // The process is up now, so the same request goes straight to it.
        if (!said(error).includes("already running")) throw error;
        answer = await ask();
      }
      // The host's own events usually get here first, and the completion this
      // answer is about may already be over. The answer names its turn, and
      // only that turn's state is read.
      settle(chatId, { type: "receipt", chatId, turnId: answer.turnId, state: answer.state === "queued" ? "queued" : "started" });
      return receiptOutcome(held.current, chatId, answer.turnId);
    } catch (error) {
      delete missions.current[chatId];
      dispatch({ type: "refused", chatId, error: said(error) });
      return "refused";
    }
  }, [dispatch, settle]);

  const dismiss = useCallback((chatId: string) => {
    dispatch({ type: "dismiss", chatId });
    setOffers((before) => {
      if (!before[chatId]) return before;
      const next = { ...before };
      delete next[chatId];
      return next;
    });
  }, [dispatch]);

  /** Close one mission. The caller has already asked the person. */
  const closeMission = useCallback(async (chatId: string, runId: string) => {
    const mark = (change: Partial<MissionOffer>) => setOffers((before) => ({
      ...before,
      [chatId]: (before[chatId] ?? []).map((offer) => offer.run.runId === runId ? { ...offer, ...change } : offer),
    }));
    mark({ closing: true, error: undefined });
    try {
      await bridge.invoke("orchestration_mission_close", { actorChatKey: `chat:${chatId}`, runId, abandon: false });
      setOffers((before) => ({ ...before, [chatId]: (before[chatId] ?? []).filter((offer) => offer.run.runId !== runId) }));
    } catch (error) {
      mark({ closing: false, error: said(error) });
    }
  }, []);

  return { state, offers, complete, dismiss, closeMission };
}
