import { useMemo, useState } from "react";
import { presentNotices } from "../lib/chatNotices";

type Props = {
  notices: string[];
  onClear: () => void;
};

function NoticeIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 8.6v4.2" strokeLinecap="round" />
      <circle cx="10" cy="5.9" r=".65" fill="currentColor" stroke="none" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="m4.5 6 3.5 3.5L11.5 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A quiet inbox for background diagnostics. These records remain available,
 * but do not compete with the conversation or with requests that need action. */
export function ChatNotices({ notices, onClear }: Props) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => presentNotices(notices), [notices]);
  if (groups.length === 0) return null;

  const total = notices.length;
  const allBackground = groups.every((notice) => !!notice.technical);
  const headline = total === 1
    ? groups[0].title
    : `${total} ${allBackground ? "background notices" : "notices"}`;
  const hint = total === 1 && groups[0].detail
    ? groups[0].detail
    : `${groups.length} ${groups.length === 1 ? "kind" : "kinds"}, grouped quietly`;

  return (
    <section className={`chat-notices ${open ? "is-open" : ""}`} aria-label="Background notices">
      <div className="chat-notices-bar">
        <button
          className="chat-notices-toggle"
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="chat-notices-icon"><NoticeIcon /></span>
          <span className="chat-notices-copy">
            <span className="chat-notices-title">{headline}</span>
            <span className="chat-notices-hint">{hint}</span>
          </span>
          <span className="chat-notices-chevron"><Chevron /></span>
        </button>
        <button
          className="chat-notices-clear"
          type="button"
          aria-label="Clear all background notices"
          title="Clear all"
          onClick={onClear}
        >
          ×
        </button>
      </div>

      {open && (
        <div className="chat-notices-panel">
          {groups.map((notice) => (
            <article className="chat-notice-item" key={notice.key}>
              <div className="chat-notice-head">
                <span>{notice.title}</span>
                {notice.count > 1 && <span className="chat-notice-count">{notice.count} times</span>}
              </div>
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
