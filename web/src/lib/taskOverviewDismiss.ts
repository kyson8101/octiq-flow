import { recall, remember } from "./remember";

const KEY = "octiq.v2.dismissedTaskOverviews";
const MAX_DISMISSED = 80;

function read(): Map<string, string> {
  const result = new Map<string, string>();
  const raw = recall(KEY);
  if (!raw) return result;
  try {
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows)) return result;
    for (const row of rows) {
      if (Array.isArray(row) && typeof row[0] === "string" && typeof row[1] === "string") {
        result.set(row[0], row[1]);
      }
    }
  } catch {
    // A damaged preference should only make the overview visible again.
  }
  return result;
}

/** Hide one conversation's current task overview without hiding later tasks. */
export function dismissTaskOverview(chatId: string, turnId: string): void {
  const dismissed = read();
  dismissed.delete(chatId);
  dismissed.set(chatId, turnId);
  while (dismissed.size > MAX_DISMISSED) {
    const oldest = dismissed.keys().next();
    if (oldest.done) break;
    dismissed.delete(oldest.value);
  }
  remember(KEY, JSON.stringify([...dismissed]));
}

/** The last task overview dismissed in this conversation, if any. */
export function dismissedTaskOverviewTurn(chatId: string): string | undefined {
  return read().get(chatId);
}
