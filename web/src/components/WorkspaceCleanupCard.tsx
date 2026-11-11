import { useState } from "react";
import { ActionIcon } from "./ActionIcon";
import { once, useInFlight } from "../lib/inFlight";
import { dropHeld, repeatsAnother } from "../lib/pressGuard";
import { cleanupAsk, cleanupFlight, cleanupOutcome, cleanupRequest, cleanupResult, type CleanupAsked, type CleanupCard } from "../lib/workspaceCleanup";
import { FoldBody, FoldLine, FoldToggle, useFold } from "./CardFold";
import { StatusDismiss } from "./ChatStatus";
import "./WorkspaceCleanupCard.css";

export type AnswerCleanup = (card: CleanupCard, approve: boolean) => Promise<void>;

export function WorkspaceCleanupCard({ card, onAnswer, onDismiss, startOpen = false }: {
  card: CleanupCard; onAnswer: AnswerCleanup; onDismiss?: (card: CleanupCard) => void; startOpen?: boolean;
}) {
  const [localAnswer, setLocalAnswer] = useState<{ id: string; approved: boolean } | null>(null);
  const original = cleanupRequest(card);
  const request = original && localAnswer?.id === card.id && !original.processing
    ? { ...original, processing: true, approved: localAnswer.approved } : original;
  const result = cleanupResult(card);
  const processing = !result && !!request?.processing;
  // Settlement is a new, quiet line, even if its proposal was open.
  const fold = useFold(`${card.id}:${result ? "settled" : "asked"}`, { startOpen });
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
        {result && <FoldToggle fold={fold} what="cleanup results" />}
        {result && onDismiss && <StatusDismiss label="Dismiss cleanup result" visible onClick={(event) => { if (!repeatsAnother(event)) onDismiss(card); }} />}
        {processing && <span className="cleanup-progress-count" aria-label={`${completed}/${count} items completed`}>{completed}/{count}</span>}
      </div>
      {!processing && !result && <FoldLine fold={fold} labels={[`${count} ${count === 1 ? "item" : "items"}`]} what="worktrees to remove" />}
      {processing && request && (
        <ul className="cleanup-rows">
          {request.items.map((item) => {
            const done = results.get(item.id);
            const status = done
              ? done.status === "removed" ? "Removed" : `Kept · ${done.reason}`
              : request.approved === undefined ? "Waiting…" : request.approved === false ? "Keeping…" : "Removing…";
            return (
              <li className={`cleanup-row${done ? ` is-${done.status}` : ""}`} key={item.id}>
                <span className="cleanup-row-title" title={item.title}>{item.title}</span>
                <p className="cleanup-row-status">{status}</p>
              </li>
            );
          })}
        </ul>
      )}
      {!processing && <FoldBody fold={fold}>
        {result ? result.items.map((item) => (
          <div className="cleanup-item" key={item.id}>
            <strong>{originals.get(item.id)?.title ?? item.id}</strong>
            <p className="cleanup-item-status">{item.status === "removed" ? "Removed" : "Kept"} · {item.reason}</p>
            {originals.has(item.id) && <CleanupDetails item={originals.get(item.id)!} />}
          </div>
        )) : request?.items.map((item) => (
          <div className="cleanup-item" key={item.id}>
            <strong>{item.title}</strong>
            <CleanupDetails item={item} />
          </div>
        ))}
      </FoldBody>}
      {!result && <>
        {error && <p className="cleanup-error" role="alert">{error}</p>}
        <div className="ask-card-foot">
          {busy && !processing && <span className="ask-card-wait" role="status">Waiting for the host…</span>}
          <div className="ask-card-actions">
            <button type="button" className="ask-btn" disabled={busy} onClick={(event) => { if (!repeatsAnother(event)) void answer(false); }} data-icon-action title="Keep them" aria-label="Keep them">
              <ActionIcon name="keep" label="Keep them" />
            </button>
            <button type="button" className="ask-btn is-primary" disabled={busy} onClick={(event) => { if (!repeatsAnother(event)) void answer(true); }} data-icon-action title="Remove all" aria-label="Remove all">
              <ActionIcon name="delete" label="Remove all" />
            </button>
          </div>
        </div>
      </>}
    </div>
  );
}

function CleanupDetails({ item }: { item: CleanupAsked["items"][number] }) {
  if (!item.worktrees.length) return <p className="cleanup-root-meta">No worktrees · close the mission record only</p>;
  return (
    <ul className="cleanup-roots">
      {item.kind === "mission" && <li className="cleanup-root-meta">Closes the mission</li>}
      {item.worktrees.map((worktree, index) => (
        <li className="cleanup-root" key={index}>
          <span className="cleanup-root-branch">{worktree.branch} → {worktree.baseBranch} · <span title={worktree.headCommit}>{worktree.headCommit.slice(0, 7)}</span></span>
          <span className="cleanup-root-meta">{worktree.path}</span>
          {worktree.ignoredFileCount !== 0 && (
            <span className="cleanup-root-warn">{worktree.ignoredFileCount === null
              ? "Ignored files unknown"
              : `${worktree.ignoredFileCount} ignored ${worktree.ignoredFileCount === 1 ? "file" : "files"} at stake`}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
