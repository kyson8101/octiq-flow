import type { IndexEntry } from "./chatIndex";
import type { Conversation } from "./store";

/** Everything a notification knows about where it should land. */
export type NotificationTarget = {
  conversationId: string;
  projectId: string | null;
};

/** Turn an index row into the light conversation shell opening a remote chat needs. */
function fromIndex(entry: IndexEntry): Conversation {
  return {
    id: entry.id,
    projectId: entry.projectId,
    title: entry.title,
    latestResponse: entry.latestResponse,
    customTitle: entry.customTitle,
    sessionId: entry.sessionId ?? undefined,
    cwd: entry.cwd ?? undefined,
    messages: [],
    modelId: entry.modelId ?? undefined,
    permission: entry.access ?? undefined,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    readAt: entry.readAt,
    pinned: entry.pinned,
    doneAt: entry.doneAt,
    generation: entry.generation,
    launch: entry.launch,
    synced: true,
  };
}

/** Find the chat a notification names.
 *
 * The rendered/sidebar list is a cache and may not contain a newly-created
 * coordinator or worker yet. Only a successful read of the server index may
 * decide that the chat is absent. The notice's project is a routing hint; the
 * index row wins if the chat has since been retargeted. */
export async function resolveNotificationConversation(
  target: NotificationTarget,
  local: readonly Conversation[],
  readIndex: () => Promise<readonly IndexEntry[]>,
): Promise<Conversation | null> {
  const loaded = local.find((conversation) => conversation.id === target.conversationId);
  if (loaded) return loaded;

  const indexed = (await readIndex()).find((entry) => entry.id === target.conversationId);
  return indexed ? fromIndex(indexed) : null;
}
