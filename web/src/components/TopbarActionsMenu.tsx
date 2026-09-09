import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** The phone has one top-bar action: the door to every action that would
 * otherwise squeeze the project name off the bar. The actual controls stay
 * mounted only while the menu is open, so polling controls still exist once. */
export function TopbarActionsMenu({
  children,
  attentionCount = 0,
  initiallyOpen = false,
}: {
  children: ReactNode;
  /** Actionable events stay visible even while the phone menu is closed. */
  attentionCount?: number;
  /** Static-render seam for the menu's structure test. */
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    }
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return (
    <div
      className="mobile-actions"
      ref={root}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }}
    >
      <button
        ref={trigger}
        className="icon-btn mobile-actions-trigger"
        type="button"
        aria-label={attentionCount > 0
          ? `Chat actions, ${attentionCount} ${attentionCount === 1 ? "item needs" : "items need"} attention`
          : "Chat actions"}
        aria-expanded={open}
        aria-controls={panelId}
        title="Chat actions"
        onClick={() => setOpen((value) => !value)}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
        {attentionCount > 0 && <span className="mobile-actions-attention" aria-hidden="true">{attentionCount}</span>}
      </button>

      {open && (
        <div
          id={panelId}
          className="mobile-actions-panel"
          role="group"
          aria-label="Chat actions"
          onClick={(event) => {
            const target = event.target instanceof Element ? event.target : null;
            // Attention owns a second disclosure. Let its trigger open that;
            // choosing an entry inside it closes this outer menu as usual.
            if (target?.closest(".attention-trigger, .copy-chat-id, .open-beside-trigger")) return;
            if (target?.closest("button, a")) setOpen(false);
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
