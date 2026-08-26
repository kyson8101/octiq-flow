// The board: every chat in the profile, under what it wants from you.
//
// A page rather than a docked panel, and for the reason the Agents page is one:
// this is glanced at BETWEEN pieces of work, not read alongside one. Docking it
// beside the chat would cost a column of the conversation permanently to answer
// a question that is only asked now and then.
//
// It draws what `lib/board` worked out and adds nothing of its own. There is no
// drag: the agent owns the state on these cards, so a column you could drop into
// would be a control that changes nothing — the worst kind.
import { QUIET_MAX, type Board, type BoardCard, type BoardColumn } from "../lib/board";

/** What each column is called, in the order they are read. `lib/board` already
 *  returns them in this order; the names live here because they are wording,
 *  not logic. */
const NAMES: Record<BoardColumn, string> = {
  "needs-you": "Needs you",
  working: "Working",
  idle: "Idle",
  quiet: "Quiet",
};

/** The one line under each column name. Says what the column MEANS, because
 *  "Idle" and "Quiet" are not self-evident and the difference between them —
 *  a live agent between turns, against no agent at all — is the whole point. */
const SUBS: Record<BoardColumn, string> = {
  "needs-you": "waiting on your answer",
  working: "mid-turn right now",
  idle: "live, between turns",
  quiet: "no agent running",
};

export function WorkBoard({
  board,
  projectName,
  onOpen,
  onClose,
}: {
  board: Board;
  /** What a project is called, for the tag on each card. */
  projectName: (projectId: string) => string | undefined;
  onOpen: (conversationId: string) => void;
  onClose: () => void;
}) {
  const nothing = board.columns.every((c) => c.cards.length === 0);

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="panel is-wide" role="dialog" aria-label="Board">
        <header className="panel-head">
          <div className="panel-id">
            <div className="panel-name">Board</div>
            <div className="shelf-sub">
              {board.needsYou > 0
                ? `${board.needsYou} waiting on you · tap a card to open it`
                : "nothing waiting on you · tap a card to open it"}
            </div>
          </div>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {nothing ? (
          <div className="agent-note">No chats yet. Start one and it will appear here.</div>
        ) : (
          <div className="board-cols">
            {board.columns.map((col) => (
              <section className={`board-col is-${col.column}`} key={col.column}>
                <header className="board-col-head">
                  <h2 className="board-col-name">
                    {NAMES[col.column]}
                    <span className="board-count">{col.cards.length}</span>
                  </h2>
                  <div className="board-col-sub">{SUBS[col.column]}</div>
                </header>

                <div className="board-stack">
                  {col.cards.map((card) => (
                    <Card
                      key={card.id}
                      card={card}
                      project={projectName(card.projectId)}
                      onOpen={onOpen}
                    />
                  ))}

                  {col.cards.length === 0 && <div className="board-empty">Nothing here.</div>}

                  {/* What the cap left out. A column showing twelve of
                      forty-nine and saying so is honest; one that just shows
                      twelve reads as the whole truth. */}
                  {col.hidden > 0 && (
                    <div className="board-more">
                      {col.hidden} older {col.hidden === 1 ? "chat" : "chats"} not shown — the
                      newest {QUIET_MAX} are.
                    </div>
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </aside>
    </>
  );
}

function Card({
  card,
  project,
  onOpen,
}: {
  card: BoardCard;
  project?: string;
  onOpen: (conversationId: string) => void;
}) {
  return (
    <button className="board-card" type="button" onClick={() => onOpen(card.id)}>
      <span className="board-card-title">{card.title}</span>

      {card.waiting && (
        <span className="board-want">
          {card.waiting.kind === "permission"
            ? `wants to run ${card.waiting.summary}`
            : card.waiting.summary || "asked you a question"}
        </span>
      )}

      {/* The plan, when the transcript is in memory to read one from. A chat
          that is running but was never opened this session has none, and the
          title above is the whole face — see lib/board. */}
      {card.plan && card.plan.total > 0 && (
        <span className="board-plan">
          <span className="board-plan-count">
            {card.plan.done}/{card.plan.total}
          </span>
          {card.plan.finished ? (
            <span className="board-plan-line">all done</span>
          ) : (
            <span className="board-plan-line">{card.plan.current}</span>
          )}
        </span>
      )}

      {card.stalled && <span className="board-stalled">stopped part-way</span>}

      {project && <span className="board-proj">{project}</span>}
    </button>
  );
}
