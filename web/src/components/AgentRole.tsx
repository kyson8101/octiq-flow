// An agent's role, as its lists show it. A role is written for the agent, not
// for a list: the real ones run to a thousand characters or more, and printed
// whole they turned a phone's roster into a wall of text. A list shows two
// lines; the rest opens on request, in place, and is never cut from what is
// stored — this only decides how much of it is on screen.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

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
