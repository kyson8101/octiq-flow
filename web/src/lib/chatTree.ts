import type { Conversation } from "./store";

export type ChatNode = {
  chat: Conversation;
  children: ChatNode[];
  descendants: Conversation[];
};

/** Preserve the caller's pin/activity order, moving a whole group together
 * when one of its members is pinned or receives new activity. */
export function buildChatTree(
  conversations: Conversation[],
  parents: ReadonlyMap<string, string>,
): ChatNode[] {
  const nodes = new Map(conversations.map((chat, rank) => [chat.id, {
    chat, children: [] as ChatNode[], descendants: [] as Conversation[], rank,
  }]));
  const links = new Map<string, string>();
  for (const chat of conversations) {
    const parent = parents.get(chat.id);
    if (!parent || parent === chat.id || !nodes.has(parent)) continue;
    // A stale or malformed relationship must never hide chats in a cycle.
    let ancestor: string | undefined = parent;
    while (ancestor && ancestor !== chat.id) ancestor = links.get(ancestor);
    if (!ancestor) links.set(chat.id, parent);
  }

  const roots: ChatNode[] = [];
  for (const node of nodes.values()) {
    const parent = links.get(node.chat.id);
    if (parent) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  const rank = (node: ChatNode): number => nodes.get(node.chat.id)!.rank;
  const visit = (node: ChatNode): void => {
    node.children.forEach(visit);
    node.children.sort((a, b) => rank(a) - rank(b));
    node.descendants = node.children.flatMap((child) => [child.chat, ...child.descendants]);
    for (const child of node.children) {
      nodes.get(node.chat.id)!.rank = Math.min(rank(node), rank(child));
    }
  };
  roots.forEach(visit);
  return roots.sort((a, b) => rank(a) - rank(b));
}
