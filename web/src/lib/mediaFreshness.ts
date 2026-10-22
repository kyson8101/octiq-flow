import { mediaRevision } from "./pathStore";

/** Lives on the element, including while it is detached into nowPlaying.
 *  Both native controls (play event) and JS/mini-player play() come through
 *  here. Hold the request paused during the lookup: an already playing file
 *  never has its source replaced by a late answer. */
export function keepMediaFresh(el: HTMLMediaElement, path: string, url: string, read = mediaRevision) {
  const play = el.play.bind(el);
  const pause = el.pause.bind(el);
  let revision: string | null = null;
  let request = 0;
  let permitted = false;
  let ownPauses = 0;
  const lookup = () => read(path).catch(() => null);
  const versioned = (value: string | null) => value === null ? url
    : `${url}${url.includes("?") ? "&" : "?"}revision=${encodeURIComponent(value)}`;
  // Establish the revision BEFORE fetching the first frame. A later play must
  // compare against the file this element actually loaded, not a shared cache.
  const ready = lookup().then(value => {
    revision = value;
    if (el.isConnected) el.src = versioned(value);
  });
  const stop = () => {
    if (!el.paused) ownPauses++;
    pause();
  };
  el.pause = () => { request++; stop(); };
  const start = async () => {
    if (!el.paused && !el.ended) return play();
    const asked = ++request;
    await ready;
    const next = await lookup();
    // Close, deletion, another request, or a native Pause cancels this intent.
    if (asked !== request || !el.isConnected || !el.getAttribute("src") || !el.paused) return;
    if (next !== null && next !== revision) {
      revision = next;
      el.src = versioned(next);
      el.load();
      el.currentTime = 0;
    }
    permitted = true;
    try { await play(); } catch (error) { permitted = false; throw error; }
  };
  el.play = start;
  el.addEventListener("play", () => {
    if (permitted) { permitted = false; return; }
    stop();
    void start().catch(() => {});
  });
  el.addEventListener("pause", () => {
    if (ownPauses) ownPauses--;
    else request++;
  });
}
