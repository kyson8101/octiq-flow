import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { canStepFocusFontSize, savedFocusFontSize, saveFocusFontSize, stepFocusFontSize } from "../lib/focusFontSize";
import { cancelZenTransition, transitionZen } from "../lib/zenMotion";

/** The size focus mode reads at, kept per browser (see lib/focusFontSize). */
export function useFocusFontSize() {
  const [fontSize, setFontSize] = useState(savedFocusFontSize);
  const changeFontSize = useCallback((next: number) => {
    setFontSize(next);
    saveFocusFontSize(next);
  }, []);
  return { fontSize, changeFontSize };
}

/** What `.app.focus-mode` reads its sizes from (FocusMode.css). */
export function focusFontStyle(fontSize: number): CSSProperties {
  return { "--focus-font-size": `${fontSize}px` } as CSSProperties;
}

/** A temporary view, independent of the user's saved panel preferences. */
export function useFocusMode(available: boolean) {
  const [enabled, setEnabled] = useState(false);
  const previousFocus = useRef<HTMLElement | null>(null);
  const focusMode = enabled && available;
  const enterFocus = useCallback(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    transitionZen("enter", () => setEnabled(true));
  }, []);
  const exitFocus = useCallback(() => {
    transitionZen("exit", () => {
      setEnabled(false);
      requestAnimationFrame(() => {
        const previous = previousFocus.current;
        // On mobile the entry action belonged to a menu that has since closed.
        const target = previous?.isConnected && previous.getClientRects().length
          ? previous : document.querySelector<HTMLElement>(".mobile-actions-trigger, .focus-mode-enter");
        target?.focus({ preventScroll: true });
      });
    });
  }, []);

  useEffect(() => {
    if (!available) {
      cancelZenTransition();
      setEnabled(false);
    }
  }, [available]);

  useEffect(() => () => cancelZenTransition(), []);

  useEffect(() => {
    if (!focusMode) return;
    // Put keyboard focus on a visible control without opening a mobile keyboard
    // or moving the transcript away from the passage being read.
    document.querySelector<HTMLElement>(".focus-mode-exit")?.focus({ preventScroll: true });
    function escape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      // A menu or dialog owns Escape first; its dismissal must not also leave
      // focus mode. Only visible surfaces count (side panels stay mounted).
      const overlays = document.querySelectorAll<HTMLElement>(
        '[role="dialog"], [role="menu"], .picker-menu, .sheet-scrim, .slash, .modal-scrim',
      );
      if ([...overlays].some(element => element.getClientRects().length > 0)) return;
      event.preventDefault();
      exitFocus();
    }
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [focusMode, exitFocus]);

  return { focusMode, enterFocus, exitFocus };
}

export function FocusModeButton({ active = false, onClick }: { active?: boolean; onClick: () => void }) {
  return (
    <button
      className={active ? "focus-mode-exit" : "icon-btn focus-mode-enter"}
      type="button"
      aria-label={active ? "Exit focus mode" : "Enter focus mode"}
      title={active ? "Exit focus mode (Esc)" : "Focus mode"}
      aria-pressed={active}
      onClick={onClick}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={active ? "M9 4v5H4m16 0h-5V4M4 15h5v5m6 0v-5h5" : "M9 4H4v5m11-5h5v5M4 15v5h5m6 0h5v-5"} />
      </svg>
      <span className={active ? undefined : "topbar-action-label"}>{active ? "Exit focus" : "Focus mode"}</span>
    </button>
  );
}

/** Smaller and larger text, beside the way out. Two letters, as a reader
 *  expects them; the size itself is in the tooltip, not on the screen.
 *  An end of the range is `aria-disabled`, not `disabled`: a button that
 *  disables itself under the keyboard drops focus onto the page. */
export function FocusFontSizeControl({ fontSize, onChange }: { fontSize: number; onChange: (next: number) => void }) {
  const smaller = canStepFocusFontSize(fontSize, -1);
  const larger = canStepFocusFontSize(fontSize, 1);
  return (
    <div className="focus-font-size" role="group" aria-label={`Text size, ${fontSize} pixels`}>
      <button
        className="focus-font-step is-smaller"
        type="button"
        aria-label="Smaller text"
        title={smaller ? `Smaller text (now ${fontSize}px)` : `Smallest text (${fontSize}px)`}
        aria-disabled={!smaller}
        onClick={() => { if (smaller) onChange(stepFocusFontSize(fontSize, -1)); }}
      >
        <span aria-hidden="true">A</span>
      </button>
      <button
        className="focus-font-step is-larger"
        type="button"
        aria-label="Larger text"
        title={larger ? `Larger text (now ${fontSize}px)` : `Largest text (${fontSize}px)`}
        aria-disabled={!larger}
        onClick={() => { if (larger) onChange(stepFocusFontSize(fontSize, 1)); }}
      >
        <span aria-hidden="true">A</span>
      </button>
    </div>
  );
}
