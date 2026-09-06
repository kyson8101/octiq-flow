export type PendingRequest = { id: string; chatKey?: string };
export type RequestState<T> = Record<string, T[]>;
type Edit<T> = { conversationId: string; item: T } | null;

export function requestConversation(item: { chatKey?: string }): string | null {
  return item.chatKey?.startsWith("chat:") ? item.chatKey.slice(5) || null : null;
}

function indexed<T extends PendingRequest>(state: RequestState<T>) {
  const items = new Map<string, NonNullable<Edit<T>>>();
  for (const [conversationId, list] of Object.entries(state)) {
    for (const item of list) items.set(item.id, { conversationId, item });
  }
  return items;
}

/** Reconcile one request category. A pending RPC snapshot may be older than
 * events or local answers received while awaiting it. Keep those edits until
 * that snapshot resolves, then discard the journal. No retained history. */
export class PendingRequests<T extends PendingRequest> {
  current: RequestState<T> = {};
  private generation = 0;
  private pending: number | null = null;
  private edits = new Map<string, Edit<T>>();

  begin(): number {
    this.pending = ++this.generation;
    this.edits.clear();
    return this.pending;
  }

  cancel(token: number): void {
    if (this.pending !== token) return;
    this.pending = null;
    this.edits.clear();
  }

  replace(update: RequestState<T> | ((previous: RequestState<T>) => RequestState<T>)): RequestState<T> {
    const next = typeof update === "function" ? update(this.current) : update;
    if (this.pending !== null) {
      const before = indexed(this.current);
      const after = indexed(next);
      for (const id of before.keys()) if (!after.has(id)) this.edits.set(id, null);
      for (const [id, value] of after) {
        const old = before.get(id);
        if (!old || old.item !== value.item || old.conversationId !== value.conversationId) this.edits.set(id, value);
      }
    }
    this.current = next;
    return next;
  }

  add(item: T): RequestState<T> {
    const conversationId = requestConversation(item);
    if (!conversationId || !item.id) return this.current;
    // Even a duplicate event is newer evidence than an in-flight snapshot.
    if (this.pending !== null) this.edits.set(item.id, { conversationId, item });
    const list = this.current[conversationId] ?? [];
    this.current = { ...this.current, [conversationId]: list.some((old) => old.id === item.id)
      ? list.map((old) => old.id === item.id ? item : old)
      : [...list, item] };
    return this.current;
  }

  remove(id: string): RequestState<T> {
    if (!id) return this.current;
    // An expiry can arrive before the snapshot has introduced its request.
    if (this.pending !== null) this.edits.set(id, null);
    this.current = Object.fromEntries(Object.entries(this.current).map(([key, list]) => [key, list.filter((item) => item.id !== id)]));
    return this.current;
  }

  finish(token: number, list: readonly T[] | null): RequestState<T> | null {
    if (this.pending !== token) return null;
    const items = new Map<string, NonNullable<Edit<T>>>();
    for (const item of list ?? []) {
      const conversationId = requestConversation(item);
      if (conversationId && item.id) items.set(item.id, { conversationId, item });
    }
    for (const [id, edit] of this.edits) {
      if (edit === null) items.delete(id);
      else items.set(id, edit);
    }
    const next: RequestState<T> = {};
    for (const { conversationId, item } of items.values()) (next[conversationId] ??= []).push(item);
    this.current = next;
    this.cancel(token);
    return next;
  }
}
