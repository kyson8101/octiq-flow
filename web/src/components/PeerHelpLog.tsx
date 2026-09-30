// A task's peer help (orchestration/peer.rs): each question its worker asked a
// teammate, and the answer the host ran as that teammate. A log of advice, not
// a handoff — the task and its attempt never changed hands. The words are the
// agents' prose, so the list sits behind a disclosure and the summary only
// counts.
import type { PeerAsk } from "../lib/orchestration";

const STATUS: Record<PeerAsk["status"], string> = {
  asking: "Waiting for an answer",
  answered: "Answered",
  failed: "No answer",
};

export function peerHelpSummary(asks: readonly PeerAsk[]): string {
  const waiting = asks.filter((ask) => ask.status === "asking").length;
  const count = `${asks.length} ${asks.length === 1 ? "question" : "questions"}`;
  return waiting ? `${count} · ${waiting} waiting` : count;
}

function tokens(ask: PeerAsk): string | null {
  if (!ask.usage) return null;
  const total = ask.usage.inputTokens + ask.usage.outputTokens;
  return total >= 1000 ? `${(total / 1000).toFixed(1)}k tokens` : `${total} tokens`;
}

export function PeerHelpLog({ asks, ago }: {
  asks: readonly PeerAsk[];
  ago: (at: number) => string;
}) {
  if (asks.length === 0) return null;
  return (
    <details className="orch-peer-help">
      <summary><span>Peer help</span>{" "}<span className="orch-peer-count">{peerHelpSummary(asks)}</span></summary>
      <ol aria-label="Questions asked of teammates">
        {asks.map((ask) => (
          <li key={ask.id} data-status={ask.status} data-ask={ask.id}>
            <p className="orch-peer-who">
              <strong><bdi>{ask.asker.name}</bdi></strong> asked <strong><bdi>{ask.helper.name}</bdi></strong>
              <span> · {ago(ask.askedAt)} · {STATUS[ask.status]}</span>
              {tokens(ask) && <span> · {tokens(ask)}</span>}
            </p>
            <p className="orch-peer-question">{ask.question}</p>
            {ask.contextPaths?.length ? (
              <p className="orch-peer-paths">Pointed at {ask.contextPaths.map((path, index) => (
                <span key={path}>{index > 0 && ", "}<code>{path}</code></span>
              ))}</p>
            ) : null}
            {ask.status === "answered" && (
              <p className="orch-peer-answer" title={`${ask.helperAgent} ${ask.helperModel}${ask.helperEffort ? ` · ${ask.helperEffort}` : ""}`}>
                {ask.answer}{ask.truncated && <em> (answer cut at the length limit)</em>}
              </p>
            )}
            {ask.status === "failed" && <p className="orch-peer-error">{ask.error ?? "The teammate could not answer."}</p>}
          </li>
        ))}
      </ol>
    </details>
  );
}
