// The switch that gives the CHAT the available width, without asking the
// browser to hide its tabs, URL bar, or other chrome. It is view state only:
// opening or closing it temporarily puts side panes away, then restores their
// previous state on the next press.
export function FullscreenButton({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`icon-btn chat-width-toggle ${expanded ? "is-on" : ""}`}
      type="button"
      aria-pressed={expanded}
      aria-label={expanded ? "Restore standard chat width" : "Expand chat to full width"}
      title={expanded ? "Restore standard chat width" : "Expand chat to full width"}
      onClick={onToggle}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {/* Both arrow sets stay in the DOM so the swap cross-fades rather than
            popping between two separate icons. */}
        <g className="chat-width-arrows chat-width-arrows-in">
          <path d="M8 3H5a2 2 0 0 0-2 2v3" />
          <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
          <path d="M16 21h3a2 2 0 0 0 2-2v-3" />
          <path d="M3 16v3a2 2 0 0 0 2 2h3" />
        </g>
        <g className="chat-width-arrows chat-width-arrows-out">
          <path d="M8 3v3a2 2 0 0 1-2 2H3" />
          <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
          <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
          <path d="M3 16h3a2 2 0 0 1 2 2v3" />
        </g>
      </svg>
    </button>
  );
}
