/** The two agents' marks, for the places a name would otherwise be spelled out.
 *
 *  Hand-drawn, not the official files. Both are recognisable at 14px — which is
 *  the whole point of using a mark instead of the word — but they are OUR
 *  rendering of someone else's logo: the sunburst has Claude's eleven rays and
 *  the knot has the six lobes around a hexagonal middle, and neither is traced
 *  from the vendor's own SVG. Drop the real files in and swap the two paths.
 *
 *  Both draw in `currentColor`, so a mark takes the colour of the button
 *  holding it. Claude is then tinted back to its orange in the stylesheet
 *  (`.agent-logo.is-claude`) because at 14px the colour tells the two apart
 *  faster than the shapes do; OpenAI's mark has no colour of its own, so Codex
 *  keeps the button's and lifts with it on hover. */

/** Claude's sunburst: eleven tapered rays from a solid middle. */
const CLAUDE = "M13.72 11.10L12.00 1.40L10.28 11.10ZM13.93 12.17L17.73 3.08L11.04 10.31ZM13.53 13.19L21.64 7.60L12.10 10.06ZM12.65 13.83L22.49 13.51L13.14 10.43ZM11.55 13.89L20.01 18.94L13.81 11.29ZM10.60 13.35L14.99 22.17L13.90 12.38ZM10.10 12.38L9.01 22.17L13.40 13.35ZM10.19 11.29L3.99 18.94L12.45 13.89ZM10.86 10.43L1.51 13.51L11.35 13.83ZM11.90 10.06L2.36 7.60L10.47 13.19ZM12.96 10.31L6.27 3.08L10.07 12.17Z";

/** Codex's knot: three rounded bars at sixty degrees, whose overlap leaves the
 *  six lobes and the hexagonal hole. Drawn as strokes rather than one outline
 *  because a stroke keeps its weight when the mark is scaled down. */
const CODEX_BAR = { x: 2.6, y: 7.8, width: 18.8, height: 8.4, rx: 4.2 };

export function AgentLogo({
  agent,
  size = 14,
}: {
  agent: "claude" | "codex";
  /** Drawn square. Callers size it; the mark never picks its own. */
  size?: number;
}) {
  const name = agent === "claude" ? "Claude" : "Codex";
  return (
    <svg
      className={`agent-logo is-${agent}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label={name}
    >
      {agent === "claude" ? (
        <path d={CLAUDE} fill="currentColor" />
      ) : (
        <g fill="none" stroke="currentColor" strokeWidth="2">
          {[0, 60, 120].map((deg) => (
            <rect key={deg} {...CODEX_BAR} transform={`rotate(${deg} 12 12)`} />
          ))}
        </g>
      )}
    </svg>
  );
}
