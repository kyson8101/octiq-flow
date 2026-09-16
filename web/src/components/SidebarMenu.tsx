import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

export type SidebarMenuItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Keep delete's countdown and its undo action in the same menu. */
  keepOpen?: boolean;
};

/** Every sidebar action lives behind the same quiet, labelled disclosure. */
export function SidebarMenu({ label, items, open, onOpenChange, className = "", disabled = false, icon }: {
  label: string;
  items: SidebarMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const id = useId();
  return <>
    <button ref={anchor} className={`sidebar-menu-trigger ${className}`} type="button"
      aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? id : undefined} disabled={disabled}
      onClick={(event) => { event.currentTarget.focus(); onOpenChange(!open); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          onOpenChange(true);
        }
      }}>
      {icon ?? <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
      </svg>}
    </button>
    {open && !disabled && <Dropdown id={id} label={label} anchor={anchor} items={items} onClose={() => onOpenChange(false)} />}
  </>;
}

/** A top-layer dropdown cannot be clipped by a folding or scrolling list.
 * Native dialog focus containment/restoration also works for touch long press. */
function Dropdown({ id, label, anchor, items, onClose }: {
  id: string;
  label: string;
  anchor: RefObject<HTMLButtonElement | null>;
  items: SidebarMenuItem[];
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const element = dialog.current!;
    const trigger = anchor.current!;
    trigger.focus({ preventScroll: true });
    element.showModal();
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const position = () => {
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = viewport?.offsetLeft ?? 0;
      const top = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      const box = element.getBoundingClientRect();
      element.style.left = `${Math.max(left + 8, Math.min(rect.right - box.width, left + width - box.width - 8))}px`;
      const below = rect.bottom + 4;
      const y = below + box.height <= top + height - 8 ? below : rect.top - box.height - 4;
      element.style.top = `${Math.max(top + 8, Math.min(y, top + height - box.height - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(element);
    const dismiss = () => close.current();
    const scrolled = (event: Event) => {
      // The menu itself can scroll on a short screen without dismissing.
      if (!(event.target instanceof Node) || !element.contains(event.target)) dismiss();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", scrolled, true);
    window.visualViewport?.addEventListener("resize", dismiss);
    return () => {
      observer.disconnect();
      element.close();
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", scrolled, true);
      window.visualViewport?.removeEventListener("resize", dismiss);
    };
  }, [anchor]);

  const dismiss = () => {
    dialog.current?.close();
    onClose();
  };

  return createPortal(
    <dialog ref={dialog} id={id} className="sidebar-dropdown" role="menu" aria-label={label}
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      onPointerDown={(event) => { backdropPress.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        if (backdropPress.current && event.target === event.currentTarget) dismiss();
        backdropPress.current = false;
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") { dismiss(); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      {items.map(item => <button key={item.id} type="button" role="menuitem" tabIndex={-1}
        className={item.danger ? "is-danger" : undefined} disabled={item.disabled}
        onClick={() => {
          if (!item.keepOpen) dismiss();
          item.onSelect();
        }}>
        {item.icon}<span>{item.label}</span>
      </button>)}
    </dialog>, document.body,
  );
}
