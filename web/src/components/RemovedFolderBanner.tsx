// The line above the composer that says this chat's folder is gone.
//
// A task chat outlives its worktree: the work is merged, the worktree is
// cleaned up, and the conversation is still worth a follow-up question. The
// host puts the folder back, or moves the chat, when the next message starts
// the agent (`chat_recover.rs`) — so this says what that message will do and
// never stands in its way.
//
// It asks `chat_task` for itself rather than borrowing the top bar's answer:
// the bar is hidden on some layouts, and this line must not be. The backend
// caches a verification for a few seconds, so the two asking at once cost one
// `git status`. Like the bar, it never polls.
import { useCallback, useEffect, useState } from "react";
import { bridge } from "../lib/bridge";
import { removedFolderNote, type TaskStatus, type TaskWorkspace } from "../lib/chatTask";

export function RemovedFolderBanner({
  chatId,
  connected,
  projectPath,
}: { chatId: string; connected: boolean; projectPath?: string }) {
  const [status, setStatus] = useState<TaskStatus>();

  const load = useCallback(
    (refresh: boolean) => {
      if (!chatId || !connected) return;
      bridge
        .invoke<TaskStatus>("chat_task", { chatId, refresh })
        .then(setStatus)
        // An older backend, or a chat nothing was ever verified for: there is
        // nothing to say, which is what an absent line already says.
        .catch(() => {});
    },
    [chatId, connected],
  );

  useEffect(() => load(false), [load]);

  useEffect(() => {
    if (!chatId || !connected) return;
    const offStatus = bridge.on<TaskStatus>("chat-task", (next) => {
      if (next?.chatId === chatId) setStatus(next);
    });
    // The host has just put the folder right. Ask again rather than wait for
    // the turn to end with a line on screen that is no longer true.
    const offEvent = bridge.on<{ key: string; event?: { type?: unknown } }>("chat-event", (payload) => {
      if (payload?.key === `chat:${chatId}` && payload.event?.type === "octiq_chat_recovered") load(true);
    });
    return () => {
      offStatus();
      offEvent();
    };
  }, [chatId, connected, load]);

  return (
    <RemovedFolderLine
      workspace={status?.chatId === chatId ? status.workspace : undefined}
      projectPath={projectPath}
    />
  );
}

/** The drawing half, pure so it can be rendered without a backend. */
export function RemovedFolderLine({
  workspace,
  projectPath,
}: { workspace?: TaskWorkspace; projectPath?: string }) {
  const note = removedFolderNote(workspace, projectPath);
  if (!note) return null;
  return (
    <div className="chat-folder-gone" role="status">
      <span className="chat-folder-gone-icon" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M9.5 11.5l5 5M14.5 11.5l-5 5" />
        </svg>
      </span>
      <span className="chat-folder-gone-copy">
        <span className="chat-folder-gone-title" title={note.title}>{note.title}</span>
        <span className="chat-folder-gone-hint">{note.detail}</span>
      </span>
    </div>
  );
}
