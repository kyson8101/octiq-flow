// Pending human requests are synchronized independently of chat rendering.
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge, type ConnectionState } from "./bridge";
import type { NoticeKind } from "./notify";
import { askSummary, type Ask } from "../components/PermissionAsk";
import type { SafetyBlockNotice } from "../components/SafetyBlock";
import type { Question } from "./question";
import { keepBatches, listedQuestions } from "./questionBlock";
import { answersOneAtATime } from "./questionHost";
import { accessRequestTitle, type AccessRequest } from "./accessRequest";
import { keepArrivals, stampArrival } from "./askClock";
import { readTwice } from "./listRead";
import { SILENT_MS, type SourceRead, type WaitSource } from "./pendingActions";

import { PendingRequests, requestConversation, type PendingRequest, type RequestState } from "./pendingRequests";
type Announce = (key: string, kind: NoticeKind, id: string, detail: string) => void;

/** The card lists this hook asks for, and where each request stands for the
 *  connection (`pendingActions.wholeOf`). The ledger is the fifth source of
 *  what waits and is read elsewhere (`orchestrationFeed`). */
type ListSource = Exclude<WaitSource, "orchestration_snapshot">;
export type ListsRead = Readonly<Record<ListSource, SourceRead>>;
const ASKED: ListsRead = {
  permission_pending: "asked", access_request_pending: "asked", question_pending: "asked", safety_block_pending: "asked",
};

/** Whether a request failed because the host has no such command: an older
 *  backend under a newer page (`'<cmd>' is not available on this backend`). */
export function lacksCommand(problem: unknown): boolean {
  return String((problem as Error)?.message ?? problem).includes("not available on this backend");
}

/** Keep the public setters compatible with useState, while applying local
 * answers to the same journal as live events before React schedules a render. */
function usePendingRequests<T extends PendingRequest>() {
  const [store] = useState(() => new PendingRequests<T>());
  const [items, publish] = useState(store.current);
  const setItems = useCallback((update: RequestState<T> | ((previous: RequestState<T>) => RequestState<T>)) => {
    publish(store.replace(update));
  }, [store]);
  return { store, items, setItems, publish };
}

