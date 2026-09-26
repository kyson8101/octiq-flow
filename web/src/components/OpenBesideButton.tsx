// "Open beside main": the one explicit way into [ Main | Task ] (lib/chatBeside).
// Its own file so the run line and the task rows can draw it without pulling
// in the task pane and everything a transcript needs.
import "./TaskChatPane.css";

export function OpenBesideButton({ title, onClick, className = "" }: { title: string; onClick: () => void; className?: string }) {
  return (
    <button type="button" className={`open-beside ${className}`.trim()} onClick={onClick}
      aria-label={`Open beside main: ${title}`} title="Open beside main">
      <SplitIcon />
    </button>
  );
}

export function SplitIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M12 4v16" />
  </svg>;
}
