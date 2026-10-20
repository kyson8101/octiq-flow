import { useCallback, useEffect, useId, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { mediaTime, orderedComments, reviewQuote, type MediaThread } from "../lib/mediaComments";
import { canQuote, sendQuote } from "../lib/quote";
import "./MediaComments.css";

/** Saved review notes. The playback anchor belongs to the draft: playback or
 *  a delayed network response cannot move a note to a different frame. */
export function MediaComments({ path, captureTime, seekTime, duration, onQuote }: {
  path: string;
  captureTime?: () => number;
  seekTime?: (ms: number) => void;
  duration?: number;
  onQuote?: () => void;
}) {
  const [thread, setThread] = useState<MediaThread | null>(null);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [anchor, setAnchor] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [unread, setUnread] = useState(true);
  const [notice, setNotice] = useState("");
  const id = useId();
  const request = useRef(0);
  const revision = useRef<string | null>(null);
  const pending = useRef<{ id: string; text: string; timeMs?: number } | null>(null);
  const reload = useCallback(async () => {
    const sequence = ++request.current;
    try {
      const next = await bridge.invoke<MediaThread>("media_comments_list", { path });
      if (sequence !== request.current) return;
      // Never silently rebase a draft written while an old file was on screen.
      if (revision.current && revision.current !== next.target.revision) {
        setUnread(true); setError("This file changed. Reopen the preview to review the new version; keep a copy of any draft first."); return;
      }
      revision.current = next.target.revision;
      setThread(next);
      setUnread(false); setError("");
    } catch (reason) {
      if (sequence !== request.current) return;
      setUnread(true); setError(String((reason as Error)?.message ?? reason));
    }
  }, [path]);
  useEffect(() => {
    void reload();
    const off = bridge.on<MediaThread["target"]>("media-comments-changed", changed => {
      // Paths may be symlink aliases. A change to any review is cheap to reread
      // while this one is open, and the host resolves its canonical identity.
      if (changed) void reload();
    });
    return () => { request.current++; off(); };
  }, [reload]);

  function capture() { if (captureTime) setAnchor(captureTime()); }
  async function save() {
    if (!thread || unread || saving || !draft.trim()) return;
    const text = draft.trim();
    const timeMs = captureTime ? anchor ?? captureTime() : undefined;
    if (!pending.current || pending.current.text !== text || pending.current.timeMs !== timeMs) {
      pending.current = { id: crypto.randomUUID(), text, ...(timeMs === undefined ? {} : { timeMs }) };
    }
    setSaving(true); setError(""); setNotice("");
    ++request.current;
    try {
      const next = await bridge.invoke<MediaThread>("media_comment_add", { path, revision: thread.target.revision, ...pending.current });
      setThread(next); setDraft(""); setAnchor(null); pending.current = null; setNotice("Comment saved.");
    } catch (reason) { setError(String((reason as Error)?.message ?? reason)); }
    finally { setSaving(false); }
  }
  async function remove(commentId: string) {
    if (!thread || saving || unread) return;
    setSaving(true); setError(""); ++request.current;
    try {
      setThread(await bridge.invoke<MediaThread>("media_comment_remove", { path, revision: thread.target.revision, id: commentId }));
      setNotice("Comment removed.");
    } catch (reason) { setError(String((reason as Error)?.message ?? reason)); }
    finally { setSaving(false); }
  }
  const comments = orderedComments(thread?.comments ?? []);
  return <span className="media-comments" role="region" aria-label="Media comments" onClick={event => event.stopPropagation()}>
    <span className="media-comments-heading"><strong>Comments</strong><span>{comments.length}</span></span>
    {error && <span className="media-comments-error" role="alert">{error} {unread && <button type="button" onClick={() => void reload()}>Retry loading</button>}</span>}
    {!thread && !error && <span role="status">Loading comments…</span>}
    {!!seekTime && !!duration && duration > 0 && comments.some(comment => comment.timeMs !== undefined) && <span className="media-comment-timeline" role="group" aria-label="Comment timeline">
      {comments.filter(comment => comment.timeMs !== undefined).map(comment => <button type="button" key={comment.id}
        style={{ left: `${Math.min(100, (comment.timeMs! / (duration * 1000)) * 100)}%` }}
        title={`${mediaTime(comment.timeMs!)} · ${comment.text}`} aria-label={`Go to comment at ${mediaTime(comment.timeMs!)}`}
        onClick={() => seekTime(comment.timeMs!)} />)}
    </span>}
    <span className="media-comments-list" role="list" aria-label="Saved comments">
      {comments.map(comment => <span className="media-comment" role="listitem" key={comment.id}>
        <span className="media-comment-meta">
          {comment.timeMs !== undefined && <button type="button" disabled={!seekTime} onClick={() => seekTime?.(comment.timeMs!)}>{mediaTime(comment.timeMs)}</button>}
          <time dateTime={new Date(comment.createdAt).toISOString()}>{new Date(comment.createdAt).toLocaleString()}</time>
        </span>
        <span className="media-comment-text">{comment.text}</span>
        <span className="media-comment-actions">
          {canQuote() && <button type="button" onClick={() => {
            sendQuote({ path: thread!.target.path, text: reviewQuote(thread!, comment), from: 0, to: 0 }); onQuote?.();
          }}>Add to chat</button>}
          <button type="button" disabled={saving || unread} onClick={() => void remove(comment.id)}>Remove</button>
        </span>
      </span>)}
      {thread && !comments.length && <span className="media-comments-empty">No comments on this version yet.</span>}
    </span>
    <label htmlFor={id}>{captureTime ? anchor === null ? "Comment at the current playback time" : `Comment at ${mediaTime(anchor)}` : "Comment on this image"}</label>
    <textarea id={id} value={draft} maxLength={4000} rows={3} disabled={saving || unread || !thread}
      placeholder="What should change?" onFocus={() => { if (anchor === null) capture(); }}
      onChange={event => setDraft(event.target.value)}
      onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void save(); } }} />
    <span className="media-comments-compose-actions">
      {captureTime && <button type="button" disabled={saving || unread} onClick={capture}>Use current time</button>}
      <button type="button" disabled={saving || unread || !thread || !draft.trim()} onClick={() => void save()}>{saving ? "Saving…" : "Save comment"}</button>
    </span>
    {notice && <span className="media-comments-notice" role="status">{notice}</span>}
  </span>;
}
