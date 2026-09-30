// A provider's own safety review has already refused this action: Codex's
// tool router, or Claude's auto-mode classifier. Unlike a live Claude
// permission ask, there is no suspended tool call for OctiqFlow to resume.
// These buttons therefore send the user's decision as a fresh, explicit turn.
// Claude's card for a JUDGED refusal offers no "allow": Claude refuses without
// asking anyone and has no way to approve one refused call before it runs, so
// the card records the refusal and says so. Its outage card (the classifier
// gave no verdict) is different: it offers the one as-is retry Claude itself
// allows, and an allow rule the person adds to their own settings.
import { useState } from "react";
import { bridge } from "../lib/bridge";

export type SafetyBlockNotice = {
  id: string;
  chatKey?: string;
  /** "outage": Claude's classifier gave no verdict, so nothing was judged. */
  kind: "external-data" | "high-risk-action" | "outage";
  title: string;
  summary: string;
  detail: string;
  /** Whose review refused. Older servers send none: that was always Codex. */
  provider?: "codex" | "claude";
  /** The exact call that was refused, when the provider named it. */
  action?: string | null;
  /** An outage card: how many refused calls it groups. */
  count?: number;
  /** An outage card: each refused line once, with how often it was refused,
   * the tool, and the narrowest allow rule the host derived for it (none when
   * no rule is narrow enough: then only a retry is offered). */
  commands?: OutageCommand[];
  /** An outage card: the host's recovery text, the same words the worker
   * and the coordinator's snapshot are given. */
  guidance?: string | null;
  /** An outage card: the settings files "Always allow" writes. Absent when
   * the chat reads no settings file, or on an older server. A file the host
   * would refuse to write is absent too, and so is its button. */
  allow?: { project?: string; user?: string } | null;
  /** An outage card: the scope an "Always allow" already wrote while its
   * retry turn is not yet queued. The card stays up until it is. */
  written?: AllowScope | null;
};

export type OutageCommand = {
  action: string;
  count: number;
  tool?: string;
  /** For Bash, the leading command words the rule covers ("git push"). */
  words?: string;
  /** e.g. "Bash(git push:*)" or an exact "mcp__server__tool". */
  rule?: string;
};

/** What the host wrote for "Always allow" (`safety_block_allow_rule`). */
export type AllowedOutage = {
  rules: string[];
  path: string;
  added: string[];
  present: string[];
  uncovered: string[];
};

export type AllowScope = "project" | "user";

/** Said only when a server sends an outage card without its guidance. */
export const OUTAGE_FALLBACK_NOTE =
  "The command did not run and was not approved. OctiqFlow will not re-run it.";

const quoted = (actions: string[]) => actions.map((action) => `\`${action}\``).join("\n");

/**
 * The turn "Retry once" sends: the one as-is retry Claude's own outage
 * message allows. The agent makes the call again; Claude checks it again.
 */
export function outageRetryReply(actions: string[]): string {
  const one = actions.length === 1;
  return (
    `Claude's safety check was unavailable, so ${one ? "this call was" : "these calls were"} refused without being judged. ` +
    `Retry ${one ? "it" : "each of them"} once, exactly as before:\n${quoted(actions)}\n` +
    "Do not reword or work around it. If it is refused again, do not try a third time: say so and carry on with your other steps."
  );
}

/** The turn after "Always allow": what was written, then the same retry. */
export function outageAllowedReply(allowed: AllowedOutage, actions: string[]): string {
  const rules = allowed.rules.map((rule) => `\`${rule}\``).join(", ");
  const uncovered = allowed.uncovered.length
    ? ` No rule covers ${quoted(allowed.uncovered).replace(/\n/g, ", ")}; Claude's safety check decides that one again.`
    : "";
  return (
    `I added the Claude permission allow ${allowed.rules.length === 1 ? "rule" : "rules"} ${rules} to ${allowed.path}.` +
    uncovered + "\n\n" + outageRetryReply(actions)
  );
}

/** The distinct rules a card's calls derive, in the order they were refused. */
export function outageRules(commands: OutageCommand[]): string[] {
  return [...new Set(commands.flatMap((command) => (command.rule ? [command.rule] : [])))];
}

export type OutageChoice = "retry" | AllowScope | "dismiss";

/** What a page's send answers: `false` when the chat did not take the turn.
 * Anything else (a send that answers nothing) counts as taken. */
