// The jobs one tab holds (`lib/jobs`), kept in step with the host.
//
// Two sources and nothing else: `chat_jobs` read on every connect (every
// chat's running jobs and those that ended in the last ten minutes), and the
// `chat-job` event the host sends at a job's start, at most twice a second
// while it moves, and at its end. Nothing polls. An open chat may be read on
// its own as well (`readChatJobs`), once a connection, so its wake turns can
// name jobs that ended before the ten minutes.
//
// It lives outside any component, and so does what a surface subscribes to
// (`components/Background`'s `JobStore`): a job's progress must re-render the
// line that draws it and nothing else.
import { bridge } from "./bridge";
import { applyJobEvent, applyJobsRead, NO_JOBS, type JobsState } from "./jobs";

let state: JobsState = NO_JOBS;
let started = false;
const listeners = new Set<() => void>();
/** The chats read on their own on this connection. */
let readChats = new Set<string>();

function set(next: JobsState) {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

/** An older backend has no job store. That is no jobs, not an error. */
function lacksCommand(problem: unknown): boolean {
  return String((problem as { message?: unknown } | null)?.message ?? problem).includes("not available on this backend");
}

function read(chatKey?: string) {
  const asked = state.rev;
  bridge.invoke<{ jobs?: unknown }>("chat_jobs", chatKey ? { chatKey } : {}).then(
    (answer) => set(applyJobsRead(state, { jobs: answer?.jobs, asked, chatKey }, Date.now())),
    (problem) => {
      // Kept as it was: a failed read says nothing of what is running. The
      // next connect asks again.
      if (!lacksCommand(problem)) console.warn("chat_jobs failed", problem);
    },
  );
}

function start() {
  if (started) return;
  started = true;
  bridge.on("chat-job", (payload) => set(applyJobEvent(state, payload, Date.now())));
  bridge.onState((connection) => {
    if (connection !== "open") return;
    readChats = new Set();
    read();
  });
}

/** Read one chat's jobs, once a connection. */
export function readChatJobs(chatKey: string) {
  start();
  if (readChats.has(chatKey)) return;
  readChats.add(chatKey);
  read(chatKey);
}

export const jobFeed = {
  snapshot(): JobsState {
    start();
    return state;
  },
  subscribe(listener: () => void): () => void {
    start();
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
