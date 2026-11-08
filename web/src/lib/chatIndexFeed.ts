import { bridge } from "./bridge";
import type { IndexEntry, DeletedIndexEntry } from "./chatIndex";

export type IndexReading = { entries: IndexEntry[]; deleted: DeletedIndexEntry[]; partial: boolean; removed: string[] };
type Change = { id: string; gone: boolean; entry: IndexEntry | null; deleted?: DeletedIndexEntry | null };

/** One authoritative read per connection. Events received during that read
 * are replayed afterwards; an old list reply cannot undo a newer delete. */
export function createChatIndexFeed() {
  let rows: IndexEntry[] = [], trash: DeletedIndexEntry[] = [];
  let reading: Promise<IndexEntry[]> | undefined;
  let generation = 0, ready = false;
  let buffered = new Map<string, Change>();
  let invalidated = false;
  const lookups = new Map<string, Promise<IndexEntry[]>>();
  const lookupChanges = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<(reading: IndexReading) => void>();
  const tell = (value: IndexReading) => { for (const fn of listeners) fn(value); };
  const apply = (change: Change) => {
    if (lookupChanges.has(change.id)) lookupChanges.set(change.id, lookupChanges.get(change.id)! + 1);
    const previous = rows.find(row => row.id === change.id);
    rows = rows.filter(row => row.id !== change.id);
    if (change.entry) rows.push({ ...change.entry, coordinatesRun: change.entry.coordinatesRun ?? previous?.coordinatesRun });
    trash = trash.filter(row => row.id !== change.id);
    if (change.deleted) trash.push(change.deleted);
    tell({ entries: change.entry ? [rows.find(row => row.id === change.id)!] : [], deleted: change.deleted ? [change.deleted] : [], partial: true, removed: change.entry ? [] : [change.id] });
  };
  const read = (): Promise<IndexEntry[]> => {
    if (reading) return reading;
    const current = generation; invalidated = false;
    reading = Promise.all([bridge.invoke<IndexEntry[]>("chat_index_list"), bridge.invoke<DeletedIndexEntry[]>("chat_index_deleted")]).then(([entries, deleted]) => {
      if (current !== generation) return rows;
      rows = entries ?? []; trash = deleted ?? []; ready = true;
      tell({ entries: rows, deleted: trash, partial: false, removed: [] });
      for (const change of buffered.values()) apply(change);
      buffered.clear();
      return rows;
    }).finally(() => {
      if (current !== generation) return;
      reading = undefined;
      if (invalidated) { clearTimeout(timer); timer = setTimeout(() => { void read().catch(() => {}); }, 250); }
    });
    return reading;
  };
  let detach: (() => void) | undefined;
  return {
    entries: () => ready ? Promise.resolve(rows) : read(),
    async forChat(id: string): Promise<IndexEntry[]> {
      const entries = ready ? rows : await read();
      if (entries.some(row => row.id === id)) return entries;
      // A notification may outrun its index event. Resolve that identity,
      // never the entire install, and share simultaneous notification taps.
      let lookup = lookups.get(id);
      if (!lookup) {
        const current = generation;
        lookupChanges.set(id, 0);
        lookup = bridge.invoke<IndexEntry | null>("chat_index_entry", { id }).then(entry => {
          if (entry && generation === current && lookupChanges.get(id) === 0) apply({ id, gone: false, entry });
          return generation === current ? rows : [];
        }, error => {
          if (String(error).includes("not available on this backend")) return read();
          throw error;
        }).finally(() => { if (lookups.get(id) === lookup) { lookups.delete(id); lookupChanges.delete(id); } });
        lookups.set(id, lookup);
      }
      return lookup;
    },
    subscribe(fn: (reading: IndexReading) => void) {
      listeners.add(fn);
      if (!detach) {
        const offEvent = bridge.on<Change>("chat-index-changed", change => {
          if (change && Object.hasOwn(change, "entry")) {
            if (reading || !ready) {
              buffered.set(change.id, change);
              // A failed initial read is still unknown. A later host change
              // can retry it once; buffering alone would wait for reconnect.
              if (!reading) void read().catch(() => {});
            } else apply(change);
          } else {
            // An older server only invalidates. Keep its coalesced refresh.
            if (reading) invalidated = true;
            else { clearTimeout(timer); timer = setTimeout(() => { void read().catch(() => {}); }, 250); }
          }
        });
        const offState = bridge.onState(state => {
          if (state !== "open") { generation++; reading = undefined; ready = false; buffered.clear(); invalidated = false; lookups.clear(); lookupChanges.clear(); return; }
          void read().catch(() => {});
        });
        detach = () => { offEvent(); offState(); clearTimeout(timer); };
      }
      return () => { listeners.delete(fn); if (!listeners.size) { detach?.(); detach = undefined; } };
    },
  };
}
export const chatIndexFeed = createChatIndexFeed();
