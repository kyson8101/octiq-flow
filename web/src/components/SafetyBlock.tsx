// A provider's own safety review has already refused this action: Codex's
// tool router, or Claude's auto-mode classifier. Unlike a live Claude
// permission ask, there is no suspended tool call for OctiqFlow to resume.
// These buttons therefore send the user's decision as a fresh, explicit turn.
// Claude's card for a JUDGED refusal cannot approve the refused call: Claude
// refuses without asking anyone and has no way to approve one call before it
// runs. What it can offer, for a shell line, is the lasting kind — exact
// allow rules the person writes to Claude's settings, which skip Claude's
// safety check for matching commands from then on — and then it tells the
// agent the rule exists, so the agent retries itself. Its outage card (the
// classifier gave no verdict) offers the one as-is retry Claude itself allows,
// and an allow rule the person adds to their own settings.
import { useId, useState } from "react";
import { bridge } from "../lib/bridge";
import { CopyBit, CopyIcon } from "./CopyBit";

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
  /** A Claude card: the settings files "Always allow" writes. Absent when
   * the chat reads no settings file, or on an older server. A file the host
   * would refuse to write is absent too, and so is its button. */
  allow?: { project?: string; user?: string } | null;
  /** A Claude card: the scope an "Always allow" already wrote while the turn
   * that answers it is not yet queued. The card stays up until it is. */
  written?: AllowScope | null;
  /** A judged Claude refusal: the exact rules "Always allow" writes, one per
   * part of the refused line the host found safe to name. Absent: no allow. */
  rules?: string[];
  /** A judged Claude refusal: the parts of the line no rule names. */
  uncovered?: string[];
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
 * Anything else (a send that answers nothing) counts as taken.
 * `safetyBlock` names the outage card the turn is the retry for; the send
 * carries it, and the host closes that card only once the turn is taken. */
export type Continue = (
  message: string,
  options?: { safetyBlock?: string },
) => Promise<boolean | void> | boolean | void;

/** Said when the retry turn could not be queued; the card stays up. */
export const RETRY_NOT_SENT = "The retry could not be sent to the agent, so this card stays open. Try again.";

/**
 * One click on an outage card. Dismiss only takes the card down. Retry
 * sends the retry turn. An allow first asks the host to write the rule it
 * derives — the page names only the card and the scope, never a rule or a
 * path — and sends the retry turn only once that write has succeeded; a
 * refused write leaves the card up and sends nothing.
 *
 * The retry turn names its card (`safetyBlock`), and the host closes the
 * card — recorded as retried or as the allow it wrote — in the same call
 * that takes the turn, never before. A send that fails, here or on the
 * host, leaves the card up and undecided, to be answered again: an allow
 * already written is then only `present`, never added twice.
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
  const taken = await io.onContinue(message, { safetyBlock: block.id });
  if (taken === false) throw new Error(RETRY_NOT_SENT);
  // Taken, and the host has closed the card with it.
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
 * Why a Claude refusal is not approved here. Claude refuses without asking
 * anyone and offers no way to approve one call before it runs; a permission
 * rule allows every later call of the line too, so it is offered only as
 * what it is — a lasting rule — and only where the host can name it exactly.
 */
export const CLAUDE_REFUSAL_NOTE =
  "OctiqFlow cannot approve a call Claude's auto mode refused, and will not rerun it.";

/** The card's one-line answer to "did anything happen?". */
export const CLAUDE_BLOCKED_STATUS = "Nothing ran. OctiqFlow is still running.";

/** What "Always allow" on a judged card says it does, before the click. */
export const JUDGED_ALLOW_NOTE =
  "Always allow is permanent. It adds these exact rules to Claude's settings, and from now on Claude runs " +
  "exactly these commands without its safety check, in every chat that reads that file, until you remove the rules. " +
  "OctiqFlow does not run the command: the agent is told the rule exists and retries it itself.";

/** Said when the rule is written but the agent could not be told; the card stays up. */
export const ALLOW_NOT_SENT =
  "The rule is written, but the agent could not be told, so this card stays open. Try again: nothing is written twice.";

/**
 * The turn after "Always allow" on a judged card: which rules are now in
 * which file, that OctiqFlow ran nothing, and that the agent may run the
 * command again itself. No rule covers a reworded line, so it says not to.
 */
