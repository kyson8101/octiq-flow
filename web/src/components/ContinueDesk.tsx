// The way back to a front-desk conversation left before it routed anywhere.
// Every chat list leaves front-desk chats out (`team::FrontDeskChat`), so a
// tap on New conversation or on another chat used to leave one out of reach
// until the next restart removed it. The new-chat screen is where the front
// desk lives, so the way back is here, under its welcome.
import type { UnfinishedDeskChat } from "../lib/agentsMode";
import { agoLabel } from "../lib/chatTask";

export function ContinueDesk({ name, chats, now, onContinue }: {
  /** The front desk's name. */
  name: string;
  /** Newest first, already cut to the few worth offering. */
  chats: readonly UnfinishedDeskChat[];
  now: number;
  onContinue: (chat: UnfinishedDeskChat) => void;
}) {
  if (!chats.length) return null;
  const label = `Continue with ${name}`;
  return (
    <section className="hero-continue" aria-label={label}>
      <h2 className="hero-continue-label">{label}</h2>
      <ul className="hero-continue-list">
        {chats.map((chat) => {
          const words = chat.opening?.trim() || "Your earlier conversation";
          const when = agoLabel(chat.createdAt, now);
          return (
            <li key={chat.chatKey}>
              <button
                type="button"
                className="hero-continue-row"
                title={words}
                aria-label={`Continue “${words}”, started ${when}`}
                onClick={() => onContinue(chat)}
              >
                <span className="hero-continue-text">{words}</span>
                <span className="hero-continue-time">{when}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
