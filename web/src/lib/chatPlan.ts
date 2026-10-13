// A chat's plan, as the host answers it (`chat_plan.rs`): the types of
// `chat_plan_get`, of the `chat-plan` event and of `chat_plan_start`'s
// answer. Types only. The fixtures in `__fixtures__/host/chat_plan_*.json`
// are what the host's own tests answered, and `hostFacts.ts` reads them as
// these.
//
// Three owners, and the page shows each as what it is:
//   - the agent wrote every item (title, status, decisions, questions, note,
//     tasks), through its `plan_update` tool. The page does not write a plan;
//   - the person starts it (`chat_plan_start`), once;
//   - the host counted `progress` and `linked` from the ledger for this
//     answer. They are never the agent's, and are absent, not zero, for an
//     item with no linked task or when the ledger could not be read.

/** Where an item stands, in the agent's own word. */
export type ChatPlanStatus = "discussing" | "decided" | "in_progress" | "done" | "dropped";

/** How one linked task stands in the ledger, as the run panel counts it. */
export type ChatPlanTaskState = "done" | "running" | "failed" | "waiting" | "closed";

/** A task an item is linked to that the ledger holds. */
export type ChatPlanLinkedTask = {
  id: string;
  runId: string;
  title: string;
  state: ChatPlanTaskState;
};

/** The host's count of an item's linked tasks. `total` is the tasks that
 *  count as work (`done + running + failed + waiting`); `closed` (cancelled,
 *  replaced, or unfinished in a run the person stopped or closed) and
 *  `unknown` (an id the ledger no longer holds) are counted nowhere else. */
export type ChatPlanProgress = {
  total: number;
  done: number;
  running: number;
  failed: number;
  waiting: number;
  closed: number;
  unknown: number;
};

export type ChatPlanItem = {
  /** The host's: `i1`, `i2`, … Never reused, and never removed. */
  id: string;
  title: string;
  status: ChatPlanStatus;
  decisions: string[];
  /** Questions still open. */
  questions: string[];
  note?: string;
  /** Task ids as the agent linked them, whether or not the ledger holds them. */
  tasks: string[];
  /** The plan revision this item was added in, and last changed in. */
  addedIn: number;
  changedIn: number;
  progress?: ChatPlanProgress;
  linked?: ChatPlanLinkedTask[];
};

/** The person's Start. */
export type ChatPlanStarted = {
  at: number;
  /** The revision the person pressed Start on. */
  revision: number;
  /** The host's turn that tells the agent (`octiq-plan-start-…`). */
  turnId: string;
  /** Whether that turn was handed to the agent (written or queued). While
   *  false, `chat_plan_start` may be asked again: nothing is recorded twice. */
  told: boolean;
};

/** What `chat_plan_get` answers and `chat-plan` carries as `plan`. */
export type ChatPlan = {
  chatId: string;
  /** Goes up on every change to the list. 0 is a chat with no plan. */
  revision: number;
  items: ChatPlanItem[];
  /** Absent for a chat with no plan. */
  updatedAt?: number;
  /** The chat's registered agent by name, else `agent`. */
  updatedBy?: string;
  started?: ChatPlanStarted;
  /** Derived: not started, and at least one item is not dropped. Start can
   *  be pressed, and the chat's agent is refused the commands that start
   *  orchestrated work. */
  awaitsStart: boolean;
};

/** The `chat-plan` event. */
export type ChatPlanEvent = { chatId: string; plan: ChatPlan };

/** What `chat_plan_start` answers. An error instead means nothing was
 *  recorded. `delivered: false` means the Start IS recorded and the turn
 *  that tells the agent could not be handed over (`notDelivered` says why):
 *  ask again with the same command. */
export type ChatPlanStartAnswer = {
  plan: ChatPlan;
  turnId: string;
} & (
  | { delivered: true; state: "started" | "queued" | "told" }
  | { delivered: false; notDelivered: string }
);