export type Continue = (message: string) => Promise<boolean | void> | boolean | void;

/** Said when the retry turn could not be queued; the card stays up. */
export const RETRY_NOT_SENT = "The retry could not be sent to the agent, so this card stays open. Try again.";

/**
 * One click on an outage card. Dismiss only takes the card down. Retry
 * sends the retry turn. An allow first asks the host to write the rule it
 * derives — the page names only the card and the scope, never a rule or a
 * path — and sends the retry turn only once that write has succeeded; a
 * refused write leaves the card up and sends nothing.
 *
 * The card comes down (`safety_block_retry`, then `onAnswered`) only AFTER
 * the chat has taken the retry turn. A send that fails leaves the card up,
 * undecided, to be answered again: an allow already written is then only
 * `present`, never added twice, and the host records the card as that allow
 * once the retry does go.
 */
export async function answerOutage(
  choice: OutageChoice,
  block: SafetyBlockNotice,
  io: {
    invoke: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
    onAnswered: (id: string) => void;
    onContinue: Continue;
  },
): Promise<void> {
  const actions = (block.commands?.length ? block.commands : block.action ? [{ action: block.action }] : [])
    .map((command) => command.action);
  if (choice === "dismiss") {
    await io.invoke("safety_block_dismiss", { id: block.id });
    io.onAnswered(block.id);
    return;
  }
  const message = choice === "retry"
    ? outageRetryReply(actions)
    : outageAllowedReply(
      await io.invoke<AllowedOutage>("safety_block_allow_rule", { id: block.id, scope: choice }),
      actions,
    );
  const taken = await io.onContinue(message);
  if (taken === false) throw new Error(RETRY_NOT_SENT);
  // The turn is queued. Closing the card is bookkeeping from here: if the
  // host cannot be told (another tab already closed it, or the socket
  // dropped), the card still goes from this page rather than offer a second
  // retry of a call that is already being retried.
  await io.invoke("safety_block_retry", { id: block.id }).catch(() => undefined);
  io.onAnswered(block.id);
}

/**
 * Claude's classifier could not be reached, so a call was refused without
 * being judged. Nothing here says the command was unsafe. The person can ask
 * for the one as-is retry Claude allows, or add the narrowest allow rule —
 * which Claude's auto mode honours without asking its classifier — to this
 * project's own settings or their own, and then ask for that retry. Nothing
 * is written without a click, and OctiqFlow never runs the call itself.
 */
