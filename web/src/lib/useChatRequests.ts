// Pending human requests are synchronized independently of chat rendering.
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge, type ConnectionState } from "./bridge";
import type { NoticeKind } from "./notify";
import { askSummary, type Ask } from "../components/PermissionAsk";
import type { SafetyBlockNotice } from "../components/SafetyBlock";
import type { Question } from "../components/UserQuestion";

import { PendingRequests, requestConversation, type PendingRequest, type RequestState } from "./pendingRequests";
type Announce = (key: string, kind: NoticeKind, id: string, detail: string) => void;

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
  const { items: asks, setItems: setAsks } = permissions;
  const { items: safetyBlocks, setItems: setSafetyBlocks } = safety;
  const { items: questions, setItems: setQuestions } = prompts;
  const notice = useRef(announce);
  notice.current = announce;

  // What is waiting on YOU right now, asked for rather than waited for.
  //
  // A permission card and an `ask_user` question are announced ONCE, on a
  // broadcast with no replay, and they live only in this page's memory. So a
  // reload used to lose them outright — while the server went on holding the
  // agent's turn open, three minutes for a permission and ten for a question,
  // for an answer that could no longer be given. The chat just sat there, and
  // the way out was to send something and start a fresh turn.
  //
  // The server is the one that knows what is still waiting, so it is asked, on
  // every connect. Its answer replaces the state from before that request:
  // newer live events and local answers are reconciled on top. A card still
  // drawing that the server no longer lists was decided somewhere else, or
  // timed out while we were away, and a card that cannot be answered is worse
  // than no card at all.
  useEffect(() => {
    if (conn !== "open") return;
    function refill<T extends PendingRequest>(collection: ReturnType<typeof usePendingRequests<T>>, command: string) {
      const token = collection.store.begin();
      bridge.invoke<T[]>(command).then((list) => {
        const reconciled = collection.store.finish(token, list);
        if (reconciled) collection.publish(reconciled);
      }).catch(() => {
        // Older servers may lack the command; live events still work.
        collection.store.cancel(token);
      });
      return () => collection.store.cancel(token);
    }
    const cancel = [
      refill(permissions, "permission_pending"),
      refill(safety, "safety_block_pending"),
      refill(prompts, "question_pending"),
    ];
    return () => cancel.forEach((stop) => stop());
  }, [conn]);

  useEffect(() => {
    const offAsk = bridge.on<Ask>("permission-ask", (ask) => {
      const id = ask ? requestConversation(ask) : null;
      if (!id || !ask.id) return;
      notice.current(ask.id, "permission", id, askSummary(ask));
      permissions.publish(permissions.store.add(ask));
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
    return () => {
      offAsk();
      offGone();
      offSafety();
      offSafetyGone();
      offQuestion();
      offQuestionGone();
    };
  }, []);

  return { asks, setAsks, safetyBlocks, setSafetyBlocks, questions, setQuestions };
}
