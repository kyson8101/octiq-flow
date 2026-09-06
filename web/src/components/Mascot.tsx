import type { ReactElement } from "react";
import type { ComposerStyle } from "../lib/agentProviders";

/** The little robots — one per model presentation, built from ten base bodies.
 *
 *  They are drawn rather than shipped as pictures, for the same reasons
 *  `AgentLogo` is: the office cast in `assets/agents/` are megabyte PNGs of
 *  people, unreadable at this size and unthemeable, and a mark that has to work
 *  in every pasted theme has to be able to take its colours from one.
 *
 *  THREE things move on one, which sounds like exactly what was once taken off
 *  this screen — it is not. Those were three separate marks each answering "is
 *  it alive?" in a different corner. These are three parts of ONE creature, and
 *  a creature that only blinked, or only bobbed, would read as a broken loop
 *  rather than as something alive. The eye is a character; the eye is not a
 *  spinner.
 *
 *  ## Why ten base bodies
 *
 *  A model is already a visual voice here — `ComposerStyle` gives each one its
 *  accent and the composer wears it. The robot is that same fact said as a
 *  face, which is the one form of it you can recognise without reading: you
 *  learn what Haiku looks like once and then you know, mid-turn, from the
 *  corner of your eye, which model is doing the work. So the SILHOUETTES
 *  differ, not just the paint. Pi deliberately reuses the matching Codex body,
 *  because it is the same underlying model, and adds a small `P` provider mark
 *  at bottom-left so the harness remains visible.
 *
 *  Every variant keeps the same part names (`mascot-head`, `mascot-eye`,
 *  `mascot-lamp`, …) so one stylesheet dresses and animates all ten, and
 *  every one of them keeps two separately-addressable eyes so they blink out
 *  of step. The differences are geometry.
 *
 *  ## Why the box never moves
 *
 *  The dance is animated on the inner `<g>`, never on the `<svg>` — the line it
 *  sits in clips its overflow to keep its ellipsis, so a robot that moved the
 *  whole box would have its antenna shaved off at the top of every step. Each
 *  drawing keeps a unit of headroom inside the viewBox instead, and moves
 *  around inside a box that never moves.
 */

/** What the robot is doing, which is the whole of what it is drawn for.
 *
 *  `still` is not "off" — it is the robot you are ABOUT to talk to, sitting on
 *  an idle prompt box and on every tile in the model menu. It holds the same
 *  slot the dancing one will take, so a turn starting does not make a robot
 *  appear and shove the line along; it makes the robot already there start
 *  moving, which is the change actually worth noticing. */
export type MascotMood = "still" | "think" | "work";

type CodexRobot = "astra" | "sol" | "terra" | "luna" | "codex";

/** A provider mark over the base model drawing. It is geometry rather than an
 * SVG font glyph so the `P` stays crisp and predictable at the 18px raster. */
function PiBadge() {
  return (
    <g className="mascot-provider-badge" data-provider-mark="pi">
      <rect x="0.7" y="16.7" width="7" height="6.6" rx="2" />
      <path d="M2.8 21.8v-3.6h1.7c1.8 0 1.8 2.3 0 2.3H2.8" />
    </g>
  );
}

/** Draw a Codex model through Pi: identical body, provider badge added last so
 * it sits visibly over the bottom-left corner. `ROBOTS` is initialized before
 * any component invokes this function. */
function PiRobot({ base }: { base: CodexRobot }) {
  const Draw = ROBOTS[base];
  return (
    <>
      <Draw />
      <PiBadge />
    </>
  );
}

/** Ten base drawings plus five Pi-badged Codex variants. Keyed by
 * `ComposerStyle` so a model that skips its visual cannot compile. */
