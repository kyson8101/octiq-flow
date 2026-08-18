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
// The confirm button takes the focus, but Enter is NOT wired to it: a dialog
// that a stray keystroke can accept is not a question, and the whole reason
// this appears is that the action cannot be undone. Escape cancels, and so does
// clicking away — a way out is always the easier path.
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type ConfirmOptions = {
  title: string;
  /** The consequence, in a sentence. Skip it when the title says everything. */
  body?: string;
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

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  // The other half of the promise handed back to the caller, kept until they
  // answer. A ref rather than state: settling it must not wait for a render.
  const settle = useRef<((ok: boolean) => void) | null>(null);

  const ask = useCallback<Ask>((options) => {
    return new Promise<boolean>((resolve) => {
      // A second question while one is open would strand the first caller
      // waiting forever, so the old one is answered "no" before it is replaced.
      settle.current?.(false);
      settle.current = resolve;
      setPending(options);
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
      {pending && <Dialog options={pending} onAnswer={answer} />}
    </ConfirmContext.Provider>
  );
}

function Dialog({
  options,
  onAnswer,
}: {
  options: ConfirmOptions;
  onAnswer: (ok: boolean) => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
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
        // The scrim closes; a click on the dialog itself must not travel up to
        // it and answer the question.
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="ask-title">{options.title}</h2>
        {options.body && <p className="ask-body">{options.body}</p>}
        <div className="ask-buttons">
          <button className="ask-btn" type="button" onClick={() => onAnswer(false)}>
            {options.cancelLabel ?? "Cancel"}
          </button>
          <button
            ref={confirmRef}
            className={`ask-btn is-primary ${options.danger ? "is-danger" : ""}`}
            type="button"
            onClick={() => onAnswer(true)}
          >
            {options.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
