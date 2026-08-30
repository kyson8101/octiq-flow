// One file, full screen.
//
// Shared: the file list under a reply opens files here, and so do the chips on
// a message you sent with files attached. Both are the same question — "let me
// see that" — and it would be two different answers if each drew its own.
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { bridge } from "../lib/bridge";
import { baseName, isPdf } from "../lib/files";
import {
  anchorPan,
  clampPan,
  clampScale,
  MAX_SCALE,
  MIN_SCALE,
  stepScale,
  wheelScale,
  type Pan,
} from "../lib/zoom";
import { RollingText } from "./RollingNumber";

/** The middle of the screen — what a button press zooms towards, having no
 *  pointer of its own to aim at. */
const CENTRE: Pan = { x: 0, y: 0 };

/** How far a press may slide and still count as a click. Below this a click on
 *  the backdrop still closes the viewer; above it the hand was panning and
 *  closing would be a surprise. */
const DRAG_SLOP = 4;

/** What the viewer is showing: how far in, and how far the picture has been
 *  pushed from the middle. One piece of state and not two, because every
 *  gesture changes both at once — zooming towards a pointer is a scale AND the
 *  pan that keeps that spot under it. */
type View = { scale: number; pan: Pan };

const FIT: View = { scale: MIN_SCALE, pan: CENTRE };

/** Full-screen look at one image or PDF.
 *
 *  The bytes come from the backend's `/file` route rather than the WebSocket:
 *  an image down a JSON frame would have to be base64, and the browser already
 *  knows how to fetch and decode a URL. It is fetched rather than pointed at
 *  with `<img src>` so the access token stays out of the markup — the same
 *  reason the PDF goes in a frame pointed at a blob rather than at `/file`.
 *  The route already labels a PDF `application/pdf`, so the frame renders it
 *  with the browser's own reader.
 *
 *  An image can be zoomed and dragged; a PDF cannot, because the browser's own
 *  reader already has a zoom of its own and two of them would fight. */