const ROBOTS: Record<ComposerStyle, () => ReactElement> = {
  /* ---- Claude ------------------------------------------------------- */

  /** Opus: an observatory sage. A floating halo, domed helmet and round
   *  listening dishes frame a calm, wide-eyed face. */
  opus: () => (
    <>
      <ellipse className="mascot-lamp is-halo" cx="12" cy="3.1" rx="4.3" ry="1.15" />
      <circle className="mascot-trim" cx="3.6" cy="14.2" r="2.1" />
      <circle className="mascot-trim" cx="20.4" cy="14.2" r="2.1" />
      <path className="mascot-head mascot-shell" d="M12 6.6a7.5 7.5 0 0 1 7.5 7.5v3.4a3.7 3.7 0 0 1-3.7 3.7H8.2a3.7 3.7 0 0 1-3.7-3.7v-3.4A7.5 7.5 0 0 1 12 6.6Z" />
      <path className="mascot-faceplate" d="M6.6 14a5.4 5.4 0 0 1 10.8 0v3.1a2.1 2.1 0 0 1-2.1 2.1H8.7a2.1 2.1 0 0 1-2.1-2.1Z" />
      <ellipse className="mascot-eye" cx="9.3" cy="14" rx="1.35" ry="2" />
      <ellipse className="mascot-eye is-right" cx="14.7" cy="14" rx="1.35" ry="2" />
      <path className="mascot-grin" d="M10.4 17.3h3.2v1h-3.2Z" />
    </>
  ),

  /** Sonnet: a copper companion. The familiar bulb and side pods now sit
   *  on a soft, cheeked shell with an open, welcoming smile. */
  sonnet: () => (
    <>
      <path className="mascot-stalk" d="M12 7.4V4.8" />
      <circle className="mascot-lamp" cx="12" cy="3.6" r="1.55" />
      <rect className="mascot-trim" x="1.5" y="11" width="3.6" height="6.5" rx="1.7" />
      <rect className="mascot-trim" x="18.9" y="11" width="3.6" height="6.5" rx="1.7" />
      <path className="mascot-head mascot-shell" d="M8 7.3h8a4.2 4.2 0 0 1 4.2 4.2v4.1c0 3.3-3.2 5.7-8.2 5.7s-8.2-2.4-8.2-5.7v-4.1A4.2 4.2 0 0 1 8 7.3Z" />
      <path className="mascot-faceplate" d="M8.3 9.7h7.4a2.5 2.5 0 0 1 2.5 2.5v3.3c0 2.2-2.5 3.8-6.2 3.8s-6.2-1.6-6.2-3.8v-3.3a2.5 2.5 0 0 1 2.5-2.5Z" />
      <circle className="mascot-eye" cx="9" cy="13.3" r="1.55" />
      <circle className="mascot-eye is-right" cx="15" cy="13.3" r="1.55" />
      <path className="mascot-grin" d="M9.8 16.1q2.2.8 4.4 0c-.2 2.5-4.2 2.5-4.4 0Z" />
    </>
  ),

  /** Haiku: a feather courier. Swept fins, a leaf-shaped signal vane and a
   *  compact flight mask keep its silhouette light and quick. */
  haiku: () => (
    <>
      <path className="mascot-detail" d="m13.8 9.3 3-3" />
      <path className="mascot-lamp" d="M15.1 7.2c-.3-2.6 1.3-4.2 5-4.1-.4 3.2-2.1 4.9-5 4.1Z" />
      <path className="mascot-trim" d="m5.2 12.3-3.5-2.1.8 5.7 3.2 1.3Zm13.6 0 3.5-2.1-.8 5.7-3.2 1.3Z" />
      <path className="mascot-head mascot-shell" d="M7.7 9h8.6c2.8 0 4.2 2.1 3.8 4.7l-.5 2.8c-.4 2.6-3.1 4.1-7.6 4.1s-7.2-1.5-7.6-4.1l-.5-2.8C3.5 11.1 4.9 9 7.7 9Z" />
      <path className="mascot-faceplate" d="M8.1 11.1h7.8c1.7 0 2.4 1 2.2 2.6l-.4 2.2c-.2 1.6-2.2 2.6-5.7 2.6s-5.5-1-5.7-2.6l-.4-2.2c-.2-1.6.5-2.6 2.2-2.6Z" />
      <path className="mascot-eye" d="M7.5 14.5v-.6a1.45 1.45 0 0 1 2.9 0v.6Z" />
      <path className="mascot-eye is-right" d="M13.6 14.5v-.6a1.45 1.45 0 0 1 2.9 0v.6Z" />
      <path className="mascot-grin" d="M10.7 16h3.5c-.4 1.6-2.9 1.6-3.5 0Z" />
    </>
  ),

  /** Fable: a storybook guardian. A three-point crown grows out of a
   *  tapered shield, with a jewel beacon and curious teardrop eyes. */
  fable: () => (
    <>
      <path className="mascot-trim" d="m6.5 10.2-2-5.5 4.4 2.2L12 3.7l3.1 3.2 4.4-2.2-2 5.5Z" />
      <path className="mascot-lamp" d="m12 2.1 1.5 1.8L12 5.7l-1.5-1.8Z" />
      <path className="mascot-head mascot-shell" d="M7.1 9.1h9.8l3 2.6-.5 5.2c-.3 2.3-3.5 4-7.4 4.8-3.9-.8-7.1-2.5-7.4-4.8l-.5-5.2Z" />
      <path className="mascot-faceplate" d="M7.8 11.2h8.4l1.6 1.4-.4 3.7c-.1 1.5-2.2 2.8-5.4 3.5-3.2-.7-5.3-2-5.4-3.5l-.4-3.7Z" />
      <path className="mascot-eye" d="M9.2 12.5c.9.7 1.5 1.5 1.5 2.3a1.5 1.5 0 0 1-3 0c0-.8.6-1.6 1.5-2.3Z" />
      <path className="mascot-eye is-right" d="M14.8 12.5c.9.7 1.5 1.5 1.5 2.3a1.5 1.5 0 0 1-3 0c0-.8.6-1.6 1.5-2.3Z" />
      <path className="mascot-grin" d="M10.6 17.4h2.8c-.2 1.5-2.6 1.5-2.8 0Z" />
    </>
  ),

  /** Claude default: the hearth keeper. A broad capsule, low cheek pods
   *  and a small asterisk beacon make a warm provider-level companion. */
  claude: () => (
    <>
      <path className="mascot-trim" d="M5.4 14.6H2.1v2.2A2.2 2.2 0 0 0 4.3 19h2.2Zm13.2 0h3.3v2.2a2.2 2.2 0 0 1-2.2 2.2h-2.2Z" />
      <rect className="mascot-head mascot-shell" x="3.8" y="7.1" width="16.4" height="14.1" rx="6.4" />
      <path className="mascot-lamp" d="M11.3 2.6h1.4v1.8l1.6-.9.7 1.2-1.6.9 1.6.9-.7 1.2-1.6-.9v1.8h-1.4V6.8l-1.6.9L9 6.5l1.6-.9L9 4.7l.7-1.2 1.6.9Z" />
      <rect className="mascot-faceplate" x="5.8" y="10.7" width="12.4" height="8.3" rx="3.7" />
      <rect className="mascot-eye" x="7.6" y="12.6" width="2.8" height="2.9" rx="1.2" />
      <rect className="mascot-eye is-right" x="13.6" y="12.6" width="2.8" height="2.9" rx="1.2" />
      <path className="mascot-grin" d="M10.5 16.5h3c-.1 1.4-2.9 1.4-3 0Z" />
    </>
  ),

  /* ---- Codex -------------------------------------------------------- */

  /** Astra: a star navigator. Swept winglets and a faceted helmet frame a
   *  wide flight visor; the four-point beacon stays clear of the shell. */
  astra: () => (
    <>
      <path className="mascot-trim" d="M4.7 10.9 1.9 8.6 2.8 15.4 5.3 16.2ZM19.3 10.9 22.1 8.6 21.2 15.4 18.7 16.2Z" />
      <path className="mascot-stalk" d="M12 7.8V6.7" />
      <path
        className="mascot-lamp"
        d="M12 1.8 13 3.5 14.7 4.5 13 5.5 12 7.2 11 5.5 9.3 4.5 11 3.5Z"
      />
      <path className="mascot-head mascot-shell" d="M8 7.8h8l4 4v5.4L16.2 21H7.8L4 17.2v-5.4Z" />
      <path className="mascot-faceplate" d="M8.2 10.5h7.6l2.4 2.3v3.5l-2 1.9H7.8l-2-1.9v-3.5Z" />
      <path className="mascot-eye" d="m7.5 12.7 2.8-.5v3.4H7.5Z" />
      <path className="mascot-eye is-right" d="m13.7 12.2 2.8.5v2.9h-2.8Z" />
      <path className="mascot-detail" d="M10.3 19.7h3.4" />
    </>
  ),

  /** Sol: a sunny mechanic. A round, ray-crowned shell, circular ear caps
   *  and an open grin make the warmest face in the crew. */
  sol: () => (
    <>
      <path className="mascot-detail" d="m5.8 7.1-1.2-1.5m13.6 1.5 1.2-1.5M8.4 5.1l-.6-1.7m8.4 0-.6 1.7" />
      <path className="mascot-stalk" d="M12 6V3.5" />
      <circle className="mascot-lamp" cx="12" cy="2.9" r="1.3" />
      <rect className="mascot-trim" x="1.5" y="11" width="4" height="5.7" rx="2" />
      <rect className="mascot-trim" x="18.5" y="11" width="4" height="5.7" rx="2" />
      <rect className="mascot-head mascot-shell" x="4" y="6.2" width="16" height="15.2" rx="7.5" />
      <rect className="mascot-faceplate" x="6" y="9.6" width="12" height="9.2" rx="4.5" />
      <rect className="mascot-eye" x="7.7" y="11.4" width="2.8" height="3.5" rx="1.4" />
      <rect className="mascot-eye is-right" x="13.5" y="11.4" width="2.8" height="3.5" rx="1.4" />
      <path className="mascot-grin" d="M9.6 16.2h4.8a2.5 2.5 0 0 1-4.8 0Z" />
    </>
  ),

  /** Terra: a sturdy survey rover. Twin beacons, tread-like ear guards and
   *  a low square jaw give it weight without crowding the little face. */
  terra: () => (
    <>
      <path className="mascot-stalk" d="M8 8V5.4m8 2.6V5.4" />
      <rect className="mascot-lamp" x="6.2" y="3.5" width="3.6" height="2.4" rx="1" />
      <rect className="mascot-lamp is-right" x="14.2" y="3.5" width="3.6" height="2.4" rx="1" />
      <rect className="mascot-trim" x="1.5" y="10.8" width="3.8" height="8.6" rx="1.5" />
      <rect className="mascot-trim" x="18.7" y="10.8" width="3.8" height="8.6" rx="1.5" />
      <path className="mascot-head mascot-shell" d="M6.8 7.9h10.4L20 11v7.7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V11Z" />
      <rect className="mascot-faceplate" x="6" y="10.9" width="12" height="7.3" rx="1.8" />
      <rect className="mascot-eye" x="7.6" y="12.3" width="3" height="3" rx="0.7" />
      <rect className="mascot-eye is-right" x="13.4" y="12.3" width="3" height="3" rx="0.7" />
      <path className="mascot-grin" d="M10.4 16.5h3.2v1h-3.2Z" />
      <path className="mascot-detail" d="M9 19.6h6" />
    </>
  ),

  /** Luna: a nimble lunar scout. The crescent is part of its helmet, with
   *  one round comms pod and a relaxed pair of half-moon eyes. */
  luna: () => (
    <>
      <circle className="mascot-trim" cx="3.8" cy="14.6" r="2.3" />
      <path className="mascot-head mascot-shell" d="M16.6 4.4c-1.1 3.2.6 5.6 3.6 5.9.4.9.6 2 .6 3 0 4.6-3.5 7.8-8.1 7.8s-8.2-3.2-8.2-7.8C4.5 8.4 8 4 12.7 4c1.4 0 2.7.1 3.9.4Z" />
      <path className="mascot-faceplate" d="M7.9 10.6c2.1-.7 3.6.4 5.3.7 1.8.4 3.6.2 5.1-.2l-.1 3.9c-.1 2.7-2.5 4.5-5.8 4.5S6 17.8 6 15.1v-1.5c0-1.4.6-2.5 1.9-3Z" />
      <path className="mascot-eye" d="M7.6 14.8v-.7a1.5 1.5 0 0 1 3 0v.7Z" />
      <path className="mascot-eye is-right" d="M13.5 14.8v-.7a1.5 1.5 0 0 1 3 0v.7Z" />
      <path className="mascot-grin" d="M11.1 17h2.8c-.2 1.4-2.5 1.4-2.8 0Z" />
      <path className="mascot-lamp" d="m20.2 3 .7 1.5 1.5.7-1.5.7-.7 1.5-.7-1.5-1.5-.7 1.5-.7Z" />
    </>
  ),

  /** Codex default: a pocket terminal. Bracket-shaped ears, chevron eyes
   *  and a cursor mouth identify the provider before the CLI picks a model. */
  codex: () => (
    <>
      <path className="mascot-detail" d="M3.6 10H1.7v7h1.9m16.8-7h1.9v7h-1.9" />
      <path className="mascot-stalk" d="M12 6.5V4.6" />
      <rect className="mascot-lamp" x="9.8" y="2.8" width="4.4" height="2.3" rx="1.1" />
      <rect className="mascot-head mascot-shell" x="4" y="6.8" width="16" height="14.4" rx="3.2" />
      <rect className="mascot-faceplate" x="6" y="9.3" width="12" height="9.2" rx="1.8" />
      <path className="mascot-eye" d="m9.8 10.7 1 1.1-1.8 1.7 1.8 1.7-1 1.1-3-2.8Z" />
      <path className="mascot-eye is-right" d="m14.2 10.7-1 1.1 1.8 1.7-1.8 1.7 1 1.1 3-2.8Z" />
      <path className="mascot-grin" d="M10.5 17h3v1h-3Z" />
    </>
  ),

  /* ---- pi.dev with OpenAI Codex ----------------------------------- */

  "pi-astra": () => <PiRobot base="astra" />,
  "pi-sol": () => <PiRobot base="sol" />,
  "pi-terra": () => <PiRobot base="terra" />,
  "pi-luna": () => <PiRobot base="luna" />,
  pi: () => <PiRobot base="codex" />,
};

