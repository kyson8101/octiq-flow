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
  let pendingRevision: string | null = null;
  let request = 0;
  let permitted = false;
  let ownPauses = 0;
  let inFlight: Promise<string | null> | null = null;
  let starting: { request: number; promise: Promise<void> } | null = null;
  // Keep the lookup alive after a timeout, but never overlap it with another
  // one, including a new play after Pause. Repeated plays share the intent too.
  const lookup = () => inFlight ??= read(path).catch(() => null).then(value => {
    // Keep confirmed answers even when the active press has timed out or was
    // cancelled. Only a subsequent explicit Play may consume a late revision.
    if (value !== null) pendingRevision = value;
    return value;
  }).finally(() => { inFlight = null; });
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
    pendingRevision = null;
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
      let failure: { error: unknown; replaced: boolean } | undefined;
      let first: Promise<void> | undefined;
      let replacing = false;
      const finishFirst = async () => {
        await first;
        // Pause/release cancels playback intent, never a rejection the caller
        // is owed. Only an AbortError from our reload belongs to its successor.
        if (failure && !(failure.replaced && (failure.error as { name?: string })?.name === "AbortError")) throw failure.error;
      };
      const replace = (value: string) => {
        stop();
        replacing = true;
        el.src = versioned(value);
        el.load();
        el.currentTime = 0;
        revision = value;
      };
      const known = pendingRevision;
      pendingRevision = null;
      if (known !== null) {
        if (revision !== null && known !== revision) replace(known);
        else revision = known;
      }
      const replacedBeforePlay = replacing;
      replacing = false;
      if (!native || replacedBeforePlay) {
        permitted = true;
        // Start in the person's gesture, including mini-player Play. Attach
        // a rejection handler now: a verified reload can abort this first
        // play promise, and its replacement is the one that must succeed.
        first = play().catch(error => { permitted = false; failure = { error, replaced: replacing }; });
      }
      const next = await bounded(lookup());
      // Only Pause/release cancels intent. Another Play must not invalidate
      // the press already waiting for this same host answer.
      if (intent.request !== request || !el.isConnected || !el.getAttribute("src")) { await finishFirst(); return; }
      const changed = next !== null && revision !== null && next !== revision;
      if (el.paused && !failure) { await finishFirst(); return; }
      if (next !== null) {
        // An unavailable initial stat is not evidence that a file changed.
        if (changed) {
          replace(next);
        }
        revision = next;
        if (pendingRevision === next) pendingRevision = null;
      }
      if (!changed) {
        await finishFirst();
        return;
      }
      permitted = true;
      try { await play(); } catch (error) { permitted = false; await finishFirst(); throw error; }
      await finishFirst();
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
