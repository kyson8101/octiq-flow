import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { bridge } from "../lib/bridge";
import { useDockWidth } from "../lib/dockWidth";
import { previewSlots, type ImagePreview } from "../lib/imagePreview";
import { recall, remember } from "../lib/remember";
import { Viewer } from "./Viewer";
import "./ImagePreviewPanel.css";

const SIZES = { initial: 440, min: 300, max: 780 };
export function PreviewButton({ count, open, onClick }: { count: number; open: boolean; onClick: () => void }) {
  return <button type="button" className={`icon-btn sfp-toggle preview-toggle ${open ? "is-on" : ""}`} aria-label={`Open previews${count ? ` (${count})` : ""}`} aria-expanded={open} onClick={onClick} title="Preview">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m4 18 6-6 4 4 3-3 4 4"/></svg>
    <span className="topbar-action-label">Preview</span>{count > 0 && <span>{count}</span>}
  </button>;
}

function Picture({ image, className }: { image: ImagePreview; className?: string }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    let made = "";
    setUrl(""); setError(false);
    bridge.fetchFile(image.path).then(blob => {
      if (!alive) return;
      made = URL.createObjectURL(blob); setUrl(made);
    }).catch(() => alive && setError(true));
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [image.path]);
  if (error) return <span role="status">Image unavailable</span>;
  return url ? <img className={className} src={url} alt={image.title} draggable={false} onError={() => setError(true)} /> : <span className="preview-loading">Loading…</span>;
}

function HtmlPreviewCard({ document }: { document: ImagePreview }) {
  const [error, setError] = useState("");
  function open() {
    setError("");
    try { bridge.openFileInBrowser(document.path); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "The document could not be opened."); }
  }
  return <div className="html-preview-card">
    <span className="html-preview-mark" aria-hidden="true">&lt;/&gt;</span>
    <strong>{document.title}</strong>
    <p>Open this document in a new tab. Your chat stays here.</p>
    <button type="button" onClick={open}>Open HTML</button>
    {error && <p className="image-preview-error" role="alert">{error}</p>}
  </div>;
}

export function ImagePreviewPanel({ conversationKey, images, error, onClose }: { conversationKey: string; images: ImagePreview[]; error: string; onClose: () => void }) {
  const selectionKey = `octiq.preview.${conversationKey}.selection`;
  const [selected, setSelected] = useState(() => recall(selectionKey) || "");
  const [scale, setScale] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const { width, startDrag } = useDockWidth("octiq.preview.width", SIZES);
  const slots = useMemo(() => previewSlots(images), [images]);
  const image = images.find(item => item.id === selected) ?? images.at(-1);
  const versions = slots.find(item => item.slot === image?.slot)?.versions ?? [];
  const version = versions.findIndex(item => item.id === image?.id);
  const newest = versions.at(-1);
  // Pin the first displayed snapshot, so arrivals cannot move it underneath
  // the person. Explicit thumbnail/version actions are the only selection changes.
  useEffect(() => {
    if (image && image.id !== selected) { setSelected(image.id); remember(selectionKey, image.id); }
  }, [image, selected, selectionKey]);
  useEffect(() => { setScale(1); setFullscreen(false); }, [image?.id]);
  useEffect(() => {
    function keydown(event: KeyboardEvent) { if (event.key === "Escape" && !fullscreen) onClose(); }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose, fullscreen]);
  function choose(id: string) { setSelected(id); remember(selectionKey, id); }
  return <>
    <button className="image-preview-scrim" aria-label="Close previews" onClick={onClose} />
    <aside className="image-preview-panel" aria-label="Preview panel" style={{ "--preview-width": `${width}px` } as CSSProperties}>
      <div className="image-preview-resize" onPointerDown={startDrag} aria-hidden="true" />
      <header className="image-preview-header"><strong>Preview</strong><span>{slots.length ? `${slots.length} preview${slots.length === 1 ? "" : "s"}` : ""}</span><button type="button" onClick={onClose} aria-label="Close preview">✕</button></header>
      {error && <p className="image-preview-error" role="status">{error}</p>}
      {image ? <>
        <div className="image-preview-caption"><strong title={image.title}>{image.title}</strong><label>Version <select aria-label="Preview version" value={image.id} onChange={event => choose(event.target.value)}>{versions.map((item, i) => <option value={item.id} key={item.id}>{i + 1}{i === versions.length - 1 ? " (latest)" : ""}</option>)}</select></label></div>
        {newest && newest.id !== image.id && <button type="button" className="image-preview-update" onClick={() => choose(newest.id)}>Newer version available · Show latest</button>}
        {image.kind === "html" ? <HtmlPreviewCard key={image.id} document={image} /> : <>
        <div className={`image-preview-stage ${scale > 1 ? "is-zoomed" : ""}`}>
          <div className="image-preview-picture" style={{ width: `${scale * 100}%`, height: `${scale * 100}%` }}><Picture key={image.id} image={image} /></div>
        </div>
        <div className="image-preview-tools">
          <button type="button" aria-label="Zoom out" disabled={scale <= 1} onClick={() => setScale(value => Math.max(1, value - 0.5))}>−</button>
          <button type="button" title="Fit image" onClick={() => setScale(1)}>{scale === 1 ? "Fit" : `${scale}×`}</button>
          <button type="button" aria-label="Zoom in" disabled={scale >= 4} onClick={() => setScale(value => Math.min(4, value + 0.5))}>+</button>
          <span>v{version + 1} / {versions.length}</span>
          <button type="button" onClick={() => setFullscreen(true)}>Full screen</button>
        </div>
        </>}
        <div className="image-preview-strip" aria-label="Preview items">{slots.map(slot => {
          const latest = slot.versions.at(-1)!;
          return <button key={slot.slot} type="button" className={slot.slot === image.slot ? "is-selected" : ""} aria-label={`${latest.title}, ${slot.versions.length} version${slot.versions.length === 1 ? "" : "s"}`} aria-pressed={slot.slot === image.slot} onClick={() => choose(latest.id)}>{latest.kind === "html" ? <span className="html-preview-thumbnail" aria-hidden="true">&lt;/&gt;<small>HTML</small></span> : <Picture image={latest} />}<span>{latest.title}</span></button>;
        })}</div>
        {fullscreen && image.kind !== "html" && <Viewer key={image.id} path={image.path} onClose={() => setFullscreen(false)} />}
      </> : <div className="image-preview-empty"><strong>See what your agent is making</strong><p>Ask your agent to share an image or HTML document here. New versions stay together so you can compare them.</p></div>}
    </aside>
  </>;
}