export function Mascot({
  robot = "sonnet",
  size = 18,
  alert = false,
  mood = "work",
  asleep = false,
}: {
  /** Which model presentation to draw — the chosen model's `composerStyle`. Defaults
   *  to Sonnet's, the shape this drawing started as, so a caller that has no
   *  model in hand still gets a robot rather than nothing. */
  robot?: ComposerStyle;
  size?: number;
  /** Something the turn started is STILL running behind it. The eyes go
   *  warn-coloured and carry that on the robot's face, which is what lets the
   *  orange dot that used to pulse beside it stop being drawn — see
   *  `BackgroundNote`. Only the eyes change: the lamp stays accent because it
   *  means "this turn is alive", which is still true and is not this news. */
  alert?: boolean;
  /** `work` is the full dance, `think` the same steps slower and smaller —
   *  reasoning is not the same activity as running a build and does not look
   *  like it — and `still` is a robot standing there. */
  mood?: MascotMood;
  /** No live process behind this one — swept by the idle reaper, or never
   *  started this session. Closes both eyes (the blink's own shut frame, held
   *  instead of released) and pins a small z to the corner. A wrapper only
   *  exists in this case, so every other caller keeps the bare `<svg>` it had
   *  before. */
  asleep?: boolean;
}) {
  const Draw = ROBOTS[robot] ?? ROBOTS.sonnet;
  const svg = (
    // Decorative: the words immediately after it say "thinking with max effort"
    // and how long it has been at it. A reader who cannot see the robot loses a
    // joke, not a fact, and a second "Working" announced here would be read out
    // over the top of the line that says it properly.
    <svg
      className={`mascot ${alert ? "is-alert" : ""} ${asleep ? "is-asleep" : ""}`}
      data-robot={robot}
      data-mood={mood}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      {/* Every weight here was picked against the 18px RASTER, not the drawing.
          A thinner first cut looked identical on a retina screen and lost both
          the smile and the ears to grey smudge at 1x — so the strokes are a
          notch heavier than they need to be at size, which costs nothing where
          there are pixels to spare and is the whole face where there are not. */}
      <g className="mascot-body">
        <Draw />
      </g>
    </svg>
  );
  if (!asleep) return svg;
  return (
    <span className="mascot-wrap">
      {svg}
      <span className="mascot-z" aria-hidden="true">
        z
      </span>
    </span>
  );
}
