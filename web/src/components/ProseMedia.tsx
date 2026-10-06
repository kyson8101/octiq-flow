// The rest of what a reply can name, shown where it named it.
//
// `ProseShot` draws a picture under the path that named it. This does the same
// for the other files a reader wants to SEE rather than open: a video or a
// recording plays in place, a PDF shows its pages in a frame, and an HTML page
// gets a card that can show it here or open it in a tab of its own.
//
// Same two rules as the picture. Nothing is fetched until it is within a screen
// of being seen — a long session names a lot of files — and a file that will
// not load leaves nothing behind: the words above it are still a link.
import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";
import { HTML_SANDBOX } from "../lib/htmlSandbox";
import { useOpenFile } from "./OpenFile";

const NEAR = "600px";

/** True once the element is within a screen of the viewport. Latches. */
function useNear<T extends Element>() {
  const holder = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const watch = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      setNear(true);
      watch.disconnect();
    }, { rootMargin: NEAR });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  return [holder, near] as const;
}

/** A video or a recording, played by the browser's own player.
 *
 *  Pointed at `/file` directly rather than fetched into a blob, so the player
 *  streams it in ranges and can seek — the same route the file panel's video
 *  uses. `preload="metadata"` asks for the length and the first frame, not the
 *  whole file. */
export function ProsePlayer({ path, kind }: { path: string; kind: "video" | "audio" }) {
  const [holder, near] = useNear<HTMLSpanElement>();
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const name = baseName(path);
  return (
    <span className={`prose-media is-${kind}`} ref={holder}>
      {!near ? <span className="prose-media-wait" aria-hidden="true" />
        : kind === "video"
          ? <video src={bridge.fileUrl(path)} controls playsInline preload="metadata" aria-label={name} onError={() => setFailed(true)} />
          : <audio src={bridge.fileUrl(path)} controls preload="metadata" aria-label={name} onError={() => setFailed(true)} />}
    </span>
  );
}

/** A PDF, its first pages in the browser's own reader. The frame scrolls; the
 *  name above it still opens the full-screen viewer. */
export function ProsePdf({ path }: { path: string }) {
  const [holder, near] = useNear<HTMLSpanElement>();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!near) return;
    let alive = true;
    let made: string | null = null;
    // Through a blob, like the viewer, so the token stays out of the markup.
    bridge.fetchFile(path).then((blob) => {
      if (!alive) return;
      made = URL.createObjectURL(blob);
      setUrl(made);
    }).catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [near, path]);
  if (failed) return null;
  return (
    <span className="prose-media is-pdf" ref={holder}>
      {url ? <iframe src={url} title={baseName(path)} /> : <span className="prose-media-wait" aria-hidden="true" />}
    </span>
  );
}

/** An HTML page: a card, shut. Agent-written pages run scripts, so one only
 *  runs when asked — here, in a sandboxed frame with no access to this page, or
 *  in a tab of its own, which is where the Preview panel sends them too. */
export function ProsePage({ path }: { path: string }) {
  const open = useOpenFile();
  const [shown, setShown] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!shown || html !== null) return;
    let alive = true;
    bridge.fetchFile(path).then((blob) => blob.text())
      .then((text) => alive && setHtml(text))
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, [shown, html, path]);
  const name = baseName(path);
  return (
    <span className="prose-media is-page">
      <span className="prose-page-card">
        <span className="prose-page-icon" aria-hidden="true">&lt;/&gt;</span>
        <span className="prose-page-name" title={path}>{name}</span>
        <button type="button" aria-expanded={shown} onClick={() => setShown((v) => !v)}>
          {shown ? "Hide" : "Show here"}
        </button>
        <button type="button" title="Open in a new tab" onClick={() => open(path)}>Open</button>
      </span>
      {shown && (
        <span className="prose-page-stage">
          {html !== null ? <iframe title={name} sandbox={HTML_SANDBOX} srcDoc={html} />
            : failed ? <span role="status">Page unavailable</span>
              : <span className="prose-media-wait" aria-hidden="true" />}
        </span>
      )}
    </span>
  );
}
