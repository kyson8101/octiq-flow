// What the Search chats page shows for a query.
//
// The backend (`chat_search.rs`) searches every chat's transcript and answers
// with ids and an excerpt. It knows nothing of this browser: a chat deleted
// here a moment ago can still be in its index, so a hit only becomes a result
// once it names a chat this browser still lists.
import type { Conversation } from "./store";

export type ChatSearchHit = {
  id: string;
  excerpt: string;
  speaker: string;
  role: string;
};

export type ChatSearchResult = { chat: Conversation; hit: ChatSearchHit };

/** Queries shorter than this are not sent: the backend refuses them. Counted
 *  in characters, not UTF-16 units, the same way the backend counts. */
export const MIN_QUERY_CHARS = 2;

export function isSearchable(query: string): boolean {
  return [...query.trim()].length >= MIN_QUERY_CHARS;
}

/** The hits that name a chat still listed here, in the backend's rank order. */
export function chatSearchResults(
  hits: readonly ChatSearchHit[],
  chats: readonly Conversation[],
): ChatSearchResult[] {
  const byId = new Map(chats.map((chat) => [chat.id, chat]));
  const seen = new Set<string>();
  return hits.flatMap((hit) => {
    const chat = byId.get(hit.id);
    if (!chat || seen.has(hit.id)) return [];
    seen.add(hit.id);
    return [{ chat, hit }];
  });
}
