// One answer to "is this a real file", shared by everything that asks.
//
// Two places need it and they ask about the SAME strings. The files panel scans
// the transcript for path-ish text and throws away what does not exist; the
// clickable paths in a reply (see lib/filepaths) need to know exactly that
// about exactly those words, because a link that opens nothing is worse than
// the plain text it replaced. Left as two caches it would be two existence
// checks per path, and the second one would arrive late enough to see the link
// appear a moment after the words did.
//
// So the answers live here, keyed by path AND working directory — a relative
// path is a different file under a different project — and both sides read the
// same map. Whoever asks first pays; everyone else is answered from memory.
//
// Questions are batched. A reply mentioning thirty files renders thirty
// components in one pass, and thirty round trips for what the backend will
// answer in one list is the sort of thing that makes a chat feel slow.
import { bridge } from "./bridge";

/** How long to collect questions before asking. One render pass is over in
 *  well under this, so a burst of components becomes a single call. */
const BATCH_MS = 40;

/** A ceiling on what is remembered, so a very long day cannot grow this without
 *  bound. Far above what any real conversation reaches. */
const MAX_ANSWERS = 4000;

/** candidate + cwd → the real path, or null for "no such file". */
const answers = new Map<string, string | null>();
/** Asked and not yet answered. Keeps a path that thirty components want from
 *  being sent thirty times. */
const inflight = new Set<string>();
/** cwd → the paths waiting to be asked about. */
const queue = new Map<string, Set<string>>();
const listeners = new Set<() => void>();

let timer: ReturnType<typeof setTimeout> | null = null;

/** The two joined by a NUL, which neither of them can contain. */
const keyOf = (raw: string, cwd: string) => `${cwd}\u0000${raw}`;

/** What is known about one path: the file it turned out to be, `null` for a
 *  path that does not exist, or `undefined` for one nothing has asked about
 *  yet. */
export function knownPath(raw: string, cwd: string): string | null | undefined {
  return answers.get(keyOf(raw, cwd));
}

/** The same, for a list — the shape the files column reads (see lib/pins).
 *  Paths with no answer yet are simply absent. */
export function knownPaths(raws: string[], cwd: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const raw of raws) {
    const answer = answers.get(keyOf(raw, cwd));
    if (answer !== undefined) out.set(raw, answer);
  }
  return out;
}

/** Ask about anything here that has not been asked about yet. Cheap to call
 *  with a list that is entirely known — that is the common case. */
export function askPaths(raws: string[], cwd: string): void {
  let added = false;
  for (const raw of raws) {
    const key = keyOf(raw, cwd);
    if (answers.has(key) || inflight.has(key)) continue;
    inflight.add(key);
    let waiting = queue.get(cwd);
    if (!waiting) queue.set(cwd, (waiting = new Set()));
    waiting.add(raw);
    added = true;
  }
  if (added && timer === null) timer = setTimeout(flush, BATCH_MS);
}

/** Told when answers arrive. Returns the way to stop being told. */
export function subscribePaths(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function flush(): void {
  timer = null;
  const batches = [...queue.entries()];
  queue.clear();

  for (const [cwd, waiting] of batches) {
    const raws = [...waiting];
    bridge
      .invoke<(string | null)[]>("resolve_paths", { paths: raws, cwd })
      .then((resolved) => {
        // Position by position, the way the backend answers.
        raws.forEach((raw, i) => {
          const key = keyOf(raw, cwd);
          inflight.delete(key);
          answers.set(key, resolved?.[i] ?? null);
        });
        if (answers.size > MAX_ANSWERS) answers.clear();
        for (const listener of listeners) listener();
      })
      .catch(() => {
        // A check that failed is not an answer. Writing "does not exist" in
        // here would hide a real file for the rest of the session, so the
        // question simply becomes askable again.
        for (const raw of raws) inflight.delete(keyOf(raw, cwd));
      });
  }
}

/** Forget everything. For tests — nothing in the app has a reason to. */
export function resetPathStore(): void {
  answers.clear();
  inflight.clear();
  queue.clear();
  listeners.clear();
  if (timer !== null) clearTimeout(timer);
  timer = null;
}
