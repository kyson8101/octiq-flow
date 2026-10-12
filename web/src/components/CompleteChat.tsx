// Completing a chat: the action, the question before it, and the one line
// that says where it stands.
//
// Three small surfaces, because they live in three places. The action sits in
// the chat's own menu beside Copy and Delete. The question is asked over the
// page, since the menu closes on the click that opened it. The line sits
// above the composer, where the chat's other one-line facts are.
//
// The question is a decision, not a warning: nothing here destroys anything,
// a new message reopens the chat, and the wrap-up can be taken back from its
// own queued bubble. So it is drawn in the decision colour, compact, with the
// steps the agent is asked behind one disclosure.
import { useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import {
  confirmContent,
  type CompleteAction,
  type CompletePreview,
  type CompletionLine,
  type ConfirmContent,
} from "../lib/chatComplete";
import { count } from "../lib/cardFold";
import type { MissionOffer } from "../lib/useChatCompletions";
import { FoldBody, FoldLine, useFold } from "./CardFold";
import { useCarefulAnswer } from "./Confirm";
import "./CompleteChat.css";

/** The action in the chat's menu. Icon and tooltip; the label shows in the
 *  menu, where every action is a row. */
export function CompleteChatButton({ action, onClick }: { action: CompleteAction; onClick: () => void }) {
  if (!action.shown) return null;
  return (
    <button
      className="icon-btn complete-chat"
      type="button"
      aria-label={action.label}
      title={action.label}
      disabled={action.disabled}
      onClick={onClick}
    >
      <CompleteIcon />
      <span className="topbar-action-label">{action.label}</span>
    </button>
  );
}

/** A flag at the end of the course: finished, as distinct from the tick the
 *  list uses for "done" and the bin beside it. */
function CompleteIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 21V4" />
      <path d="M5 5h11l-2 3.5 2 3.5H5" />
    </svg>
  );
}

/** Asks the host what it knows, then asks the person. Nothing is sent to the
 *  agent until the person confirms. */
export function CompleteChatDialog({
  chatKey,
  busy,
  onCancel,
  onConfirm,
}: {
  chatKey: string;
  /** A turn is in flight, so the wrap-up will wait behind it. */
  busy: boolean;
  onCancel: () => void;
  onConfirm: (preview?: CompletePreview) => void;
}) {
  const [preview, setPreview] = useState<CompletePreview>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true;
    setLoading(true);
    bridge
      .invoke<CompletePreview>("chat_complete_preview", { chatKey })
      .then((answer) => { if (current) setPreview(answer); })
      // No preview is no facts, not no completion: the host checks again when
      // it is asked, and says why if it will not.
      .catch(() => {})
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [chatKey]);

  return (
    <CompleteChatConfirm
      content={confirmContent(preview, { busy })}
      loading={loading}
      onCancel={onCancel}
      onConfirm={() => onConfirm(preview)}
    />
  );
}

