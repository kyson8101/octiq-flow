// Handovers in a chat: the card in the source chat that asks the person to
// confirm, then says where the task went, and the card in the new chat that
// says where it came from. The decision is the person's alone: these buttons
// are the only thing that sends `handover_confirm`.
//
// Labels and counts up front; the brief, paths and the HEAD commit sit behind
// a disclosure, like every other piece of agent prose.
import { useState } from "react";
import {
  chatIdOf, handoverHeadline, noticeLine, placeLine, settingsLine,
  type Handover,
} from "../lib/handover";
import "./HandoverCards.css";

type Open = (chatKey: string, projectId: string | null) => void;

function Section({ title, text }: { title: string; text?: string }) {
  if (!text?.trim()) return null;
  return (
    <div className="handover-section">
      <h4>{title}</h4>
      <p>{text}</p>
    </div>
  );
}

function List({ title, items, quoted }: { title: string; items?: string[]; quoted?: boolean }) {
  if (!items?.length) return null;
  return (
    <div className="handover-section">
      <h4>{title}</h4>
      <ul>{items.map((item, i) => <li key={i}>{quoted ? `“${item}”` : item}</li>)}</ul>
    </div>
  );
}

/** The brief and the checkout details, folded. */
function BriefDetails({ handover }: { handover: Handover }) {
  const { brief, workspace } = handover;
  const where = workspace.preparedCwd ?? workspace.path;
  return (
    <details className="handover-brief">
      <summary>
        <span>Brief</span>
        <span className="handover-chevron" aria-hidden="true" />
      </summary>
      <div className="handover-brief-body">
        <Section title="Objective" text={brief.objective} />
        <Section title="Done so far" text={brief.doneSoFar} />
        <Section title="Remaining" text={brief.remaining} />
        <Section title="Decisions and gotchas" text={brief.decisions} />
        <Section title="Open questions" text={brief.openQuestions} />
        <List
          title={`${handover.from.name} says these carry over`}
          items={brief.authorized}
          quoted
        />
        {!!brief.authorized?.length && (
          <p className="handover-caveat">The agent's words, not a permission: approvals stay with each chat.</p>
        )}
        <List title="Not authorized" items={brief.notAuthorized} />
        <div className="handover-section">
          <h4>Checkout</h4>
          <p className="handover-mono">{where}</p>
          {workspace.head && <p className="handover-mono">HEAD {workspace.head}</p>}
          <p className="handover-mono">{handover.destination.repository}</p>
        </div>
      </div>
    </details>
  );
}

/** Branch, HEAD-state and uncommitted changes, as git said when the card was made. */
function Facts({ handover }: { handover: Handover }) {
  const ws = handover.workspace;
  return (
    <dl className="handover-facts">
      <div><dt>To</dt><dd>{handover.to.name} <span className="handover-dim">· {settingsLine(handover.settings)}</span></dd></div>
      <div><dt>Where</dt><dd>{placeLine(handover)}</dd></div>
      {ws.mode === "continue" && ws.uncommitted !== undefined && (
        <div><dt>Changes</dt><dd>{ws.uncommitted ? "Uncommitted changes travel with it" : "Nothing uncommitted"}</dd></div>
      )}
    </dl>
  );
}

function SourceCard({ handover, onDecide, onOpen }: {
  handover: Handover;
  onDecide: (id: string, confirm: boolean) => Promise<unknown>;
  onOpen: Open;
}) {
  const [busy, setBusy] = useState<"confirm" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = handover.status === "pending";
  const decide = async (confirm: boolean) => {
    setBusy(confirm ? "confirm" : "decline");
    setError(null);
    try {
      await onDecide(handover.id, confirm);
    } catch (reason) {
      setError(String((reason as Error)?.message ?? reason));
    } finally {
      setBusy(null);
    }
  };
  const failed = error ?? (pending ? handover.error : undefined);
  const notice = noticeLine(handover);
  return (
    <section
      className={`handover-card is-${handover.status}`}
      data-handover={handover.id}
      data-status={handover.status}
      {...(pending ? { "data-pending": "", "data-pending-keys": `handover:${handover.id}`, tabIndex: -1 } : {})}
    >
      <header className="handover-head">
        <span className="handover-mark" aria-hidden="true" />
        <h3>{handoverHeadline(handover, "source")}</h3>
      </header>
      {handover.status !== "declined" && <Facts handover={handover} />}
      {handover.status !== "declined" && <BriefDetails handover={handover} />}
      {failed && <p className="handover-error" role="alert">{failed}</p>}
      {notice && <p className="handover-note">{notice}</p>}
      {pending && (
        <footer className="handover-actions">
          <span className="handover-hint">Nothing starts until you choose.</span>
          <button type="button" className="handover-quiet" disabled={!!busy} onClick={() => void decide(false)}>
            {busy === "decline" ? "Keeping…" : "Keep it here"}
          </button>
          <button type="button" className="handover-go" disabled={!!busy} onClick={() => void decide(true)}>
            {busy === "confirm" ? "Handing over…" : `Hand over to ${handover.to.name}`}
          </button>
        </footer>
      )}
      {handover.status === "confirmed" && handover.targetChatKey && (
        <footer className="handover-actions">
          <button
            type="button"
            className="handover-link"
            data-open-chat={chatIdOf(handover.targetChatKey)}
            onClick={() => onOpen(handover.targetChatKey!, handover.destination.projectId)}
          >
            Open {handover.to.name}'s chat
          </button>
        </footer>
      )}
    </section>
  );
}

function TargetCard({ handover, onOpen, sourceProjectId }: {
  handover: Handover;
  onOpen: Open;
  sourceProjectId: string | null;
}) {
  return (
    <section className="handover-card is-incoming" data-handover={handover.id} data-status="incoming">
      <header className="handover-head">
        <span className="handover-mark" aria-hidden="true" />
        <h3>{handoverHeadline(handover, "target")}</h3>
      </header>
      <dl className="handover-facts">
        <div><dt>From</dt><dd>{handover.sourceTitle || "Untitled chat"}</dd></div>
        <div><dt>Where</dt><dd>{placeLine(handover)}</dd></div>
      </dl>
      <BriefDetails handover={handover} />
      <footer className="handover-actions">
        <button
          type="button"
          className="handover-link"
          data-open-chat={chatIdOf(handover.sourceChatKey)}
          onClick={() => onOpen(handover.sourceChatKey, sourceProjectId)}
        >
          Open the original chat
        </button>
      </footer>
    </section>
  );
}

export function HandoverCards({ outgoing, incoming, onDecide, onOpen, projectOf }: {
  outgoing: readonly Handover[];
  incoming: Handover | null;
  onDecide: (id: string, confirm: boolean) => Promise<unknown>;
  onOpen: Open;
  /** The project a chat belongs to, for opening it. */
  projectOf?: (chatKey: string) => string | null;
}) {
  if (!outgoing.length && !incoming) return null;
  return (
    <div className="handover-cards">
      {incoming && (
        <TargetCard
          handover={incoming}
          onOpen={onOpen}
          sourceProjectId={projectOf?.(incoming.sourceChatKey) ?? null}
        />
      )}
      {outgoing.map((handover) => (
        <SourceCard key={handover.id} handover={handover} onDecide={onDecide} onOpen={onOpen} />
      ))}
    </div>
  );
}
