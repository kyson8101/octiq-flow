// Only small presentation choices, never transcript text, React nodes, drafts,
// or decision authority. A chat's reading state lives exactly as long as its
// retained window: App forgets it when it releases or invalidates the window,
// so no chat COUNT cap can drop the state of a window that is still held. The
// bounds below are per-chat and total safety limits against runaway growth,
// far above anything a real transcript produces (a disclosure is ~100 bytes).
export const READING_STATE_VALUES = 16384;
export const READING_STATE_BYTES = 4 * 1024 * 1024;
export const READING_STATES_TOTAL_BYTES = 128 * 1024 * 1024;
export type ReadingValue = boolean | string | null;

export class ChatReadingState {
  private values = new Map<string, ReadingValue>();
  private bytes = 0;
  private valid = true;
  first: string | null | undefined;

  get size(): number { return this.bytes; }
  get<T extends ReadingValue>(key: string): T | undefined { return this.values.get(key) as T | undefined; }
  set(key: string, value: ReadingValue): void {
    if (!this.valid || key.length > 1024 || (typeof value === "string" && value.length > 1024)) return;
    const size = (key.length + String(value).length) * 2 + 64;
    const previous = this.values.get(key);
    if (this.values.has(key)) this.bytes -= (key.length + String(previous).length) * 2 + 64;
    this.values.delete(key);
    this.values.set(key, value); this.bytes += size;
    while (this.values.size > READING_STATE_VALUES || this.bytes > READING_STATE_BYTES) {
      const [old, held] = this.values.entries().next().value!;
      this.values.delete(old); this.bytes -= (old.length + String(held).length) * 2 + 64;
    }
  }
  forget(): void { this.valid = false; this.values.clear(); this.bytes = 0; this.first = undefined; }
}

export class ChatReadingStates {
  private chats = new Map<string, ChatReadingState>();
  open(id: string): ChatReadingState {
    const state = this.chats.get(id) ?? new ChatReadingState();
    this.chats.delete(id); this.chats.set(id, state);
    // Safety only: past the total, the least recently opened chat's choices go
    // first, never the one being opened now.
    let total = 0;
    for (const held of this.chats.values()) total += held.size;
    for (const old of this.chats.keys()) {
      if (total <= READING_STATES_TOTAL_BYTES || old === id) break;
      total -= this.chats.get(old)!.size; this.forget(old);
    }
    return state;
  }
  forget(id: string): void { this.chats.get(id)?.forget(); this.chats.delete(id); }
}

// Page memory only. App releases this alongside the corresponding reducer
// window, including record reset/deletion; no lib/remember storage is added.
export const chatReadingStates = new ChatReadingStates();
