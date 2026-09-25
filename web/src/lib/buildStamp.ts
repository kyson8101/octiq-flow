// Which reader built the messages a cache is holding.
//
// Two caches keep whole transcripts — `Message[]`, already built by
// `reduceChat`: the IndexedDB checkpoint (lib/chatCache) and the synchronous
// copy in localStorage (lib/store). Both exist so a reopened chat paints at
// once instead of replaying thousands of events, and both work by replaying
// only what came AFTER the point they stored.
//
// That is what makes a reducer change invisible. The stored messages were
// built by the OLD reader, the events that produced them are never revisited,
// and the new reader only ever sees what arrives next. The code ships, the
// screen does not, and the only symptom is somebody saying it looks no
// different.
//
// The answer is NOT to throw the cache away. Blanking a transcript drops the
// chat onto the paginated load path, where the server serves only the last few
// turns and every re-cache path is gated on `hasEarlier` — so the chat pages
// for ever, never refills, and permanently shows a fraction of itself. What
// was a stale drawing becomes a missing conversation.
//
// So a cache that is not this reader's is MIGRATED, in place, keeping `seq`
// and every word (see lib/cacheMigration). This number is what says one is
// needed.

/** Bump whenever `reduceChat` draws the same events differently, and add the
 *  migration that carries the old drawing forward.
 *
 *  Deliberately NOT tied to the app version. Every release bumps that (see
 *  AGENTS.md), and a cache generation per release is a cache that is cold
 *  whenever it matters. A reducer change is a thing somebody does on purpose,
 *  and this is the line they change when they do it.
 *
 *  2 — peer turns (a subagent's hand-back, another session's message) stopped
 *      being drawn as user bubbles. See lib/peerMessage.
 *  3 — 2 is not trustworthy: it shipped while only one of the two caches was
 *      stamped, so a build carrying it could write the previous reader's work
 *      back out under a stamp of its own. */
// 4 — rerun the echoed-handback repair for rows already stamped 3 before
// the migration stopped treating an echo as proof of human authorship.
export const CACHE_SCHEMA = 4;

/** What a cache WRITES. Required on purpose — a stamp a writer could leave off
 *  is worse than no stamp, because what it leaves behind reads as this
 *  reader's own work. */
export type BuildStamp = { schema: number };

/** What a cache READS: absent on anything written before stamping. */
export type StoredStamp = Partial<BuildStamp>;

/** One frozen object rather than a factory. `saveConversations` runs on every
 *  lull in a streaming answer, over up to eighty rows, and this never changes
 *  within a build. */
export const BUILD_STAMP: Readonly<BuildStamp> = Object.freeze({ schema: CACHE_SCHEMA });

/** Did THIS reader build it? Anything else — an older schema, or none at all
 *  because the record predates stamping — has to be carried forward first. */
export function ourBuild(value: StoredStamp | null | undefined): boolean {
  return !!value && value.schema === BUILD_STAMP.schema;
}
