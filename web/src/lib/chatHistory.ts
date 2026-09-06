import type { Frame } from "./catchUp";

export type ChatPage = { events: Frame[]; context: Frame[]; before: number | null };
type Window = { events: Frame[]; before: number };

/** Only a partial window needs raw events. Prepending a page replays the loaded
 * window so tool results, compaction summaries and queued prompts can find
 * their earlier counterparts. Once complete, keep just the normal checkpoint. */
export class ChatHistory {
  private windows = new Map<string, Window>();
  get(id: string): Window | undefined { return this.windows.get(id); }
  hasEarlier(id: string): boolean { return this.windows.has(id); }
  forget(id: string): void { this.windows.delete(id); }
  set(id: string, events: Frame[], before: number | null): void {
    if (before === null) this.windows.delete(id);
    else this.windows.set(id, { events, before });
  }
  append(id: string, frames: Frame[]): void {
    const window = this.windows.get(id);
    if (!window) return;
    const after = window.events.at(-1)?.seq ?? 0;
    window.events.push(...frames.filter((frame) => frame.seq > after));
  }
}