export function useChatRequests(conn: ConnectionState, announce: Announce) {
  const permissions = usePendingRequests<Ask>();
  const safety = usePendingRequests<SafetyBlockNotice>();
  const prompts = usePendingRequests<Question>();
  const raises = usePendingRequests<AccessRequest>();
  const { items: asks, setItems: setAsks } = permissions;
  const { items: safetyBlocks, setItems: setSafetyBlocks } = safety;
  const { items: questions, setItems: setQuestions } = prompts;
  const { items: accessRequests, setItems: setAccessRequests } = raises;
  const notice = useRef(announce);
  notice.current = announce;
  // Whether each list has answered for this connection. Before the first
  // connection none has: an empty list then is not "nothing waits".
  const [read, setRead] = useState<ListsRead>(ASKED);
  // A list that has said nothing for `SILENT_MS` since it was asked.
  const [late, setLate] = useState(false);
  // Asked again by the person (`reread`), on the connection that is open.
  const [round, setRound] = useState(0);
  const mark = useCallback((source: ListSource, state: SourceRead) => {
    setRead((before) => (before[source] === state ? before : { ...before, [source]: state }));
  }, []);

  // What is waiting on YOU right now, asked for rather than waited for.
  //
  // Announcements have no replay. Fetch the server's current cards on every
  // connection; durable questions also survive a tool timeout or server restart.
  //
  // The server is the one that knows what is still waiting, so it is asked, on
  // every connect. Its answer replaces the state from before that request:
  // newer live events and local answers are reconciled on top. A card still
  // drawing that the server no longer lists was decided somewhere else, or
  // timed out while we were away, and a card that cannot be answered is worse
  // than no card at all.
  useEffect(() => {
    if (conn !== "open") return;
    // Every list is asked again, so none has answered for this connection.
    setRead(ASKED);
    setLate(false);
    const silent = setTimeout(() => setLate(true), SILENT_MS);
    function refill<T extends PendingRequest>(
      collection: ReturnType<typeof usePendingRequests<T>>, command: ListSource,
      // What the page knows about a request that the host's list does not say.
      known?: (list: readonly T[] | null, current: RequestState<T>) => T[],
    ) {
      let token: number | null = null;
      // Asked once more after a failure (`lib/listRead`): an older server
      // may lack the command, and live events still work, but a list that
      // failed once has not said that nothing waits.
      const stop = readTwice(async () => {
        const mine = token = collection.store.begin();
        try {
          const list = await bridge.invoke<T[]>(command);
          const reconciled = collection.store.finish(mine, known ? known(list, collection.store.current) : list);
          if (reconciled) collection.publish(reconciled);
          // Not taken: a newer ask of this list is out, and says so itself.
          return !!reconciled;
        } catch (problem) {
          collection.store.cancel(mine);
          // A host that has no such list holds no card of that kind: that
          // is an answer, and an empty one. Any other failure says nothing.
          if (lacksCommand(problem)) return true;
          throw problem;
        }
      }, (answered) => mark(command, answered ? "answered" : "failed"));
      return () => {
        stop();
        if (token !== null) collection.store.cancel(token);
      };
    }
    const cancel = [
      // A question seen arriving keeps its clock across a reconnect; one first
      // met in this list has no known age (`lib/askClock`).
      refill(permissions, "permission_pending", keepArrivals),
      refill(safety, "safety_block_pending"),
      // The list's own word on each call it names: a part of a call in it
      // is not a call still arriving for good, and on a host that answers
      // one question at a time it is what remains of the call
      // (`questionBlock.listedQuestions`).
      refill(prompts, "question_pending", (list) => {
        listedQuestions(list ?? [], Date.now(), answersOneAtATime());
        return [...(list ?? [])];
      }),
      refill(raises, "access_request_pending"),
    ];
    return () => {
      clearTimeout(silent);
      cancel.forEach((stop) => stop());
    };
  }, [conn, round]);

  // What the page counts of each call's questions is kept only while a
  // question of that call is still held: a record that completed, was
  // cancelled or went with its chat's history is forgotten.
  useEffect(() => { keepBatches(Object.values(questions).flat()); }, [questions]);

  useEffect(() => {
    const offAsk = bridge.on<Ask>("permission-ask", (ask) => {
      const id = ask ? requestConversation(ask) : null;
      if (!id || !ask.id) return;
      notice.current(ask.id, "permission", id, askSummary(ask));
      permissions.publish(permissions.store.add(stampArrival(ask, permissions.store.current, Date.now())));
    });
    // Nobody answered in time, so the server said no on our behalf. The card
    // must go: leaving it would offer a choice that no longer exists.
    const offGone = bridge.on<{ id: string }>("permission-expired", (gone) => {
      if (!gone?.id) return;
      permissions.publish(permissions.store.remove(gone.id));
    });
    const offSafety = bridge.on<SafetyBlockNotice>("safety-blocked", (block) => {
      const id = block ? requestConversation(block) : null;
      if (!id || !block.id) return;
      notice.current(block.id, "permission", id, block.title);
      safety.publish(safety.store.add(block));
    });
    const offSafetyGone = bridge.on<{ id: string }>("safety-block-expired", (gone) => {
      if (!gone?.id) return;
      safety.publish(safety.store.remove(gone.id));
    });
    const offQuestion = bridge.on<Question>("user-question", (q) => {
      const id = q ? requestConversation(q) : null;
      if (!id || !q.id) return;
      // Five questions in one call are one interruption, not five: every
      // question of a batch shares `batch`, so they share one announcement
      // (keyed on it instead of the per-question id) and it names the count.
      const detail =
        q.batchSize && q.batchSize > 1 ? `${q.batchSize} questions · ${q.question}` : q.question ?? "";
      notice.current(q.batch ?? q.id, "question", id, detail);
      prompts.publish(prompts.store.add(q));
    });
    const offQuestionGone = bridge.on<{ id: string }>("question-expired", (gone) => {
      if (!gone?.id) return;
      prompts.publish(prompts.store.remove(gone.id));
    });
    const offQuestionUpdated = bridge.on<Question>("question-updated", (q) => {
      if (!q?.id || !requestConversation(q)) return;
      prompts.publish(prompts.store.add(q));
    });
    // An agent asking for more access (`access_request.rs`). It holds the
    // agent like a permission card, so it is announced like one.
    const offRaise = bridge.on<AccessRequest>("access-request", (request) => {
      const id = request ? requestConversation(request) : null;
      if (!id || !request.id) return;
      notice.current(request.id, "permission", id, accessRequestTitle(request));
      raises.publish(raises.store.add(request));
    });
    const offRaiseGone = bridge.on<{ id: string }>("access-request-expired", (gone) => {
      if (!gone?.id) return;
      raises.publish(raises.store.remove(gone.id));
    });
    return () => {
      offRaise();
      offRaiseGone();
      offAsk();
      offGone();
      offSafety();
      offSafetyGone();
      offQuestion();
      offQuestionGone();
      offQuestionUpdated();
    };
  }, []);

  // The safety cards again, outside a connect: the ledger says one waits on
  // the person and this page holds no card for it (`lib/pendingActions`).
  // The first read can fail and is not tried again within a connection.
  // Stable: the store and its publisher are made once, so an effect that
  // depends on this runs when its own facts change and not on every render.
  const { store: safetyStore, publish: publishSafety } = safety;
  const refillSafetyBlocks = useCallback(() => {
    const token = safetyStore.begin();
    bridge.invoke<SafetyBlockNotice[]>("safety_block_pending").then((list) => {
      const reconciled = safetyStore.finish(token, list);
      if (!reconciled) return;
      publishSafety(reconciled);
      // This ask may have taken the place of the connection's own, whose
      // answer was then not taken: the list has answered through this one.
      mark("safety_block_pending", "answered");
    }).catch(() => {
      safetyStore.cancel(token);
      // And if it took that place and failed, nothing else will say so.
      setRead((before) => (before.safety_block_pending === "asked" ? { ...before, safety_block_pending: "failed" } : before));
    });
  }, [safetyStore, publishSafety, mark]);

  /** Ask every list again on this connection: what the person presses when
   *  the page could not check what waits on a chat. Each list goes back to
   *  asked, with its one retry and its own five minutes. */
  const reread = useCallback(() => setRound((n) => n + 1), []);

  return {
    asks, setAsks, safetyBlocks, setSafetyBlocks, questions, setQuestions, accessRequests, setAccessRequests, refillSafetyBlocks, reread,
    /** Whether each list has answered for this connection, and whether one
     *  has been silent too long: what `pendingActions.wholeOf` reads. */
    read, late,
  };
}