export function judgedAllowedReply(allowed: AllowedOutage, action: string | null | undefined): string {
  const listed = (rules: string[]) => rules.map((rule) => `\`${rule}\``).join(", ");
  const kind = (rules: string[]) => (rules.length === 1 ? "rule" : "rules");
  const were = (rules: string[]) => (rules.length === 1 ? "was" : "were");
  // A host that reports neither list is taken to have added them all.
  const reported = allowed.added.length > 0 || allowed.present.length > 0;
  const added = reported ? allowed.added : allowed.rules;
  const present = reported ? allowed.present : [];
  const wrote = added.length
    ? `I added the Claude permission allow ${kind(added)} ${listed(added)} to ${allowed.path}.` +
      (present.length ? ` ${listed(present)} ${were(present)} already there.` : "")
    : `The Claude permission allow ${kind(present)} ${listed(present)} ${were(present)} already in ${allowed.path}; nothing new was written.`;
  const uncovered = allowed.uncovered.length
    ? ` No rule covers ${allowed.uncovered.map((part) => `\`${part}\``).join(", ")}: ` +
      "Claude's safety check still judges a line that contains it, so it may be refused again."
    : "";
  return (
    `${wrote} ` +
    "From now on Claude runs matching commands without its safety check. OctiqFlow did not run the refused command." +
    uncovered + "\n\n" +
    (action ? `If you still need it, run it again exactly as before:\n\`${action}\`\n` : "If you still need it, run it again exactly as before. ") +
    "Do not reword it to fit the rule. If it is refused again, carry on another safe way and say so."
  );
}

/**
 * "Always allow" on a judged card. The host writes the rules it derived when
 * the refusal was seen — the page names only the card and the scope — and
 * only once that write succeeded is the agent told, in a turn that names the
 * card. The host closes the card as this allow when that turn is taken; a
 * send that fails leaves it up, and a second click finds the rule present.
 */
export async function answerJudged(
  scope: AllowScope,
  block: SafetyBlockNotice,
  io: {
    invoke: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
    onAnswered: (id: string) => void;
    onContinue: Continue;
    onWritten?: (allowed: AllowedOutage) => void;
  },
): Promise<void> {
  const allowed = await io.invoke<AllowedOutage>("safety_block_allow_rule", { id: block.id, scope });
  io.onWritten?.(allowed);
  const taken = await io.onContinue(judgedAllowedReply(allowed, block.action), { safetyBlock: block.id });
  if (taken === false) throw new Error(ALLOW_NOT_SENT);
  io.onAnswered(block.id);
}

/**
 * The one supported way to approve an exact command yourself (feedback
 * d59f830a): a NEW task whose commands wait for you. It is chosen on the plan
 * card before approving, and never reruns the refused call by itself.
 */
export const CLAUDE_MANUAL_ROUTE_NOTE =
  "Ask the main agent for a new task and choose Manual command approval on its plan card before you approve " +
  "the plan. That task asks you before each command, and this one does not run again unless you approve it there.";

/** "How to allow this", in the order the card lists it. */
export const CLAUDE_ALLOW_ROUTES = [
  "Run it yourself.",
  "Allow it for good with a Claude permission rule.",
  CLAUDE_MANUAL_ROUTE_NOTE,
];

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

/**
 * "Use safer approach" or "Dismiss" on Claude's auto-mode card. Both take the
 * card down first; only the safer choice sends the agent a turn. "Dismiss"
 * is for when the person has dealt with the command themselves and the agent
 * needs no new instruction.
 */
export async function answerClaude(
  choice: "safer" | "dismiss",
  block: SafetyBlockNotice,
  io: {
    invoke: <T>(cmd: string, args: Record<string, unknown>) => Promise<T>;
    onAnswered: (id: string) => void;
    onContinue: Continue;
  },
): Promise<void> {
  await io.invoke("safety_block_dismiss", { id: block.id });
  io.onAnswered(block.id);
  if (choice === "safer") await io.onContinue(SAFER_APPROACH_REPLY);
}

