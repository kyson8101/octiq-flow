import { mediaRevision } from "./pathStore";

/** A busy host must not make a loaded player's Play button feel ignored. */
export const MEDIA_FRESHNESS_WAIT_MS = 100;

/** Lives on the element, including while it is detached into nowPlaying.
 *  Both native controls (play event) and JS/mini-player play() come through
 *  here. Play continues immediately; only a verified changed file restarts
 *  it. A late answer never replaces a source during playback. */
export function keepMediaFresh(el: HTMLMediaElement, path: string, url: string, read = mediaRevision) {
  const play = el.play.bind(el);
  const pause = el.pause.bind(el);
  let revision: string | null = null;
  let request = 0;
  let permitted = false;
  let ownPauses = 0;
  let inFlight: Promise<string | null> | null = null;
  let starting: { request: number; promise: Promise<void> } | null = null;
  // Keep the lookup alive after a timeout, but never overlap it with another
  // one, including a new play after Pause. Repeated plays share the intent too.
  const lookup = () => inFlight ??= read(path).catch(() => null).finally(() => { inFlight = null; });
  const bounded = (pending: Promise<string | null>) => new Promise<string | null>(resolve => {
    const deadline = performance.now() + MEDIA_FRESHNESS_WAIT_MS;
    const timer = setTimeout(() => resolve(null), MEDIA_FRESHNESS_WAIT_MS);
    // A busy render may delay the timer past a socket task. The elapsed time,
    // rather than whichever overdue task runs first, decides what is fresh.
    void pending.then(value => { clearTimeout(timer); resolve(performance.now() <= deadline ? value : null); });
  });
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
  const start = (native = false): Promise<void> => {
    if (starting?.request === request) return starting.promise;
    if (!native && !el.paused && !el.ended) return play();
    const intent = { request, promise: Promise.resolve() };
    intent.promise = (async () => {
      await ready;
      if (intent.request !== request || !el.isConnected || !el.getAttribute("src")) return;
      let failure: { error: unknown } | undefined;
      let first: Promise<void> | undefined;
      if (!native) {
        permitted = true;
        // Start in the person's gesture, including mini-player Play. Attach
        // a rejection handler now: a verified reload can abort this first
        // play promise, and its replacement is the one that must succeed.
        first = play().catch(error => { permitted = false; failure = { error }; });
      }
      const next = await bounded(lookup());
      // Only Pause/release cancels intent. Another Play must not invalidate
      // the press already waiting for this same host answer.
      if (intent.request !== request || !el.isConnected || !el.getAttribute("src")) return;
      const changed = next !== null && revision !== null && next !== revision;
      if (el.paused && !failure) return;
      if (next !== null) {
        // An unavailable initial stat is not evidence that a file changed.
        if (changed) {
          stop();
          el.src = versioned(next);
          el.load();
          el.currentTime = 0;
        }
        revision = next;
      }
      if (!changed) {
        await first;
        if (failure) throw failure.error;
        return;
      }
      permitted = true;
      try { await play(); } catch (error) { permitted = false; throw error; }
    })().finally(() => { if (starting === intent) starting = null; });
    starting = intent;
    return intent.promise;
  };
  el.play = () => start();
  el.addEventListener("play", () => {
    if (permitted) { permitted = false; return; }
    void start(true).catch(() => {});
  });
  el.addEventListener("pause", () => {
    if (ownPauses) ownPauses--;
    else request++;
  });
}
