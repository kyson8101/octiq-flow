import type { Frame } from "./catchUp";

export type ChatPage = { events: Frame[]; context: Frame[]; before: number | null };
type Window = { before: number };

/** Keep only the cursor of a partial transcript. The server already holds its
 * raw events. Retaining every live delta here doubled long chats' memory and
 * kept growing even after switching away. An explicit earlier-page read asks
 * for the window again so cross-page tool results can still be replayed. */
export class ChatHistory {
  private windows = new Map<string, Window>();
  get(id: string): Window | undefined { return this.windows.get(id); }
  hasEarlier(id: string): boolean { return this.windows.has(id); }
  forget(id: string): void { this.windows.delete(id); }
  set(id: string, before: number | null): void {
    if (before === null) this.windows.delete(id);
    else this.windows.set(id, { before });
  }
}
