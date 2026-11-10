import type { ChatState } from "./chat";
import { valueBytes } from "./valueBytes";

export const RECENT_CHAT_WINDOWS = 2;
export const RECENT_CHAT_BYTES = 8 * 1024 * 1024;

/** Only recency and weak size measurements live here. App owns the single
 * copy of each reducer window, its CatchUp mark and ChatHistory provenance.
 * Keeping these together lets a quick switch show the same words immediately
 * and catch up from its tail, including when the window is partial. */
export class ChatWindowCache {
  private recent = new Set<string>();
  private sizes = new WeakMap<ChatState, number>();

  retain(states: Record<string, ChatState>, shown: ReadonlySet<string>, holds: (id: string) => boolean): Set<string> {
    // Covered app surfaces still release transcripts (Settings, Agents, etc.).
    if (!shown.size) { this.recent.clear(); return new Set(); }
    for (const id of shown) { this.recent.delete(id); this.recent.add(id); }
    const keep = new Set<string>();
    let bytes = 0;
    for (const id of [...this.recent].reverse()) {
      if (shown.has(id)) continue;
      const state = states[id];
      if (!state || !holds(id) || keep.size >= RECENT_CHAT_WINDOWS) { this.recent.delete(id); continue; }
      let size = this.sizes.get(state);
      if (size === undefined) { size = valueBytes(state, RECENT_CHAT_BYTES); this.sizes.set(state, size); }
      if (bytes + size > RECENT_CHAT_BYTES) { this.recent.delete(id); continue; }
      keep.add(id); bytes += size;
    }
    return keep;
  }
}