/** The drawing half, pure so every state of it is a render. */
export function CompleteChatConfirm({
  content,
  loading = false,
  startOpen = false,
  onCancel,
  onConfirm,
}: {
  content: ConfirmContent;
  loading?: boolean;
  /** Draw the steps opened: for the tests, which cannot press the control. */
  startOpen?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // One question on screen at a time, and it starts folded each time it is asked.
  const fold = useFold("complete-chat", { startOpen });
  // Completing stops the chat's process, so this is asked as carefully as
  // any question that stops something (`Confirm.useCarefulAnswer`): the
  // focus is on Cancel from the first draw, a held key answers nothing, and
  // a press that repeats the one that opened this does not confirm it.
  const careful = useCarefulAnswer(onConfirm);
  // Through a ref: the page behind re-renders on every delta of a streaming
  // reply, and each one must not rebind the key.
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancel.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="ask-scrim" onClick={onCancel}>
      <div className="ask complete-ask" role="alertdialog" aria-modal="true" aria-label={content.title}
        onKeyDownCapture={careful.keys}
        onClick={(event) => event.stopPropagation()}>
        <h2 className="ask-title complete-ask-title">
          <span className="complete-ask-mark" aria-hidden="true"><CompleteIcon size={15} /></span>
          {content.title}
        </h2>
        <p className="complete-ask-lead">{content.lead}</p>
        {content.waits && <p className="complete-ask-waits">{content.waits}</p>}

        {content.facts.length > 0 ? (
          <dl className="complete-ask-facts">
            {content.facts.map((fact, index) => (
              <div key={`${index}-${fact.label}`}>
                <dt>{fact.label}</dt>
                <dd title={fact.value}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : loading && <p className="complete-ask-loading" role="status">Checking the workspace…</p>}

        {/* The one disclosure every decision card has (`CardFold`): the line
            that names what is folded, above what it opens, above the
            answers. */}
        <div className="complete-ask-steps">
          <FoldLine fold={fold} what="the steps"
            labels={[`What the agent is asked · ${count(content.steps.length, "step")}`]} />
          <FoldBody fold={fold}>
            <ol>
              {content.steps.map((step) => (
                <li key={step.label}><strong>{step.label}</strong><span>{step.line}</span></li>
              ))}
            </ol>
          </FoldBody>
        </div>

        {content.refusal && <p className="complete-ask-refusal" role="status">{content.refusal}</p>}

        <div className="ask-buttons">
          {/* The safe answer has the focus, once, from the first draw: the
              page behind re-renders on every delta and must not pull it
              back, and a key pressed again cancels. */}
          <button className="ask-btn" type="button" autoFocus onClick={onCancel}>
            {content.refusal ? "Close" : "Cancel"}
          </button>
          {/* Nothing can be confirmed until the host has said what it knows,
              or that it will not: the answer is what the question is about. */}
          {!content.refusal && (
            <button className="ask-btn is-primary" type="button" disabled={loading} onClick={careful.confirm}>
              Complete
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The line above the composer: completing, completed, or why not.
 *
 *  It reports. The only things on it that act are the person's own: dismiss,
 *  and closing a mission the host says can be closed. */
export function ChatCompletionLine({
  line,
  offers = [],
  onCloseMission,
  onDismiss,
}: {
  line: CompletionLine | null;
  offers?: MissionOffer[];
  onCloseMission?: (runId: string) => void;
  onDismiss?: () => void;
}) {
  if (!line) return null;
  const error = offers.find((offer) => offer.error)?.error;
  return (
    <div className="chat-completion" data-kind={line.kind} role="status">
      <span className="chat-completion-mark" aria-hidden="true">
        {line.kind === "done" ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        ) : line.kind === "completing" ? <span className="chat-completion-dot" /> : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M6 12h12" />
          </svg>
        )}
      </span>
      <span className="chat-completion-copy">
        <span className="chat-completion-label">{line.label}</span>
        {line.detail && <span className="chat-completion-detail">{line.detail}</span>}
        {error && <span className="chat-completion-detail">{error}</span>}
      </span>
      {line.kind === "done" && onCloseMission && offers.map((offer) => (
        <button key={offer.run.runId} type="button" className="chat-completion-action" disabled={offer.closing}
          title="Git confirms the merge. Remove the mission's worktree and its local branch."
          onClick={() => onCloseMission(offer.run.runId)}>
          {offer.closing ? "Closing…" : "Close mission"}
        </button>
      ))}
      {line.kind !== "completing" && onDismiss && (
        <button type="button" className="chat-completion-dismiss" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      )}
    </div>
  );
}

/** What a wrap-up bubble shows in place of the host's text. The text is the
 *  agent's instructions, not something the person said, so it stays behind a
 *  disclosure that says how much is there. */
export function WrapUpNote({ label, detail, text }: { label: string; detail: string; text: string }) {
  const lines = text.split("\n").filter((line) => line.trim()).length;
  return (
    <div className="wrap-up-note">
      <span className="wrap-up-note-head">
        <span className="wrap-up-note-mark" aria-hidden="true"><CompleteIcon size={13} /></span>
        <span className="wrap-up-note-label">{label}</span>
        <span className="wrap-up-note-detail">{detail}</span>
      </span>
      {lines > 0 && (
        <details className="wrap-up-note-text">
          <summary>What the agent is asked · {lines} {lines === 1 ? "line" : "lines"}</summary>
          <p>{text}</p>
        </details>
      )}
    </div>
  );
}
