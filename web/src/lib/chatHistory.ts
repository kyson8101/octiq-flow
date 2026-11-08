import type { Frame } from "./catchUp";

export type ChatPage = { events: Frame[]; context: Frame[]; before: number | null };
type Window = { before: number | null; end?: number };
/** Provenance only: never retain message bodies or raw stream frames here. */
export type HistorySlice = { ids: string[]; end: number; agentIds?: string[]; outcomeIds?: string[]; notices?: number };

/** Keep only the cursor of a partial transcript. The server already holds its
 * raw events. Retaining every live delta here doubled long chats' memory and
 * kept growing even after switching away. Page provenance lets earlier reads
 * evict whole newest pages without replaying or measuring their bodies again. */
export class ChatHistory {
  private windows = new Map<string, Window>();
  private pages = new Map<string, HistorySlice[]>();
  slices(id: string): readonly HistorySlice[] { return this.pages.get(id) ?? []; }
  get(id: string): Window | undefined { return this.windows.get(id); }
  hasEarlier(id: string): boolean { return this.windows.get(id)?.before != null; }
  isPast(id: string): boolean { return this.windows.get(id)?.end !== undefined; }
  isPartial(id: string): boolean { return this.windows.has(id); }
  forget(id: string): void { this.windows.delete(id); this.pages.delete(id); }
  set(id: string, before: number | null, end?: number, pages?: HistorySlice[]): void {
    if (before === null && end === undefined) this.forget(id);
    else {
      this.windows.set(id, { before, ...(end !== undefined ? { end } : {}) });
      if (pages) this.pages.set(id, pages);
      else this.pages.delete(id);
    }
  }
}
