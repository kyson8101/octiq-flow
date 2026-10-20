import type { CSSProperties } from "react";
import { personaHue, personaInitials } from "../lib/agentPersona";
import "./AgentAvatar.css";
import { useIslandPortrait } from "../lib/island/usePortrait";

/** A registered agent's face: its picture, or its initials on a stable tint.
 *
 *  `decorative` is for places where the name is printed right beside it — a
 *  screen reader would otherwise say the name twice. Everywhere else the
 *  avatar carries the name itself. */
export function AgentAvatar({
  name,
  avatar,
  island = false,
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
  /** In chat, use the registered robot with its current outfit. */
  island?: boolean;
  /** What the tint is keyed on; the name when there is no registration. */
  id?: string;
  size?: number;
  decorative?: boolean;
  removed?: boolean;
  className?: string;
}) {
  const portrait = useIslandPortrait(island && !removed ? id : undefined);
  const picture = portrait?.image ?? avatar;
  const style = {
    "--agent-avatar-size": `${size}px`,
    "--agent-avatar-hue": String(personaHue(id ?? name)),
    "--portrait-frames": portrait?.frames ?? 1,
    "--portrait-delay": `${-personaHue(id ?? name) / 100}s`,
  } as CSSProperties;
  const spoken = label ?? (removed ? `${name} (no longer registered)` : name);
  return (
    <span
      className={["agent-avatar", picture ? "has-image" : "", portrait ? "is-island" : "", removed ? "is-removed" : "", className].filter(Boolean).join(" ")}
      style={style}
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": spoken })}
      title={decorative ? undefined : spoken}
    >
      {picture
        ? <img src={picture} alt="" draggable={false} />
        : <span className="agent-avatar-initials">{personaInitials(name)}</span>}
    </span>
  );
}
