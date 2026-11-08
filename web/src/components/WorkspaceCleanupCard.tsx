import { useState } from "react";
import { once, useInFlight } from "../lib/inFlight";
import { dropHeld, repeatsAnother } from "../lib/pressGuard";
import { cleanupAsk, cleanupFlight, cleanupOutcome, cleanupRequest, cleanupResult, type CleanupAsked, type CleanupCard } from "../lib/workspaceCleanup";
import { FoldBody, FoldLine, useFold } from "./CardFold";
import "./WorkspaceCleanupCard.css";

export type AnswerCleanup = (card: CleanupCard, approve: boolean) => Promise<void>;

export function WorkspaceCleanupCard({ card, onAnswer, startOpen = false }: {
  card: CleanupCard; onAnswer: AnswerCleanup; startOpen?: boolean;
}) {
  const request = cleanupRequest(card);
  const result = cleanupResult(card);
  // Settlement is a new, quiet line, even if its proposal was open.
  const fold = useFold(`${card.id}:${result ? "settled" : "asked"}`, { startOpen });
  const flight = useInFlight(cleanupFlight(card.id));
  const busy = flight || !!request?.processing;
  const [error, setError] = useState("");
  const answer = async (approve: boolean) => {
    if (busy || result) return;
    setError("");
    try {
      await once(cleanupFlight(card.id), () => onAnswer(card, approve));
    } catch (problem) {
      setError(String((problem as Error)?.message ?? problem));
    }
  };
  const originals = new Map(request?.items.map((item) => [item.id, item]));
  const count = result?.items.length ?? request?.items.length ?? 0;
  return (
    <div className={`ask-card workspace-cleanup-card${result ? " is-settled" : ""}`}
      role={result ? "group" : "alertdialog"} aria-label={result ? "Workspace cleanup result" : "Remove finished worktrees"}
      onKeyDown={dropHeld}>
      <div className="ask-card-head">
        {!result && <span className="ask-card-dot" aria-hidden="true" />}
        <span className="ask-card-title">{result ? cleanupOutcome(result) : request && cleanupAsk(request)}</span>
      </div>
      <FoldLine fold={fold} labels={[`${count} ${result ? (count === 1 ? "result" : "results") : (count === 1 ? "item" : "items")}`]} what={result ? "cleanup results" : "worktrees to remove"} />
      <FoldBody fold={fold}>
        {result ? result.items.map((item) => (
          <div className="cleanup-item" key={item.id}>
            <strong>{originals.get(item.id)?.title ?? item.id}</strong>
            <p>{item.status === "removed" ? "Removed" : "Kept"} · {item.reason}</p>
            {originals.has(item.id) && <CleanupDetails item={originals.get(item.id)!} />}
          </div>
        )) : request?.items.map((item) => (
          <div className="cleanup-item" key={item.id}>
            <strong>{item.title}</strong>
            <CleanupDetails item={item} />
          </div>
        ))}
      </FoldBody>
      {!result && <>
        {error && <p className="cleanup-error" role="alert">{error}</p>}
        <div className="ask-card-foot">
          {busy && <span className="ask-card-wait" role="status">Waiting for the host…</span>}
          <div className="ask-card-actions">
            <button type="button" className="ask-btn" disabled={busy} onClick={(event) => { if (!repeatsAnother(event)) void answer(false); }}>Keep them</button>
            <button type="button" className="ask-btn is-primary" disabled={busy} onClick={(event) => { if (!repeatsAnother(event)) void answer(true); }}>Remove all</button>
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
