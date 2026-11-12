import type { ChatState } from "./chat";
import { valueBytes } from "./valueBytes";

// Every opened chat keeps its window; there is no count cap. Offscreen windows,
// in addition to the visible pane(s), share only a SAFETY byte budget (the
// conservative UTF-16 estimate of `valueBytes`), per tab. Past it the oldest
// window goes first, and never one that holds words typed in this tab only.
export const RECENT_CHAT_BYTES = 256 * 1024 * 1024;

/** Only recency and weak size measurements live here. App owns the single
 * copy of each reducer window, its CatchUp mark and ChatHistory provenance.
 * Keeping these together lets a quick switch show the same words immediately
 * and catch up from its tail, including when the window is partial. */
export class ChatWindowCache {
  private recent = new Set<string>();
  constructor(private readonly budget = RECENT_CHAT_BYTES) {}
  private sizes = new WeakMap<ChatState, number>();
  forget(id: string): void { this.recent.delete(id); }

  /** `pinned` names windows that hold words only this tab has (a prompt not
   * yet echoed by the host): they are kept whatever the budget says. */
  retain(states: Record<string, ChatState>, shown: ReadonlySet<string>, holds: (id: string) => boolean,
    pinned: (id: string) => boolean = () => false): Set<string> {
    // Settings/Agents/Projects cover the panes without changing their recency.
    // They still obey the same byte budget, and deleted chats drop out.
    for (const id of shown) { this.recent.delete(id); this.recent.add(id); }
    const keep = new Set<string>();
    let bytes = 0;
    for (const id of [...this.recent].reverse()) {
      if (shown.has(id)) continue;
      const state = states[id];
      if (!state || !holds(id)) { this.recent.delete(id); continue; }
      let size = this.sizes.get(state);
      if (size === undefined) { size = valueBytes(state, this.budget); this.sizes.set(state, size); }
      if (bytes + size > this.budget && !pinned(id)) { this.recent.delete(id); continue; }
      keep.add(id); bytes += size;
    }
    return keep;
  }
}
