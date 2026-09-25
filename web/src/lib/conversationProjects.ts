import type { OrchestrationSnapshot, TaskDestination } from "./orchestration";
import type { Conversation } from "./store";

export type ConversationProjectInfo = {
  status: "projects" | "discussion" | "unknown" | "loading" | "home";
  destinations: TaskDestination[];
  taskCount: number;
  unknownTaskCount: number;
  homeProjectId?: string;
};

/** Plain-language project context for row labels and non-visual consumers. */
export function conversationProjectSummary(
  info: ConversationProjectInfo,
  projectName: (projectId: string, fallback?: string) => string,
): string {
  if (info.status === "loading") return "work projects loading";
  if (info.status === "discussion") return "discussion, no tasks yet";
  if (info.status === "unknown") return "work project unknown";
  if (info.status === "home") return projectName(info.homeProjectId ?? "", "Unknown project");
  const names = info.destinations.map((destination) => projectName(destination.projectId, destination.projectName));
  const unknown = info.unknownTaskCount
    ? `, ${info.unknownTaskCount} ${info.unknownTaskCount === 1 ? "task has" : "tasks have"} no confirmed project`
    : "";
  return `${names.join(", ")}${unknown}, ${info.taskCount} ${info.taskCount === 1 ? "task" : "tasks"}`;
}

/**
 * The projects a conversation is actually doing work in.
 *
 * A coordinator chat may live in General, but that is its conversation home,
 * not a work destination. Its projects therefore come only from task
 * destinations in the orchestration ledger, across every run (settled runs
 * included). A normal chat continues to belong to its indexed project.
 */
export function conversationProjectInfo(
  chat: Pick<Conversation, "id" | "projectId">,
  snapshot: OrchestrationSnapshot | null,
  coordinatorChatKeys: ReadonlySet<string> | null,
  ledgerUnavailable = false,
): ConversationProjectInfo {
  const chatKey = `chat:${chat.id}`;
  if (!snapshot) {
    // Once the lead records are known, ordinary chats can keep their indexed
    // project while the much larger orchestration ledger catches up. Before
    // that, do not briefly present General as a work destination for a CTO
    // conversation merely because it is the chat's stored home.
    if (coordinatorChatKeys && !coordinatorChatKeys.has(chatKey)) {
      return {
        status: "home",
        destinations: [],
        taskCount: 0,
        unknownTaskCount: 0,
        homeProjectId: chat.projectId,
      };
    }
    return {
      status: ledgerUnavailable ? "unknown" : "loading",
      destinations: [],
      taskCount: 0,
      unknownTaskCount: 0,
    };
  }

  const runs = snapshot.runs.filter((run) => run.coordinatorChatKey === chatKey);
  if (runs.length === 0 && coordinatorChatKeys === null) {
    return { status: ledgerUnavailable ? "unknown" : "loading", destinations: [], taskCount: 0, unknownTaskCount: 0 };
  }
  const coordinator = runs.length > 0 || !!coordinatorChatKeys?.has(chatKey);
  if (!coordinator) {
    return {
      status: "home",
      destinations: [],
      taskCount: 0,
      unknownTaskCount: 0,
      homeProjectId: chat.projectId,
    };
  }

  const runIds = new Set(runs.map((run) => run.id));
  const tasks = snapshot.tasks
    .filter((task) => runIds.has(task.runId))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  if (tasks.length === 0) {
    return { status: "discussion", destinations: [], taskCount: 0, unknownTaskCount: 0 };
  }

  const destinations = new Map<string, TaskDestination>();
  let unknownTaskCount = 0;
  for (const task of tasks) {
    if (!task.destination) {
      unknownTaskCount += 1;
      continue;
    }
    // Tasks are newest first, so the first record also preserves the newest
    // stored name/repository when a project was renamed or moved later.
    if (!destinations.has(task.destination.projectId)) {
      destinations.set(task.destination.projectId, task.destination);
    }
  }

  if (destinations.size === 0) {
    return { status: "unknown", destinations: [], taskCount: tasks.length, unknownTaskCount };
  }
  return {
    status: "projects",
    destinations: [...destinations.values()],
    taskCount: tasks.length,
    unknownTaskCount,
  };
}

/** The canonical chat objects discoverable through one project. */
export function projectConversations(
  chats: readonly Conversation[],
  projectId: string,
  snapshot: OrchestrationSnapshot | null,
  coordinatorChatKeys: ReadonlySet<string> | null,
): Conversation[] {
  return chats
    .filter((chat) => {
      const info = conversationProjectInfo(chat, snapshot, coordinatorChatKeys);
      if (info.status === "home") return info.homeProjectId === projectId;
      return info.destinations.some((destination) => destination.projectId === projectId);
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** How many canonical conversations each project can discover. */
export function projectConversationCounts(
  chats: readonly Conversation[],
  snapshot: OrchestrationSnapshot | null,
  coordinatorChatKeys: ReadonlySet<string> | null,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const chat of chats) {
    const info = conversationProjectInfo(chat, snapshot, coordinatorChatKeys);
    const projectIds = info.status === "home"
      ? (info.homeProjectId ? [info.homeProjectId] : [])
      : info.destinations.map((destination) => destination.projectId);
    for (const projectId of new Set(projectIds)) {
      counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
    }
  }
  return counts;
}