function OutageBlock({
  block,
  onContinue,
  onAnswered,
  startOpen,
}: {
  block: SafetyBlockNotice;
  onContinue: Continue;
  onAnswered: (id: string) => void;
  startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [sending, setSending] = useState<"retry" | AllowScope | "dismiss" | null>(null);
  const [error, setError] = useState("");
  const commands: OutageCommand[] = block.commands?.length
    ? block.commands
    : block.action ? [{ action: block.action, count: 1 }] : [];
  const count = block.count ?? Math.max(1, commands.reduce((sum, c) => sum + c.count, 0));
  const actions = commands.map((command) => command.action);
  const rules = outageRules(commands);
  const ruleText = rules.join(", ");
  const projectPath = rules.length ? block.allow?.project : undefined;
  const userPath = rules.length ? block.allow?.user : undefined;

  const answer = async (choice: OutageChoice) => {
    setSending(choice);
    setError("");
    try {
      await answerOutage(choice, block, { invoke: bridge.invoke.bind(bridge), onAnswered, onContinue });
    } catch (why) {
      setError(String((why as Error)?.message ?? why));
      setSending(null);
    }
  };

  return (
    <div className="ask-card safety-card is-outage" role="status" aria-label={block.title}>
      <div className="safety-card-context">
        <span>Claude safety check</span>
        <span className="safety-card-ok">OctiqFlow is okay</span>
      </div>
      <div className="ask-card-head">
        <span className="safety-card-icon" aria-hidden="true">i</span>
        <span className="ask-card-title"><strong>{block.title}</strong></span>
        {count > 1 && <span className="safety-card-count">{count} refused</span>}
      </div>

      <p className="safety-card-summary">
        Claude could not reach its safety check, so it did not run {count === 1 ? "this command" : "these commands"}.
        Nothing was judged unsafe.
      </p>
      {commands.length > 0 && <>
        <div className="safety-card-label">What it tried</div>
        <ul className="safety-card-commands">
          {commands.map((command) => (
            <li key={command.action}>
              <pre className="safety-card-action">{command.action}</pre>
              {command.count > 1 && <span className="safety-card-times" aria-label={`${command.count} times`}>×{command.count}</span>}
            </li>
          ))}
        </ul>
      </>}
      <p className="safety-card-status">
        {/* The refused calls, not the command text: one as-is retry is allowed,
            so the same line may still run later. */}
        {count === 1 ? "This refused call did not run." : "These refused calls did not run."} Nothing was approved.
      </p>
      {block.written && (
        <p className="ask-card-note safety-card-written">
          The allow rule is already in {block.written === "project" ? "this project's" : "your own"} settings,
          but the retry was not sent yet.
        </p>
      )}

      {open && (
        <div className="ask-card-detail safety-card-detail">
          <div className="ask-card-label">Technical details</div>
          <pre className="ask-card-body">{block.summary}{"\n\n"}{block.detail}</pre>
          {(projectPath || userPath) && <>
            <div className="ask-card-label">Where Always allow writes</div>
            <pre className="ask-card-body">
              {projectPath && `This project: ${projectPath}`}
              {projectPath && userPath && "\n"}
              {userPath && `Everywhere: ${userPath}`}
            </pre>
          </>}
        </div>
      )}

      <div className="ask-card-buttons safety-card-buttons">
        <button className="ask-btn is-primary" type="button" disabled={!!sending || !actions.length}
          title="Ask the agent to make the same call once more. Claude checks it again."
          onClick={() => void answer("retry")}>
          {sending === "retry" ? "Retrying…" : "Retry once"}
        </button>
        {projectPath && (
          <button className="ask-btn safety-allow" type="button" disabled={!!sending}
            title={`Adds ${ruleText} to ${projectPath}, then retries. In a task worktree the rule goes when the worktree does.`}
            onClick={() => void answer("project")}>
            {sending === "project" ? "Saving…" : "Always allow in this project"}
          </button>
        )}
        {userPath && (
          <button className="ask-btn safety-allow" type="button" disabled={!!sending}
            title={`Adds ${ruleText} to ${userPath}, then retries`}
            onClick={() => void answer("user")}>
            {sending === "user" ? "Saving…" : "Always allow everywhere"}
          </button>
        )}
        <button className="ask-btn" type="button" disabled={!!sending} aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}>
          {open ? "Hide technical details" : "Technical details"}
        </button>
        <button className="ask-btn" type="button" disabled={!!sending} onClick={() => void answer("dismiss")}>
          {sending === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
      </div>

      {(projectPath || userPath) && (
        <p className="ask-card-note safety-card-rule">
          Always allow adds <code>{ruleText}</code> to Claude's settings, so Claude runs matching calls without its safety check.
        </p>
      )}

      {error && <p className="ask-card-note safety-card-error">Could not answer the card: {error}</p>}

      {block.guidance
        ? <>
          <div className="safety-card-label">What the agent was told</div>
          <p className="ask-card-note safety-card-guidance">{block.guidance}</p>
        </>
        : <p className="ask-card-note">{OUTAGE_FALLBACK_NOTE}</p>}
    </div>
  );
}

/**
 * Why a Claude refusal has no "allow" here. Claude refuses without asking
 * anyone and offers no way to approve one call before it runs; a permission
 * rule would allow every later call of the line, so OctiqFlow adds none.
 */
export const CLAUDE_REFUSAL_NOTE =
  "OctiqFlow cannot allow a command Claude's auto mode refused, and will not retry it. " +
  "If it should run, run it yourself, or change Claude's permissions outside OctiqFlow if you mean to allow it for good.";

/**
 * The one supported way to approve an exact command yourself (feedback
 * d59f830a): a NEW task whose commands wait for you. It is chosen on the plan
 * card before approving, and never reruns the refused call by itself.
 */
export const CLAUDE_MANUAL_ROUTE_NOTE =
  "To approve a command like this yourself, ask the main agent for a new task and choose Manual command approval " +
  "on its plan card before you approve the plan. That task asks you before each command runs. " +
  "This refused command does not run again unless you approve it there.";

export const LOCAL_ONLY_REPLY =
  "Continue without sending any local data to an external service. Use only local tools and local reasoning for this task.";
export const SAFER_APPROACH_REPLY =
  "Continue with a materially safer alternative. Do not retry, work around, or bypass the blocked action.";

export function saferReply(block: SafetyBlockNotice): string {
  return block.kind === "external-data" ? LOCAL_ONLY_REPLY : SAFER_APPROACH_REPLY;
}

export function allowOnceReply(block: SafetyBlockNotice): string {
  const boundary = block.kind === "external-data"
    ? "with the same content and destination only"
    : "with the same files, scope, and intended effect only";
  return (
    "I explicitly authorize one retry of the exact action that was just blocked. " +
    `The blocked action was described as: ${block.summary} ` +
    `This authorization applies to that single retry, ${boundary}. ` +
    "Do not broaden it, and ask again before any later high-risk action."
  );
}

/**
 * Codex's safety reviewer reads the conversation when it evaluates a later
 * call. A plain "always allow" is too broad to be useful there, so keep the
 * grant attached to the action class and destination the reviewer described,
 * and persist it only for the project where the person made the choice.
 */
export function allowForProjectReply(block: SafetyBlockNotice): string {
  const boundary = block.kind === "external-data"
    ? "the same kind of data, purpose, and external destination"
    : "the same kind of action, files or resources, scope, and intended effect";
  return (
    "I explicitly authorize one retry of the exact action that was just blocked, " +
    "and future actions matching it in this OctiqFlow project, including new chats and sessions. " +
    `The blocked action was described as: ${block.summary} ` +
    `This continuing authorization is limited to ${boundary}. ` +
    "It does not authorize a different destination, broader scope, or materially different action. " +
    "Do not ask again for a matching action. Ask again only if any of those boundaries change."
  );
}

/** Claude's auto-mode card: what was refused, and that nothing here can allow it. */
function ClaudeSafetyBlock({
  block,
  onContinue,
  onAnswered,
  startOpen,
}: {
  block: SafetyBlockNotice;
  onContinue: Continue;
  onAnswered: (id: string) => void;
  startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [sending, setSending] = useState<"safer" | "dismiss" | null>(null);
  const [error, setError] = useState("");

  // "Dismiss" only takes the card down: for when the person has dealt with
  // the command themselves and the agent needs no new instruction.
  const answer = async (choice: "safer" | "dismiss") => {
    setSending(choice);
    setError("");
    try {
      await bridge.invoke("safety_block_dismiss", { id: block.id });
      onAnswered(block.id);
      if (choice === "safer") await onContinue(SAFER_APPROACH_REPLY);
    } catch (why) {
      setError(String((why as Error)?.message ?? why));
      setSending(null);
    }
  };

  return (
    <div className="ask-card safety-card" role="alert" aria-label={block.title}>
      <div className="safety-card-context">
        <span>Claude auto-mode review</span>
        <span className="safety-card-ok">OctiqFlow is okay</span>
      </div>
      <div className="ask-card-head">
        <span className="safety-card-icon" aria-hidden="true">!</span>
        <span className="ask-card-title"><strong>{block.title}</strong></span>
      </div>

      <div className="safety-card-label">Why it was blocked</div>
      <p className="safety-card-summary">{block.summary}</p>
      {block.action && <>
        <div className="safety-card-label">What it tried</div>
        <pre className="safety-card-action">{block.action}</pre>
      </>}
      <p className="safety-card-status">OctiqFlow is still running. The blocked action did not run.</p>

      {open && (
        <div className="ask-card-detail safety-card-detail">
          <div className="ask-card-label">Technical details</div>
          <pre className="ask-card-body">{block.detail}</pre>
        </div>
      )}

      <div className="ask-card-buttons safety-card-buttons">
        <button className="ask-btn is-primary" type="button" disabled={!!sending} onClick={() => void answer("safer")}>
          {sending === "safer" ? "Continuing…" : "Use safer approach"}
        </button>
        <button className="ask-btn" type="button" disabled={!!sending} aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}>
          {open ? "Hide technical details" : "Technical details"}
        </button>
        <button className="ask-btn" type="button" disabled={!!sending} onClick={() => void answer("dismiss")}>
          {sending === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
      </div>

      {error && <p className="ask-card-note safety-card-error">Could not answer the card: {error}</p>}

      <p className="ask-card-note">{CLAUDE_REFUSAL_NOTE}</p>
      <p className="ask-card-note safety-card-route">{CLAUDE_MANUAL_ROUTE_NOTE}</p>
    </div>
  );
}

export function SafetyBlock({
  block,
  onContinue,
  onAnswered,
  startOpen = false,
}: {
  block: SafetyBlockNotice;
  onContinue: Continue;
  onAnswered: (id: string) => void;
  startOpen?: boolean;
}) {
  if (block.provider === "claude" && block.kind === "outage") {
    return <OutageBlock block={block} onContinue={onContinue} onAnswered={onAnswered} startOpen={startOpen} />;
  }
  if (block.provider === "claude") {
    return <ClaudeSafetyBlock block={block} onContinue={onContinue} onAnswered={onAnswered} startOpen={startOpen} />;
  }
  return <CodexSafetyBlock block={block} onContinue={onContinue} onAnswered={onAnswered} startOpen={startOpen} />;
}

function CodexSafetyBlock({
  block,
  onContinue,
  onAnswered,
  startOpen,
}: {
  block: SafetyBlockNotice;
  onContinue: Continue;
  onAnswered: (id: string) => void;
  startOpen: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const [sending, setSending] = useState<"local" | "allow" | "always" | null>(null);
  const [error, setError] = useState("");

  const choose = async (choice: "local" | "allow" | "always") => {
    setSending(choice);
    setError("");
    try {
      // The rejected command is already dead. A one-time choice removes its
      // card; the project choice first saves the exact boundary for future
      // Codex processes, then removes the card atomically on the backend.
      if (choice === "always") {
        await bridge.invoke("safety_block_authorize_project", { id: block.id });
      } else {
        await bridge.invoke("safety_block_dismiss", { id: block.id });
      }
      onAnswered(block.id);
      const message = choice === "local"
        ? saferReply(block)
        : choice === "always"
          ? allowForProjectReply(block)
          : allowOnceReply(block);
      await onContinue(message);
    } catch (why) {
      setError(String((why as Error)?.message ?? why));
      setSending(null);
    }
  };

  const external = block.kind === "external-data";

  return (
    <div className="ask-card safety-card" role="alert" aria-label={block.title}>
      <div className="safety-card-context">
        <span>Codex safety review</span>
        <span className="safety-card-ok">OctiqFlow is okay</span>
      </div>
      <div className="ask-card-head">
        <span className="safety-card-icon" aria-hidden="true">
          !
        </span>
        <span className="ask-card-title">
          <strong>{block.title}</strong>
        </span>
      </div>

      <div className="safety-card-label">Why it was blocked</div>
      <p className="safety-card-summary">{block.summary}</p>
      <p className="safety-card-status">
        {external
          ? "OctiqFlow is still running. The command did not run, and no data was sent."
          : "OctiqFlow is still running. The blocked action made no changes."}
      </p>

      {open && (
        <div className="ask-card-detail safety-card-detail">
          <div className="ask-card-label">Technical details</div>
          <pre className="ask-card-body">{block.detail}</pre>
        </div>
      )}

      <div className="ask-card-buttons safety-card-buttons">
        <button
          className="ask-btn is-primary"
          type="button"
          disabled={!!sending}
          onClick={() => void choose("local")}
        >
          {sending === "local" ? "Continuing…" : external ? "Keep it local" : "Use safer approach"}
        </button>
        <button
          className="ask-btn"
          type="button"
          disabled={!!sending}
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
        >
          {open ? "Hide technical details" : "Technical details"}
        </button>
        <button
          className="ask-btn safety-allow"
          type="button"
          disabled={!!sending}
          title="Remember this exact authorization for future chats and sessions in this project"
          onClick={() => void choose("always")}
        >
          {sending === "always" ? "Saving…" : "Always allow in this project"}
        </button>
        <button
          className="ask-btn safety-allow"
          type="button"
          disabled={!!sending}
          onClick={() => void choose("allow")}
        >
          {sending === "allow" ? "Authorizing…" : "Allow once"}
        </button>
      </div>

      {error && <p className="ask-card-note safety-card-error">Could not save authorization: {error}</p>}

      <p className="ask-card-note">
        “Always allow in this project” also applies to new chats and sessions in this project, only
        within the same stated boundaries. The rejected action cannot resume by itself, so either
        approval starts a new turn.
      </p>
    </div>
  );
}
