import "./WorkerChatNotice.css";

export function WorkerChatNotice({ onOpenMain, busy = false }: {
  onOpenMain?: () => void;
  busy?: boolean;
}) {
  return <div className="worker-chat-notice" role="note" aria-label="Read-only agent chat">
    <div>
      <strong>{busy ? "Agent is working · Read-only" : "Read-only agent chat"}</strong>
      <p>Send instructions and requests in the main chat so the coordinating agent stays informed.</p>
      {!onOpenMain && <p className="worker-chat-unavailable">The main chat is unavailable. This agent's conversation remains read-only.</p>}
    </div>
    {onOpenMain && <button type="button" onClick={onOpenMain}>Open main chat</button>}
  </div>;
}
