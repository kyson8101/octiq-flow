import type { CSSProperties } from "react";
import { personaHue, personaInitials } from "../lib/agentPersona";
import "./AgentAvatar.css";

/** A registered agent's face: its picture, or its initials on a stable tint.
 *
 *  `decorative` is for places where the name is printed right beside it — a
 *  screen reader would otherwise say the name twice. Everywhere else the
 *  avatar carries the name itself. */
export function AgentAvatar({
  name,
  avatar,
  id,
  size = 20,
  decorative = false,
  removed = false,
  className = "",
  label,
}: {
  name: string;
  /** What a screen reader hears, when it should say more than the name. */
  label?: string;
  avatar?: string;
  /** What the tint is keyed on; the name when there is no registration. */
  id?: string;
  size?: number;
  decorative?: boolean;
  removed?: boolean;
  className?: string;
}) {
  const style = {
    "--agent-avatar-size": `${size}px`,
    "--agent-avatar-hue": String(personaHue(id ?? name)),
  } as CSSProperties;
  const spoken = label ?? (removed ? `${name} (no longer registered)` : name);
  return (
    <span
      className={["agent-avatar", avatar ? "has-image" : "", removed ? "is-removed" : "", className].filter(Boolean).join(" ")}
      style={style}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": spoken })}
      title={decorative ? undefined : spoken}
    >
      {avatar
        ? <img src={avatar} alt="" draggable={false} />
        : <span className="agent-avatar-initials">{personaInitials(name)}</span>}
    </span>
  );
}