export function Viewer({ path, onClose }: { path: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>(FIT);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const pdf = isPdf(path);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    setView(FIT);
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

  /** One change of scale: anchored on the point asked for, then pushed back
   *  inside the screen. Both halves live in lib/zoom, tested without a browser.
   *
   *  The sizes are read off the DOM at the moment of the change rather than
   *  held in state. The image's LAYOUT size is what is wanted — how big the
   *  browser fitted it to the window — and `offsetWidth` gives exactly that,
   *  ignoring the transform painted on top of it. Nothing to keep in sync. */
  const retarget = useCallback((v: View, to: number, anchor: Pan): View => {
    const scale = clampScale(to);
    const stage = stageRef.current;
    const img = imgRef.current;
    const viewport = { w: stage?.clientWidth ?? 0, h: stage?.clientHeight ?? 0 };
    const content = { w: img?.offsetWidth ?? 0, h: img?.offsetHeight ?? 0 };
    return { scale, pan: clampPan(anchorPan(v.pan, anchor, v.scale, scale), viewport, content, scale) };
  }, []);

  const zoomBy = useCallback(
    (next: (from: number) => number, anchor: Pan = CENTRE) =>
      setView((v) => retarget(v, next(v.scale), anchor)),
    [retarget],
  );

  /** A screen point as an offset from the middle of the stage, which is what
   *  the pan is measured in and what the transform's origin is. */
  const anchorAt = useCallback((clientX: number, clientY: number): Pan => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return CENTRE;
    return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) };
  }, []);

  // The wheel is bound by hand instead of with `onWheel` because React attaches
  // that one PASSIVELY, where `preventDefault` is ignored. It has to be
  // prevented: a trackpad pinch arrives as a wheel with `ctrlKey` set, and left
  // alone the browser zooms the entire page instead of the picture.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || pdf) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // A pinch is reported in much smaller steps than a wheel notch; without
      // the multiplier it takes a whole hand's travel to reach 2×.
      const delta = e.ctrlKey ? e.deltaY * 3 : e.deltaY;
      zoomBy((from) => wheelScale(from, delta), anchorAt(e.clientX, e.clientY));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [anchorAt, pdf, url, zoomBy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return onClose();
      if (pdf || e.metaKey || e.ctrlKey || e.altKey) return;
      // The composer keeps its focus while the viewer is open, so `-` typed
      // into a half-written message must stay a `-`.
      const on = e.target as HTMLElement | null;
      if (on && (on.tagName === "INPUT" || on.tagName === "TEXTAREA" || on.isContentEditable)) return;
      if (e.key === "+" || e.key === "=") zoomBy((from) => stepScale(from, 1));
      else if (e.key === "-" || e.key === "_") zoomBy((from) => stepScale(from, -1));
      else if (e.key === "0") setView(FIT);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pdf, zoomBy]);

  // Every finger or button currently down on the stage. One is a drag, two are
  // a pinch, and the map is what tells them apart — a touch screen can start
  // the second one at any moment, halfway through the first.
  const points = useRef(new Map<number, Pan>());
  const drag = useRef<{ id: number; from: Pan; pan: Pan } | null>(null);
  const pinch = useRef<number | null>(null);
  const moved = useRef(false);

  const spread = () => {
    const [a, b] = [...points.current.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  const midpoint = () => {
    const [a, b] = [...points.current.values()];
    return anchorAt((a.x + b.x) / 2, (a.y + b.y) / 2);
  };

  function onPointerDown(e: ReactPointerEvent) {
    if (pdf) return;
    // A fresh press starts out as a click. Cleared here rather than when the
    // click lands, because a click on the picture never reaches the backdrop
    // handler that would otherwise do the clearing.
    if (points.current.size === 0) moved.current = false;
    points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (points.current.size === 2) {
      // A second finger turns a drag into a pinch, and the drag is dropped
      // rather than finished — carrying it on would fight the pinch.
      drag.current = null;
      pinch.current = spread();
      moved.current = true;
      return;
    }
    if (points.current.size > 2 || view.scale <= MIN_SCALE) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, from: { x: e.clientX, y: e.clientY }, pan: view.pan };
  }

  function onPointerMove(e: ReactPointerEvent) {
    if (!points.current.has(e.pointerId)) return;
    points.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pinch.current !== null && points.current.size === 2) {
      const now = spread();
      // Measured against the LAST move, not against the start, so the anchor
      // can travel with the fingers instead of drifting away from them.
      const ratio = pinch.current > 0 ? now / pinch.current : 1;
      pinch.current = now;
      zoomBy((from) => from * ratio, midpoint());
      return;
    }

    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.from.x;
    const dy = e.clientY - d.from.y;
    if (Math.abs(dx) > DRAG_SLOP || Math.abs(dy) > DRAG_SLOP) moved.current = true;
    setView((v) => retarget({ ...v, pan: { x: d.pan.x + dx, y: d.pan.y + dy } }, v.scale, CENTRE));
  }

  function onPointerUp(e: ReactPointerEvent) {
    points.current.delete(e.pointerId);
    if (points.current.size < 2) pinch.current = null;
    if (drag.current?.id === e.pointerId) drag.current = null;
  }

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
    <div
      className="viewer"
      // A press that slid was a pan, not a click on the backdrop, and closing
      // the picture someone was busy dragging is the wrong answer.
      onClick={() => (moved.current ? (moved.current = false) : onClose())}
    >
      <div className="viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span className="viewer-name">{baseName(path)}</span>
        {!pdf && url && (
          <div className="viewer-zoom">
            <button
              className="viewer-btn"
              type="button"
              onClick={() => zoomBy((from) => stepScale(from, -1))}
              disabled={view.scale <= MIN_SCALE}
              aria-label="Zoom out"
              title="Zoom out (−)"
            >
              −
            </button>
            <button
              className="viewer-level"
              type="button"
              onClick={() => setView(FIT)}
              disabled={view.scale <= MIN_SCALE}
              title="Fit to screen (0)"
            >
              <RollingText>{`${Math.round(view.scale * 10) / 10}×`}</RollingText>
            </button>
            <button
              className="viewer-btn"
              type="button"
              onClick={() => zoomBy((from) => stepScale(from, 1))}
              disabled={view.scale >= MAX_SCALE}
              aria-label="Zoom in"
              title="Zoom in (+)"
            >
              +
            </button>
          </div>
        )}
        <button className="viewer-close" type="button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {error ? (
        <div className="viewer-error">{error}</div>
      ) : url ? (
        pdf ? (
          <iframe className="viewer-pdf" src={url} title={baseName(path)} />
        ) : (
          <div
            className={`viewer-stage ${view.scale > MIN_SCALE ? "is-zoomed" : ""}`}
            ref={stageRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={(e) =>
              zoomBy((from) => (from > MIN_SCALE ? MIN_SCALE : 2), anchorAt(e.clientX, e.clientY))
            }
          >
            <img
              className="viewer-img"
              ref={imgRef}
              src={url}
              alt={baseName(path)}
              draggable={false}
              style={{ transform: `translate(${view.pan.x}px, ${view.pan.y}px) scale(${view.scale})` }}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )
      ) : (
        <div className="dots" aria-label="loading" />
      )}
    </div>,
    document.body,
  );
}
