// Which chats have a runtime switch waiting, and which are on a fallback,
// kept in step with the host. The folding is `lib/runtimeSwitch`.
//
// The host owns the state. This hook mirrors it: the events while the page
// is watching, and a read of `chat_queue_state` when the chat is opened and
// on every connect, because an event has no replay (a reload and a second
// tab draw the same only because of that read).
//
// Nothing here moves the chat's own settings. A `switched` answer is handed
// to `onSwitched` and the events are the host's word; the page's `choice`
// and `effort` follow those, never the press. An answer the revision guard
// rejected is older than an event and is not applied either.
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge, type ConnectionState } from "./bridge";
import { once, IN_FLIGHT } from "./inFlight";
import {
  NO_RUNTIMES, readAnswer, readHome, readRuntime, reduceRuntime, runtimeFlight, takeAnswer,
  type ChatRuntime, type RuntimeAction, type RuntimeRef, type RuntimeState, type SwitchAnswer,
} from "./runtimeSwitch";

const chatOf = (key: unknown) => (typeof key === "string" && key.startsWith("chat:") ? key.slice(5) : null);
const said = (error: unknown) => String((error as Error)?.message ?? error);

/** Where the press was made: its refusal is said there. */
export type SwitchOrigin = "row" | "sheet";
export type SwitchRefusal = { origin: SwitchOrigin; text: string };

export function useRuntimeSwitch(
  conn: ConnectionState,
  openChatId: string | null,
  /** The host said the chat now runs on this (a `switched` answer): the page
   *  takes it the way it takes `chat-provider-switch`. */
  onSwitched: (chatId: string, answer: SwitchAnswer) => void,
) {
  const [state, setState] = useState<RuntimeState>(NO_RUNTIMES);
  const [refusals, setRefusals] = useState<Readonly<Record<string, SwitchRefusal>>>({});
  const held = useRef(state);
  const switched = useRef(onSwitched);
  switched.current = onSwitched;

  const dispatch = useCallback((action: RuntimeAction) => {
    const next = reduceRuntime(held.current, action);
    if (next === held.current) return;
    held.current = next;
    setState(next);
  }, []);

  useEffect(() => {
    const offPending = bridge.on<{ key?: string; agent?: string; model?: string | null; effort?: string | null; cleared?: boolean }>(
      "chat-runtime-pending",
      (payload) => {
        const chatId = chatOf(payload?.key);
        if (!chatId) return;
        if (payload.cleared) return dispatch({ type: "cleared", chatId });
        const runtime = readRuntime(payload);
        if (runtime) dispatch({ type: "pending", chatId, runtime });
      },
    );
    const offSwitch = bridge.on<{ key?: string; home?: unknown }>("chat-provider-switch", (payload) => {
      const chatId = chatOf(payload?.key);
      if (!chatId) return;
      const home = readHome(payload.home);
      // `home: null` is the host saying the chat is on its own runtime; a
      // payload with no `home` at all is an older host and says nothing.
      dispatch({ type: "switched", chatId, ...("home" in (payload ?? {}) ? { home: home ?? null } : {}) });
    });
    return () => {
      offPending();
      offSwitch();
    };
  }, [dispatch]);

  // Every connect, and every chat opened: a restart forgets nothing the
  // host derives from the record, and a page that was away heard no events.
  useEffect(() => {
    if (conn !== "open" || !openChatId) return;
    let current = true;
    const chatId = openChatId;
    const rev = held.current[chatId]?.rev ?? 0;
    bridge
      .invoke<{ pendingRuntime?: unknown; homeRuntime?: unknown }>("chat_queue_state", { key: `chat:${chatId}` })
      .then((queue) => {
        if (!current) return;
        dispatch({
          type: "queue", chatId, rev,
          pending: readRuntime(queue?.pendingRuntime),
          home: readHome(queue?.homeRuntime),
        });
      })
      // An older backend has no such fields; the events still work.
      .catch(() => {});
    return () => { current = false; };
  }, [conn, openChatId, dispatch]);

  // A refusal is said where the press was made, for as long as that is
  // what is on screen: another chat's is not this one's.
  useEffect(() => {
    setRefusals((before) => (Object.keys(before).length ? {} : before));
  }, [openChatId]);

  /** Ask the host to run the chat on `runtime`. One request per chat at a
   *  time (`lib/inFlight`): a control drawn again cannot send twice. The
   *  host's sentence for a refusal is kept for the control that asked, and
   *  nothing of the chat's settings moves on it. */
  const request = useCallback(async (chatId: string, runtime: RuntimeRef, origin: SwitchOrigin): Promise<SwitchAnswer | undefined> => {
    setRefusals((before) => {
      if (!before[chatId]) return before;
      const next = { ...before };
      delete next[chatId];
      return next;
    });
    const rev = held.current[chatId]?.rev ?? 0;
    const done = await once(runtimeFlight(chatId), async () => {
      try {
        const answer = readAnswer(await bridge.invoke("chat_switch_runtime", {
          key: `chat:${chatId}`, agent: runtime.agent, model: runtime.model, effort: runtime.effort,
        }));
        if (!answer) throw new Error("The host's answer was not understood. Nothing was changed.");
        return answer;
      } catch (error) {
        setRefusals((before) => ({ ...before, [chatId]: { origin, text: said(error) } }));
        return undefined;
      }
    });
    if (done === IN_FLIGHT || !done) return undefined;
    // The page takes the answer's runtime only when the answer is the newest
    // word it has. An event that came after the press (a newer host switch)
    // moved the chat's rev: this answer is then older than it, and applying
    // it would put the old runtime back over the newer one.
    const taken = takeAnswer(held.current, chatId, rev, done);
    if (taken.state !== held.current) {
      held.current = taken.state;
      setState(taken.state);
    }
    if (taken.apply) switched.current(chatId, done);
    return done;
  }, [dispatch]);

  const dismissRefusal = useCallback((chatId: string) => {
    setRefusals((before) => {
      if (!before[chatId]) return before;
      const next = { ...before };
      delete next[chatId];
      return next;
    });
  }, []);

  return {
    /** What the page holds about one chat's runtime. */
    runtimeOf: (chatId: string | null | undefined): ChatRuntime | undefined => (chatId ? state[chatId] : undefined),
    refusalOf: (chatId: string | null | undefined): SwitchRefusal | undefined => (chatId ? refusals[chatId] : undefined),
    request,
    dismissRefusal,
  };
}
