// Asking before something irreversible.
//
// `window.confirm` was doing this job and it was the wrong tool: it renders in
// the browser's own style rather than the app's, it cannot say anything beyond
// one line of plain text, and on iOS it stamps the site's address across the
// top of the message. It also blocks the whole page — including the agents
// still streaming in the background, which is precisely what v2 exists to keep
// running.
//
// So the question is asked in the app. `useConfirm()` returns a function that
// resolves true or false, which reads the same at the call site as the old one:
//
//     if (!(await confirm({ title: "Delete this chat?" }))) return;
//
// A question is never answered by the key or the press that opened it
// (`lib/pressGuard`), and the whole reason this appears is that the action
// cannot be undone:
//
// - The safe answer takes the focus. The confirming button used to, with a
//   note here that Enter was not wired to it; a focused button answers Enter
//   and Space on its own, so Enter on a Stop control and Enter again stopped
//   the worker. A second Enter or Space now cancels. Tab to the confirming
//   button and Enter is still an answer.
// - A key held down answers nothing: its repeats are dropped inside the
//   question.
// - A pointer press that repeats the one that opened the question, in the
//   same spot, does not confirm it.
//
// Escape cancels, and so does clicking away — a way out is always the easier
// path.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type MouseEvent } from "react";
import { dropHeld, lastPointerPress, strayAnswer } from "../lib/pressGuard";

export type ConfirmOptions = {
  title: string;
  /** The consequence, in a sentence. Skip it when the title says everything. */
  body?: string;
  /** Whole command to inspect before starting work. */
  command?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Paints the confirm button as destructive. For anything that deletes. */
  danger?: boolean;
};

type Ask = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask>(async () => false);

/** Ask the user to confirm. Resolves false if they cancel or dismiss. */
export function useConfirm(): Ask {
  return useContext(ConfirmContext);
}

/** What a question that ends, stops or deletes something does with its
 *  confirming answer, for this dialog and for any that is drawn on its own
 *  (`CompleteChatConfirm`): `keys` goes on the dialog, and drops the repeats
 *  of a held key; `confirm` is the confirming button's click, and drops a
 *  pointer press that repeats the one the question was opened with. */
export function useCarefulAnswer(onConfirm: () => void) {
  // Read once, as the question is first drawn: the press that opened it.
  const opener = useRef(lastPointerPress());
  return {
    keys: dropHeld,
    confirm: (event: MouseEvent) => {
      if (strayAnswer(opener.current, { detail: event.detail, x: event.clientX, y: event.clientY, at: performance.now() })) return;
      onConfirm();
    },
  };
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  // Each question is drawn anew (`asked` is its key), so the focus is put
  // on the safe answer of every one, a question that replaced another too.
  const [pending, setPending] = useState<{ options: ConfirmOptions; asked: number } | null>(null);
  const asked = useRef(0);
  // The other half of the promise handed back to the caller, kept until they
  // answer. A ref rather than state: settling it must not wait for a render.
  const settle = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback<Ask>((options) => {
    return new Promise<boolean>((resolve) => {
      // A second question while one is open would strand the first caller
      // waiting forever, so the old one is answered "no" before it is replaced.
      settle.current?.(false);
      settle.current = resolve;
      asked.current += 1;
      setPending({ options, asked: asked.current });
    });
  }, []);

  const answer = useCallback((ok: boolean) => {
    settle.current?.(ok);
    settle.current = null;
    setPending(null);
  }, []);

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      {pending && <ConfirmDialog key={pending.asked} options={pending.options} onAnswer={answer} />}
    </ConfirmContext.Provider>
  );
}

/** The question as it is drawn. */
export function ConfirmDialog({
  options,
  onAnswer,
}: {
  options: ConfirmOptions;
  onAnswer: (ok: boolean) => void;
}) {
  const careful = useCarefulAnswer(() => onAnswer(true));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onAnswer(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAnswer]);

  return (
    <div className="ask-scrim" onClick={() => onAnswer(false)}>
      <div
        className="ask"
        role="alertdialog"
        aria-modal="true"
        aria-label={options.title}
        onKeyDownCapture={careful.keys}
        // The scrim closes; a click on the dialog itself must not travel up to
        // it and answer the question.
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="ask-title">{options.title}</h2>
        {options.body && <p className="ask-body">{options.body}</p>}
        {options.command !== undefined && <pre className="ask-command"><code>{options.command}</code></pre>}
        <div className="ask-buttons">
          {/* The safe answer has the focus: a key pressed again cancels. */}
          <button className="ask-btn" type="button" autoFocus onClick={() => onAnswer(false)}>
            {options.cancelLabel ?? "Cancel"}
          </button>
          <button
            className={`ask-btn is-primary ${options.danger ? "is-danger" : ""}`}
            type="button"
            onClick={careful.confirm}
          >
            {options.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
