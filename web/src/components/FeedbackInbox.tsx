import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { copyText } from "../lib/clipboard";
import { feedbackBrief, feedbackStatuses, type FeedbackPage, type FeedbackReport, type FeedbackStatus } from "../lib/feedback";
import "./FeedbackInbox.css";

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const date = (at: number) => new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function FeedbackInbox({ onClose, onOpenChat, availableChatIds }: {
  onClose: () => void;
  onOpenChat: (id: string) => void;
  availableChatIds: ReadonlySet<string>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState<FeedbackPage | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<FeedbackStatus | "">("");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<FeedbackReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);

  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);

  const refresh = useCallback(async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const result = await bridge.invoke<FeedbackPage>("feedback_list", { query: query.trim(), ...(status ? { status } : {}), offset, limit: 30 });
      if (current !== request.current) return;
      if (offset > 0 && result.items.length === 0) { setOffset(0); return; }
      setPage(result); setError(null);
    } catch (err) { if (current === request.current) setError(message(err)); }
    finally { if (current === request.current) setLoading(false); }
  }, [query, status, offset]);

  useEffect(() => {
    const timer = setTimeout(() => { void refresh(); }, 150);
    const off = bridge.on("feedback-changed", () => { void refresh(); });
    const offState = bridge.onState(state => { if (state === "open") void refresh(); });
    return () => { clearTimeout(timer); off(); offState(); request.current++; };
  }, [refresh]);

  return <dialog ref={dialog} className="feedback-inbox" aria-labelledby="feedback-heading" onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="feedback-shell">
      <header className="feedback-head">
        <div><h2 id="feedback-heading">Feedback inbox</h2><p>OctiqFlow bugs and hiccups reported by your agents.</p></div>
        <button type="button" className="feedback-close" onClick={onClose} aria-label="Close feedback inbox">×</button>
      </header>
      <div className="feedback-toolbar">
        <input type="search" aria-label="Search feedback" placeholder="Search reports…" maxLength={200} value={query}
          onChange={event => { setQuery(event.target.value); setOffset(0); }} />
        <select aria-label="Filter feedback status" value={status} onChange={event => { setStatus(event.target.value as FeedbackStatus | ""); setOffset(0); }}>
          <option value="">All statuses</option>
          {Object.entries(feedbackStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button type="button" onClick={() => void refresh()} disabled={loading}>Refresh</button>
      </div>
      {error && <p className="feedback-error" role="alert">{error}</p>}
      <div className={`feedback-content${selected ? " has-selection" : ""}`}>
        <section className="feedback-list" aria-label="Feedback reports" aria-busy={loading}>
          <div className="feedback-count" role="status">{loading ? "Loading reports…" : page ? `${page.total} ${page.total === 1 ? "report" : "reports"} · ${page.newCount} new in inbox` : "Reports unavailable"}</div>
          {!loading && page?.items.length === 0 && <div className="feedback-empty">
            <h3>{query || status ? "No matching reports" : "Ready for your agents"}</h3>
            <p>{query || status ? "Try a different search or status." : "When an agent encounters an OctiqFlow issue, it can leave a report here. Review it, track the fix, and keep the resolution with the report."}</p>
          </div>}
          <ul>{page?.items.map(report => <li key={report.id}>
            <button type="button" className={`feedback-row${selected?.id === report.id ? " is-selected" : ""}`} aria-pressed={selected?.id === report.id}
              onClick={() => setSelected(report)}>
              <span className="feedback-row-meta"><span>{feedbackStatuses[report.status]}</span><span className={`feedback-severity is-${report.severity}`}>{report.severity}</span></span>
              <strong>{report.title}</strong>
              <span className="feedback-row-context">{report.source.projectName || "Unknown project"} · {report.kind}</span>
              <time dateTime={new Date(report.createdAt).toISOString()}>{date(report.createdAt)}</time>
            </button>
          </li>)}</ul>
          {page && (offset > 0 || page.nextOffset !== null) && <div className="feedback-pagination">
            <button type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - 30))}>Previous</button>
            <span>{offset + 1}–{offset + page.items.length}</span>
            <button type="button" disabled={loading || page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>Next</button>
          </div>}
        </section>
        {selected ? <FeedbackDetail key={`${selected.id}:${selected.revision}`} report={selected}
          available={availableChatIds.has(selected.source.chatId)} onOpenChat={onOpenChat}
          onBack={() => setSelected(null)} onSaved={report => { setSelected(current => current?.id === report.id ? report : current); void refresh(); }} />
          : <div className="feedback-pick"><h3>Turn observations into fixes</h3><p>Select a report to inspect the evidence, add a note, or copy a fix brief into a chat.</p></div>}
      </div>
    </div>
  </dialog>;
}

