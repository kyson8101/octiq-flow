import { ActionIcon } from "./ActionIcon";
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
     data-icon-action>
      <ActionIcon name="width" />
    </button>
  );
}
