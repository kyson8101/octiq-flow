// One file, full screen.
//
// Shared: the file list under a reply opens files here, and so do the chips on
// a message you sent with files attached. Both are the same question — "let me
// see that" — and it would be two different answers if each drew its own.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { bridge } from "../lib/bridge";
import { baseName, isPdf } from "../lib/files";

/** Full-screen look at one image or PDF.
 *
 *  The bytes come from the backend's `/file` route rather than the WebSocket:
 *  an image down a JSON frame would have to be base64, and the browser already
 *  knows how to fetch and decode a URL. It is fetched rather than pointed at
 *  with `<img src>` so the access token stays out of the markup — the same
 *  reason the PDF goes in a frame pointed at a blob rather than at `/file`.
 *  The route already labels a PDF `application/pdf`, so the frame renders it
 *  with the browser's own reader. */
export function Viewer({ path, onClose }: { path: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    bridge
      .fetchFile(path)
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Drawn on the PAGE, not where it was opened from.
  //
  // `position: fixed` is not enough on its own. This opens from inside a
  // message, and a message waiting to be picked up is dimmed —
  // `.msg.is-queued .msg-body { opacity: 0.62 }` — which makes a stacking
  // context that every descendant inherits, fixed ones included. The result was
  // a full-screen viewer you could see the chat through, scrim and all. An
  // ancestor `transform` would break it the same way, by making the viewport it
  // is fixed to something other than the window.
  return createPortal(
    <div className="viewer" onClick={onClose}>
      <div className="viewer-bar">
        <span className="viewer-name">{baseName(path)}</span>
        <button className="viewer-close" type="button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {error ? (
        <div className="viewer-error">{error}</div>
      ) : url ? (
        isPdf(path) ? (
          <iframe className="viewer-pdf" src={url} title={baseName(path)} />
        ) : (
          <img className="viewer-img" src={url} alt={baseName(path)} onClick={(e) => e.stopPropagation()} />
        )
      ) : (
        <div className="dots" aria-label="loading" />
      )}
    </div>,
    document.body,
  );
}