function FeedbackDetail({ report, available, onOpenChat, onBack, onSaved }: {
  report: FeedbackReport; available: boolean; onOpenChat: (id: string) => void; onBack: () => void; onSaved: (report: FeedbackReport) => void;
}) {
  const [status, setStatus] = useState(report.status);
  const [note, setNote] = useState(report.note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [changed, setChanged] = useState(false);
  const dirty = status !== report.status || note !== report.note;
  useEffect(() => bridge.on<{ id: string }>("feedback-changed", event => {
    if (event.id === report.id) setChanged(true);
  }), [report.id]);

  async function save() {
    setBusy(true); setError(null);
    try { onSaved(await bridge.invoke<FeedbackReport>("feedback_update", { id: report.id, expectedRevision: report.revision, status, note })); }
    catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError(null);
    try {
      const latest = await bridge.invoke<FeedbackReport>("feedback_get", { id: report.id });
      setStatus(latest.status); setNote(latest.note); setCopied(false); setChanged(false); onSaved(latest);
    }
    catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }
  return <article className="feedback-detail" aria-label="Selected feedback">
    <button type="button" className="feedback-back" onClick={onBack}>Back to reports</button>
    <div className="feedback-detail-meta"><span>{report.kind}</span><span className={`feedback-severity is-${report.severity}`}>{report.severity} severity</span></div>
    <h3>{report.title}</h3>
    <p className="feedback-origin">{report.source.projectName || "Unknown project"} · {report.source.modelId ?? "Unknown agent"} · OctiqFlow {report.source.appVersion}</p>
    <p className="feedback-origin">Reported {date(report.createdAt)}</p>
    <div className="feedback-actions">
      <button type="button" disabled={!available} onClick={() => onOpenChat(report.source.chatId)} title={available ? report.source.chatTitle : "The source chat is no longer available"}>Open source chat</button>
      <button type="button" disabled={dirty} title={dirty ? "Save your triage changes before copying" : undefined} onClick={async event => {
        setError(null);
        if (await copyText(feedbackBrief(report), event.currentTarget.closest("dialog") ?? undefined)) setCopied(true);
        else setError("The fix brief could not be copied. Try again.");
      }}>{copied ? "Brief copied" : "Copy fix brief"}</button>
    </div>
    {!available && <p className="feedback-origin">Source chat unavailable. This report is still saved.</p>}
    {([["Description", report.description], ["Steps to reproduce", report.steps], ["Expected behaviour", report.expected],
      ["Actual behaviour", report.actual], ["Workaround", report.workaround]] as const).filter(([, text]) => text).map(([label, text]) =>
      <section className="feedback-evidence" key={label}><h4>{label}</h4><p>{text}</p></section>)}
    <form className="feedback-triage" onSubmit={event => { event.preventDefault(); void save(); }}>
      <h4>Triage</h4>
      <label>Status<select aria-label="Status" value={status} onChange={event => setStatus(event.target.value as FeedbackStatus)} disabled={busy}>
        {Object.entries(feedbackStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>Triage note<textarea aria-label="Triage note" value={note} maxLength={8000} rows={4} disabled={busy} onChange={event => setNote(event.target.value)} placeholder="What needs fixing, a workaround, or the commit that resolved it…" /></label>
      {error && <p className="feedback-error" role="alert">{error}</p>}
      {changed && <p className="feedback-origin" role="status">This report may have changed. Reload it to see the latest triage.</p>}
      <div className="feedback-actions"><button type="submit" className="feedback-save" disabled={busy || !dirty}>{busy ? "Saving…" : "Save changes"}</button>
        <button type="button" disabled={busy} onClick={() => void reload()}>{dirty ? "Discard changes and reload" : "Reload report"}</button></div>
    </form>
    <p className="feedback-id">Report {report.id}</p>
  </article>;
}
