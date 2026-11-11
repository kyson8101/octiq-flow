import { useState } from "react";
import { ActionIcon } from "./ActionIcon";
import { once, useInFlight } from "../lib/inFlight";
import { dropHeld, repeatsAnother } from "../lib/pressGuard";
import { cleanupAsk, cleanupFlight, cleanupOutcome, cleanupRequest, cleanupResult, type CleanupAsked, type CleanupCard } from "../lib/workspaceCleanup";
import { FoldBody, FoldLine, useFold } from "./CardFold";
import "./WorkspaceCleanupCard.css";

export type AnswerCleanup = (card: CleanupCard, approve: boolean) => Promise<void>;

export function WorkspaceCleanupCard({ card, onAnswer, startOpen = false }: {
  card: CleanupCard; onAnswer: AnswerCleanup; startOpen?: boolean;
}) {
  const [localAnswer, setLocalAnswer] = useState<{ id: string; approved: boolean } | null>(null);
  const original = cleanupRequest(card);
  const request = original && localAnswer?.id === card.id && !original.processing
    ? { ...original, processing: true, approved: localAnswer.approved } : original;
  const result = cleanupResult(card);
  const processing = !result && !!request?.processing;
  // Settlement is a new, quiet line, even if its proposal was open.
  const fold = useFold(`${card.id}:${result ? "settled" : "asked"}`, { startOpen });
  const detailFold = processing ? { ...fold, open: true, shown: true, phase: "open" as const } : fold;
  const flight = useInFlight(cleanupFlight(card.id));
  const busy = flight || !!request?.processing;
  const [error, setError] = useState("");
  const answer = async (approve: boolean) => {
    if (busy || result) return;
    setError("");
    try {
      await once(cleanupFlight(card.id), () => {
        setLocalAnswer({ id: card.id, approved: approve });
        return onAnswer(card, approve);
      });
    } catch (problem) {
      setLocalAnswer(null);
      setError(String((problem as Error)?.message ?? problem));
    }
  };
  const originals = new Map(request?.items.map((item) => [item.id, item]));
  const results = new Map(request?.results?.map((item) => [item.id, item]));
  const count = result?.items.length ?? request?.items.length ?? 0;
  const completed = request?.items.filter((item) => results.has(item.id)).length ?? 0;
  return (
    <div className={`ask-card workspace-cleanup-card${result ? " is-settled" : processing ? " is-processing" : ""}`}
      role={result || processing ? "group" : "alertdialog"} aria-label={result ? "Workspace cleanup result" : processing ? "Workspace cleanup progress" : "Remove finished worktrees"}
      onKeyDown={dropHeld}>
      <div className="ask-card-head" role={processing ? "status" : undefined}>
        {!result && <span className={processing ? "cleanup-progress-dot" : "ask-card-dot"} aria-hidden="true" />}
        <span className="ask-card-title">{result ? cleanupOutcome(result) : request && cleanupAsk(request)}</span>
        {processing && <span className="cleanup-progress-count" aria-label={`${completed}/${count} items completed`}>{completed}/{count}</span>}
      </div>
      {!processing && <FoldLine fold={fold} labels={[`${count} ${result ? (count === 1 ? "result" : "results") : (count === 1 ? "item" : "items")}`]} what={result ? "cleanup results" : "worktrees to remove"} />}
      <FoldBody fold={detailFold}>
        {result ? result.items.map((item) => (
          <div className="cleanup-item" key={item.id}>
            <strong>{originals.get(item.id)?.title ?? item.id}</strong>
            <p>{item.status === "removed" ? "Removed" : "Kept"} · {item.reason}</p>
            {originals.has(item.id) && <CleanupDetails item={originals.get(item.id)!} />}
          </div>
        )) : request?.items.map((item) => (
          <div className="cleanup-item" key={item.id}>
            <strong>{item.title}</strong>
            {processing && <p>{results.has(item.id)
              ? results.get(item.id)!.status === "removed" ? "Removed" : `Kept · ${results.get(item.id)!.reason}`
              : request.approved === undefined ? "Waiting…" : request.approved === false ? "Keeping…" : "Removing…"}</p>}
            <CleanupDetails item={item} />
          </div>
        ))}
      </FoldBody>
      {!result && <>
        {error && <p className="cleanup-error" role="alert">{error}</p>}
        <div className="ask-card-foot">
          {busy && !processing && <span className="ask-card-wait" role="status">Waiting for the host…</span>}
          <div className="ask-card-actions">
            <button type="button" className="ask-btn" disabled={busy} onClick={(event) => { if (!repeatsAnother(event)) void answer(false); }} data-icon-action title="Keep them" aria-label="Keep them">
              <ActionIcon name="keep" />
            </button>
            <button type="button" className="ask-btn is-primary" disabled={busy} onClick={(event) => { if (!repeatsAnother(event)) void answer(true); }} data-icon-action title="Remove all" aria-label="Remove all">
              <ActionIcon name="delete" /> Remove all
            </button>
          </div>
        </div>
      </>}
    </div>
  );
}

function CleanupDetails({ item }: { item: CleanupAsked["items"][number] }) {
  return (
    <>
      <p>{item.kind === "mission" ? "Close mission" : "Clean up task worktree"}</p>
      {!item.worktrees.length && <p>No worktrees · close the mission record only</p>}
      {item.worktrees.map((worktree, index) => (
        <dl key={index}>
          <dt>Branch</dt><dd>{worktree.branch}</dd>
          <dt>Path</dt><dd>{worktree.path}</dd>
          <dt>Merged commit</dt><dd>{worktree.headCommit}</dd>
          <dt>Merged into</dt><dd>{worktree.baseBranch}</dd>
          <dt>Ignored files at stake</dt><dd>{worktree.ignoredFileCount === null ? "Unknown" : worktree.ignoredFileCount}</dd>
        </dl>
      ))}
    </>
  );
}
