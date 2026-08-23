// The picture itself, where the reply named it.
//
// A path is already something to click, and for a picture that click is the
// whole answer: "which one is that" is a question a name never answers. On a
// phone it costs a tap, a full screen, and a tap back, for a look that lasted a
// second. So the picture is drawn under the words that named it — small enough
// to stay part of the sentence, big enough to recognise — and the tap is still
// there when a proper look is wanted.
//
// Fetched LATE. A long session names a great many files, and pulling every one
// of them down the moment the transcript renders would be a day's worth of
// screenshots fetched to be scrolled straight past. Nothing is asked for until
// the preview is within a screen of being seen.
//
// A picture that will not load leaves NOTHING behind — no broken frame, no
// error. The words above it are still a link, and that link still opens it.
import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { baseName } from "../lib/files";
import { useOpenFile } from "./OpenFile";

/** How far outside the screen still counts as "about to be seen". One screen
 *  ahead: far enough that a scroll finds the picture already there, near enough
 *  that the ones far above are never asked for at all. */
const NEAR = "600px";

export function ProseShot({ path }: { path: string }) {
  const open = useOpenFile();
  const holder = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const watch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setNear(true);
        // Once is enough: the fetch below runs on `near` and there is nothing
        // left to watch for.
        watch.disconnect();
      },
      { rootMargin: NEAR },
    );
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  useEffect(() => {
    if (!near) return;
    let alive = true;
    let made: string | null = null;
    // Through the bridge's `/file` route rather than an `<img src>` pointed at
    // it, so the access token stays out of the markup — the same reason the
    // viewer and the file chips fetch their bytes.
    bridge
      .fetchFile(path)
      .then((blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [near, path]);

  if (failed) return null;

  // A span, not a div: this is drawn INSIDE a paragraph, where a div is not
  // allowed. `display: block` is what puts it on its own line there.
  return (
    <span className="prose-shot" ref={holder}>
      {url ? (
        <button
          className="prose-shot-btn"
          type="button"
          title={`${baseName(path)} — click to see it full size`}
          onClick={() => open(path)}
        >
          <img src={url} alt={baseName(path)} />
        </button>
      ) : (
        <span className="prose-shot-wait" aria-hidden="true" />
      )}
    </span>
  );
}
