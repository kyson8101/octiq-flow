// An agent's role, as its lists show it. A role is written for the agent, not
// for a list: the real ones run to a thousand characters or more, and printed
// whole they turned a phone's roster into a wall of text. A list shows two
// lines; the rest opens on request, in place, and is never cut from what is
// stored — this only decides how much of it is on screen.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import "./AgentRole.css";

export function AgentRole({ text, name, className }: {
  text: string;
  /** Whose role it is, so the toggle says what it opens. */
  name: string;
  className?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  useEffect(() => setOpen(false), [text]);
  // Measured, not guessed from the length: two lines hold very different
  // amounts in a 375px column and across a desktop one. Only while shut — an
  // open role is never clipped, and would hide its own "Show less".
  useLayoutEffect(() => {
    const role = ref.current;
    if (!role || open) return;
    const measure = () => setClipped(role.scrollHeight > role.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(role);
    return () => observer.disconnect();
  }, [text, open]);
  return <div className={`agent-role${open ? " is-open" : ""}${className ? ` ${className}` : ""}`}>
    <p className="agent-role-text" id={id} ref={ref}>{text}</p>
    <button type="button" className="agent-role-toggle" hidden={!clipped && !open}
      aria-expanded={open} aria-controls={id}
      aria-label={open ? `Show less of ${name}'s role` : `Full role for ${name}`}
      onClick={() => setOpen(!open)}>{open ? "Show less" : "Full role"}</button>
  </div>;
}

/** Who a new conversation is with, under its heading. The same role, printed
 *  whole, filled a phone and pushed the picker and the composer off the first
 *  screen, so this is one line — the role's first sentence and where the agent
 *  works — and the rest opens on request, in place. Keyed by agent where it is
 *  used, so picking someone else starts shut. */
export function AgentWelcome({ name, role, scope, how, greeting }: {
  name: string;
  role: string;
  /** Where it works, short: "Works only in starfall". */
  scope: string;
  /** How a conversation with it goes, in a sentence. */
  how: string;
  /** A line said TO the person in place of the role and scope, for an agent
   *  whose role is written about the person (the front desk). The role
   *  still opens under Details. */
  greeting?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const summary = greeting?.trim()
    || [role.trim() ? rolePreview(role, 64) : "", scope].filter(Boolean).join(" · ");
  return <>
    <p className="hero-sub agent-welcome">
      <span className="agent-welcome-summary">{summary}</span>
      <button type="button" className="agent-welcome-toggle" aria-expanded={open} aria-controls={id}
        aria-label={`Details about ${name}`} onClick={() => setOpen(!open)}>
        Details
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
    </p>
    <div className="agent-welcome-details" id={id} role="region" aria-label={`About ${name}`}
      tabIndex={open ? 0 : -1} hidden={!open}>
      {role.trim() && <p className="agent-welcome-role">{role.trim()}</p>}
      <p>{how}</p>
    </div>
  </>;
}

/** A role short enough for one line of a picker: its first sentence, cut at a
 *  word near `max` characters. Only for labels — the role itself is untouched. */
export function rolePreview(role: string, max = 56): string {
  const flat = role.replace(/\s+/g, " ").trim();
  const sentence = flat.match(/^.+?[.;:!?](?=\s|$)/)?.[0] ?? flat;
  const first = sentence.replace(/[.;:]$/, "");
  if (first.length <= max) return first;
  const cut = first.slice(0, max + 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : first.slice(0, max)).replace(/[\s,;:·-]+$/, "")}…`;
}
