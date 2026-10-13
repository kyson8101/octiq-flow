import { useId, useMemo, useState } from "react";
import { noticesHeadline, presentNotices } from "../lib/chatNotices";
import { StatusChevron, StatusDismiss } from "./ChatStatus";

type Props = {
  notices: string[];
  onClear: () => void;
};

function NoticeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 8.6v4.2" strokeLinecap="round" />
      <circle cx="10" cy="5.9" r=".65" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** A quiet inbox for background diagnostics, as one row of the group above
 *  the composer (`ChatStatus`). Folded it says a short title and nothing
 *  else: the one notice's, or how many there are. The host's own sentences,
 *  the task ids and the raw records are inside the opened panel. */
export function ChatNotices({ notices, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const groups = useMemo(() => presentNotices(notices), [notices]);
  if (groups.length === 0) return null;

  return (
    <section className={`chat-notices ${open ? "is-open" : ""}`} aria-label="Background notices">
      <div className="status-row">
        <button
          className="status-row-main chat-notices-toggle"
          type="button"
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="status-row-icon"><NoticeIcon /></span>
          <span className="status-row-text chat-notices-title">{noticesHeadline(groups, notices.length)}</span>
          <StatusChevron />
        </button>
        <StatusDismiss label="Clear all background notices" onClick={onClear} />
      </div>

      {open && (
        <div className="status-row-panel chat-notices-panel" id={panel}>
          {groups.map((notice) => (
            <article className="chat-notice-item" key={notice.key}>
              {/* One notice that has more to say is already titled by the row
                  above it: its title is not said twice. */}
              {(groups.length > 1 || notice.count > 1 || !notice.detail) && (
                <div className="chat-notice-head">
                  <span>{notice.title}</span>
                  {notice.count > 1 && <span className="chat-notice-count">{notice.count} times</span>}
                </div>
              )}
              {notice.detail && <p>{notice.detail}</p>}
              {notice.technical && (
                <details className="chat-notice-technical">
                  <summary>Technical details</summary>
                  <pre>{notice.technical}</pre>
                </details>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
