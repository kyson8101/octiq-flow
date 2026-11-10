import type { ChatState } from "./chat";
import { valueBytes } from "./valueBytes";

// Offscreen windows, in addition to the visible pane(s), share a conservative
// UTF-16 budget. An indivisible 23 MB turn may use most of it alone; above the
// budget the chat still falls back to the existing paged replay/checkpoint path.
export const RECENT_CHAT_WINDOWS = 6;
export const RECENT_CHAT_BYTES = 48 * 1024 * 1024;

/** Only recency and weak size measurements live here. App owns the single
 * copy of each reducer window, its CatchUp mark and ChatHistory provenance.
 * Keeping these together lets a quick switch show the same words immediately
 * and catch up from its tail, including when the window is partial. */
export class ChatWindowCache {
  private recent = new Set<string>();
  private sizes = new WeakMap<ChatState, number>();
  forget(id: string): void { this.recent.delete(id); }

  retain(states: Record<string, ChatState>, shown: ReadonlySet<string>, holds: (id: string) => boolean): Set<string> {
    // Settings/Agents/Projects cover the panes without changing their recency.
    // They still obey the same count/byte budget, and deleted chats drop out.
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
