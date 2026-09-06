// Chats waiting in the one-day trash, and the way back.
//
// The server keeps the transcript where it is and marks only its index row, so
// restore is deliberately small: clear that marker and let the ordinary chat
// loader replay the transcript when the row is opened again.
import { useState } from "react";
import type { DeletedIndexEntry } from "../lib/chatIndex";
import { RollingText } from "./RollingNumber";

const DAY_MS = 24 * 60 * 60 * 1000;

function timeLeft(deletedAt: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.ceil((deletedAt + DAY_MS - now) / 60_000));
  if (minutes >= 120) return `${Math.ceil(minutes / 60)}h left`;
  if (minutes >= 60) return `1h ${minutes - 60}m left`;
  return `${minutes}m left`;
}
export function DeletedChats({
  chats,
  projects,
  onRestore,
  onClose,
}: {
  chats: DeletedIndexEntry[];
  projects: { id: string; name: string }[];
  onRestore: (chat: DeletedIndexEntry) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  // Keep restored cards in place until the panel closes, so the action has a
  // visible result instead of making its target vanish under the pointer.
  const [list] = useState(chats);
  const names = new Map(projects.map((project) => [project.id, project.name]));

  const restore = async (chat: DeletedIndexEntry) => {
    if (busy || done.has(chat.id)) return;
    setBusy(chat.id);
    setError(null);
    try {
      await onRestore(chat);
      setDone((held) => new Set(held).add(chat.id));
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="panel-scrim" onClick={onClose} />
      <aside className="panel" role="dialog" aria-label="Deleted chats">
        <header className="panel-head">
          <div className="panel-id">
            <div className="panel-name">Deleted chats</div>
            <div className="shelf-sub">
              <RollingText>{`${list.length - done.size} restorable · permanently deleted after 24 hours`}</RollingText>
            </div>
          </div>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {error && <div className="shelf-error">{error}</div>}

        <div className="shelf-grid">
          {list.map((chat) => {
            const restored = done.has(chat.id);
            return (
              <button
                key={chat.id}
                className={`shelf-card ${restored ? "is-done" : ""}`}
                type="button"
                disabled={!!busy || restored}
                onClick={() => void restore(chat)}
              >
                <span className="shelf-card-name">{chat.title || "New chat"}</span>
                <span className="trash-card-meta">
                  {names.get(chat.projectId) ?? "Unknown project"} · {timeLeft(chat.deletedAt)}
                </span>
                <span className="shelf-card-act">
                  {restored ? "Back in the list" : busy === chat.id ? "Restoring…" : "Restore chat"}
                </span>
              </button>
            );
          })}
        </div>
      </aside>
    </>
  );
}
