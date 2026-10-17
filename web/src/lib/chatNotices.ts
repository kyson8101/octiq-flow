import { interruptedJobs } from "./jobs";

export type PresentedNotice = {
  key: string;
  title: string;
  detail?: string;
  technical?: string;
  count: number;
};

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The longest a title is: one row above the composer, on a phone too. */
const TITLE_MAX = 60;
const chars = (text: string) => [...text].length;

/** Remove the tracing envelope while keeping the useful part of a provider log. */
function logMessage(text: string): string | null {
  const match = /^\d{4}-\d{2}-\d{2}T\S+\s+(?:ERROR|WARN|WARNING)\s+(.+)$/is.exec(text.trim());
  if (!match) return null;
  return squash(match[1]);
}

/** Turn provider diagnostics into short, human labels. The original text stays
 * available behind Technical details; this only decides what deserves space in
 * the chat by default. */
export function presentNotice(raw: string): Omit<PresentedNotice, "count"> {
  const text = squash(raw);

  if (/collab spawn failed:.*agent thread limit reached/i.test(text)) {
    return {
      key: "agent-thread-limit",
      title: "A background agent could not start",
      detail: "The agent thread limit was reached. The current chat can keep going.",
      technical: raw.trim(),
    };
  }

  if (/responses_websocket:.*failed to connect to websocket:.*504 Gateway Timeout/i.test(text)) {
    return {
      key: "codex-connection-timeout",
      title: "The Codex connection timed out",
      detail: "This was recorded in diagnostics. If the turn stops, send the message again.",
      technical: raw.trim(),
    };
  }

  const logged = logMessage(raw);
  if (logged) {
    const message = logged.replace(/^[\w.-]+(?:::[\w.-]+)*:\s*/, "");
    return {
      key: `provider:${message.toLocaleLowerCase()}`,
      title: "The agent reported a background issue",
      detail: message,
      technical: raw.trim(),
    };
  }

  // The host's sentence for work a turn left running when its process ended
  // (`background_tasks.rs`). Folded it is a count; the sentence, which names
  // the task ids and says what to check, is whole inside the opened panel.
  const interrupted = /^(\d+) background task\(s\) interrupted when the provider process ended: (.+?)\. Retained output/i.exec(text);
  if (interrupted) {
    const count = Number(interrupted[1]);
    return {
      key: `background-interrupted:${interrupted[2].toLocaleLowerCase()}`,
      title: `${count} background ${count === 1 ? "task" : "tasks"} interrupted`,
      detail: text,
    };
  }

  // The host's sentence for jobs a server restart interrupted
  // (`octiq_job_interrupted`). Folded it is a count, like the background
  // tasks above; the sentence with the jobs' names is inside the panel.
  const jobs = interruptedJobs(text);
  if (jobs) {
    return {
      key: `jobs-interrupted:${jobs.labels.toLocaleLowerCase()}`,
      title: `${jobs.count} ${jobs.count === 1 ? "job" : "jobs"} interrupted`,
      detail: text,
    };
  }

  const key = `message:${text.toLocaleLowerCase()}`;
  // A sentence short enough for one row is its own title.
  if (chars(text) <= TITLE_MAX) return { key, title: text };
  // A longer one that leads with what went wrong ("Could not switch models:
  // …") is titled by that; anything else by what it is. Never by a slice of
  // it: the first sixty characters of a sentence are not what it says.
  const lead = /^([^:]+): /.exec(text)?.[1] ?? "";
  return {
    key,
    title: lead && chars(lead) <= TITLE_MAX ? lead : "Notice",
    detail: text,
  };
}

/** What the folded row says: the one notice's short title, or how many
 *  there are. Everything else is inside the opened panel. */
export function noticesHeadline(groups: readonly PresentedNotice[], total: number): string {
  if (total <= 0 || groups.length === 0) return "";
  return total === 1 ? groups[0].title : `${total} notices`;
}

/** Group repeated diagnostics even when their timestamps differ. */
export function presentNotices(notices: string[]): PresentedNotice[] {
  const grouped = new Map<string, PresentedNotice>();
  for (const raw of notices) {
    const presented = presentNotice(raw);
    const existing = grouped.get(presented.key);
    if (existing) {
      grouped.set(presented.key, {
        ...existing,
        detail: presented.detail ?? existing.detail,
        technical: presented.technical ?? existing.technical,
        count: existing.count + 1,
      });
    } else {
      grouped.set(presented.key, { ...presented, count: 1 });
    }
  }
  return [...grouped.values()];
}