/**
 * Claude's auto-mode card: what was refused, that nothing here approves that
 * call, and — when the host could name the line exactly — a lasting "Always
 * allow" whose rules and file are shown before anything is written.
 */
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
  const [sending, setSending] = useState<"safer" | "dismiss" | AllowScope | null>(null);
  const [error, setError] = useState("");
  const [wrote, setWrote] = useState<AllowedOutage | null>(null);
  const detailsId = useId();
  const rules = block.rules ?? [];
  const uncovered = block.uncovered ?? [];
  const projectPath = rules.length ? block.allow?.project : undefined;
  const userPath = rules.length ? block.allow?.user : undefined;
  const offersAllow = !!(projectPath || userPath);

  const answer = async (choice: "safer" | "dismiss") => {
    setSending(choice);
    setError("");
    try {
      await answerClaude(choice, block, { invoke: bridge.invoke.bind(bridge), onAnswered, onContinue });
    } catch (why) {
      setError(String((why as Error)?.message ?? why));
      setSending(null);
    }
  };

  const allow = async (scope: AllowScope) => {
    setSending(scope);
    setError("");
    try {
      await answerJudged(scope, block, {
        invoke: bridge.invoke.bind(bridge), onAnswered, onContinue, onWritten: setWrote,
      });
    } catch (why) {
      setError(String((why as Error)?.message ?? why));
      setSending(null);
    }
  };

  const written = wrote
    ? `${wrote.added.length ? `Added ${wrote.added.join(", ")}` : "Nothing new to add"}` +
      `${wrote.present.length ? `${wrote.added.length ? "; " : ""}already there: ${wrote.present.join(", ")}` : ""} in ${wrote.path}.`
    : block.written
      ? `The rule is already in ${block.written === "project" ? "this project's" : "your own"} settings.`
      : "";

  // At a glance: what was blocked and why, that nothing ran, and one next
  // step. The whole line, the classifier's words and every way to allow it
  // (with the exact rules and files "Always allow" writes, shown before the
  // button) wait behind Details.
  return (
    <div className="ask-card safety-card is-compact" role="alert" aria-label={block.title}>
      <div className="ask-card-head safety-card-head">
        <span className="safety-card-icon" aria-hidden="true">!</span>
        <span className="safety-card-heading">
          <strong className="ask-card-title">{block.title}</strong>
          {block.summary && <span className="safety-card-reason">{block.summary}</span>}
        </span>
      </div>

      {block.action && (
        <pre className="safety-card-action safety-card-preview"><span>{block.action}</span></pre>
      )}
      <p className="safety-card-calm">{CLAUDE_BLOCKED_STATUS}</p>

      {written && <p className="ask-card-note safety-card-written" role="status">{written}</p>}
      {error && <p className="ask-card-note safety-card-error">Could not answer the card: {error}</p>}

      <div className="ask-card-buttons safety-card-buttons">
        <button className="safety-card-toggle" type="button" aria-expanded={open}
          aria-controls={open ? detailsId : undefined} onClick={() => setOpen((shown) => !shown)}>
          {/* One label both ways, so the row never re-wraps on a phone:
              the chevron and aria-expanded carry the state. */}
          Details
          <svg className="safety-card-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <button className="ask-btn is-primary" type="button" disabled={!!sending} onClick={() => void answer("safer")}>
          {sending === "safer" ? "Continuing…" : "Use safer approach"}
        </button>
        <button className="ask-btn" type="button" disabled={!!sending} onClick={() => void answer("dismiss")}>
          {sending === "dismiss" ? "Dismissing…" : "Dismiss"}
        </button>
      </div>

      {open && (
        <div className="safety-card-more" id={detailsId}>
          {block.action && <>
            <div className="safety-card-label safety-card-label-row">
              <span>Command</span>
              <CopyBit className="panel-act safety-card-copy" icon={<CopyIcon />} idle="Copy the command"
                done="Command copied" read={() => ({ text: block.action ?? null })} />
            </div>
            <pre className="safety-card-action safety-card-full">{block.action}</pre>
          </>}

          {block.detail && <>
            <div className="safety-card-label">Technical details</div>
            <pre className="ask-card-body">{block.detail}</pre>
          </>}

          <div className="safety-card-label">How to allow this</div>
          <p className="ask-card-note safety-card-refusal">{CLAUDE_REFUSAL_NOTE}</p>
          <ul className="safety-card-routes">
            {CLAUDE_ALLOW_ROUTES.map((route) => <li key={route}>{route}</li>)}
          </ul>

          {offersAllow && <div className="safety-card-allow">
            <div className="safety-card-label">{rules.length === 1 ? "Rule Always allow adds" : "Rules Always allow adds"}</div>
            <ul className="safety-card-commands safety-card-rules">
              {rules.map((rule) => <li key={rule}><pre className="safety-card-action">{rule}</pre></li>)}
            </ul>
            {uncovered.length > 0 && <>
              <div className="safety-card-label">Not covered: Claude still checks these</div>
              <ul className="safety-card-commands safety-card-uncovered">
                {uncovered.map((part) => <li key={part}><pre className="safety-card-action">{part}</pre></li>)}
              </ul>
            </>}
            <div className="safety-card-label">Where it goes</div>
            <pre className="ask-card-body safety-card-targets">
              {projectPath && `This project: ${projectPath}`}
              {projectPath && userPath && "\n"}
              {userPath && `Everywhere: ${userPath}`}
            </pre>
            <p className="ask-card-note safety-card-rule">{JUDGED_ALLOW_NOTE}</p>
            <div className="ask-card-buttons safety-card-buttons">
              {projectPath && (
                <button className="ask-btn safety-allow" type="button" disabled={!!sending}
                  title={`Adds ${rules.join(", ")} to ${projectPath}, then tells the agent`}
                  onClick={() => void allow("project")}>
                  {sending === "project" ? "Saving…" : "Always allow in this project"}
                </button>
              )}
              {userPath && (
                <button className="ask-btn safety-allow" type="button" disabled={!!sending}
                  title={`Adds ${rules.join(", ")} to ${userPath}, then tells the agent`}
                  onClick={() => void allow("user")}>
                  {sending === "user" ? "Saving…" : "Always allow everywhere"}
                </button>
              )}
            </div>
          </div>}
        </div>
      )}
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
