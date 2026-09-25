import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./WorkspaceHeader.css";

/** The places in the app's one top bar that a page may write into. The top
 *  bar belongs to the workspace column, and a page that drew its own header
 *  under it made two bars stacked over one screen. So a page names itself and
 *  its actions here, and they render IN the top bar, beside the way back.
 *
 *  A slot is null when the host does not offer it (a component rendered on its
 *  own, a test, the run surface on a phone), and the page then draws its own
 *  row exactly where it would have — nothing is lost, it is just not merged. */
export type WorkspaceSlots = {
  /** After the navigation button: the way back and the page's title. */
  heading: HTMLElement | null;
  /** Before the top bar's own actions: this page's buttons. */
  actions: HTMLElement | null;
  /** After the chat's identity: the run line of a chat with a run. */
  context: HTMLElement | null;
};

export const WorkspaceSlotsContext = createContext<WorkspaceSlots | null>(null);

export function useWorkspaceSlot(name: keyof WorkspaceSlots): HTMLElement | null {
  return useContext(WorkspaceSlotsContext)?.[name] ?? null;
}

/** A page's title, the way back and its actions, drawn into the top bar. */
export function WorkspaceHeader({ title, back, actions, root = false, className }: {
  /** The page's heading. Pages pass their own `<h1>` so they can focus it. */
  title: ReactNode;
  back?: { label: string; ariaLabel?: string; onClick: () => void };
  actions?: ReactNode;
  /** A top-level page: its way back goes to the chat, and on a phone the
   *  navigation button beside it already does that, so the label goes. */
  root?: boolean;
  className?: string;
}) {
  const heading = useWorkspaceSlot("heading");
  const actionsSlot = useWorkspaceSlot("actions");
  const lead = <>
    {back && <button type="button" className={`workspace-back${root ? " is-root" : ""}`}
      onClick={back.onClick} aria-label={back.ariaLabel ?? `Back to ${back.label}`} title={back.ariaLabel ?? `Back to ${back.label}`}>
      <BackIcon /><span>{back.label}</span>
    </button>}
    <div className="workspace-heading">{title}</div>
  </>;
  const buttons = actions ? <div className="workspace-actions">{actions}</div> : null;

  // A phone's top bar has no room for a page's buttons, so the host offers
  // the heading slot alone and they sit at the top of the page's content.
  if (heading) return <>
    {createPortal(lead, heading)}
    {actions && (actionsSlot
      ? createPortal(buttons, actionsSlot)
      : <div className="workspace-actions is-inline">{actions}</div>)}
  </>;
  return <header className={`workspace-header${className ? ` ${className}` : ""}`}>{lead}{buttons}</header>;
}

function BackIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>;
}
