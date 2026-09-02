import type { ReactElement } from "react";
import type { ComposerStyle } from "../lib/agentProviders";

/** The little robots — one per model, nine of them.
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
 *  ## Why nine
 *
 *  A model is already a visual voice here — `ComposerStyle` gives each one its
 *  accent and the composer wears it. The robot is that same fact said as a
 *  face, which is the one form of it you can recognise without reading: you
 *  learn what Haiku looks like once and then you know, mid-turn, from the
 *  corner of your eye, which model is doing the work. So the SILHOUETTES
 *  differ, not just the paint — a recolour of one body would be nine robots
 *  that are all the same robot, and the colour is already carrying that.
 *
 *  Every variant keeps the same part names (`mascot-head`, `mascot-eye`,
 *  `mascot-lamp`, …) so one stylesheet dresses and animates all nine, and
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

/** The nine drawings. Keyed by `ComposerStyle` so adding a model means drawing
 *  its robot in the same breath as choosing its colour — a model that skipped
 *  one would not compile. */
const ROBOTS: Record<ComposerStyle, () => ReactElement> = {
  /* ---- Claude ------------------------------------------------------- */

  /** Opus: the thinker. Tall domed head, a halo instead of an antenna lamp,
   *  round dish ears, and a level mouth — it is considering something. */
  opus: () => (
    <>
      <ellipse className="mascot-lamp is-halo" cx="12" cy="4.1" rx="4.6" ry="1.6" />
      <path className="mascot-stalk" d="M12 7.4V5.6" />
      <circle className="mascot-ear" cx="3.2" cy="13.6" r="1.5" />
      <circle className="mascot-ear" cx="20.8" cy="13.6" r="1.5" />
      <rect className="mascot-head" x="4.7" y="7.4" width="14.6" height="13" rx="7" />
      <circle className="mascot-eye" cx="9.1" cy="13.1" r="1.95" />
      <circle className="mascot-eye is-right" cx="14.9" cy="13.1" r="1.95" />
      <path className="mascot-smile" d="M10.3 17.5h3.4" />
    </>
  ),

  /** Sonnet: the original robot, and deliberately unchanged. It is the model
   *  most turns run on, so it is the one shape people already know. */
  sonnet: () => (
    <>
      <path className="mascot-stalk" d="M12 6.5V4.9" />
      <circle className="mascot-lamp" cx="12" cy="3.2" r="1.55" />
      {/* Side panels. They read as ears, which is most of what stops this
          being a rounded rectangle with two dots in it. */}
      <rect className="mascot-ear" x="0.9" y="11" width="2.7" height="4.4" rx="1.35" />
      <rect className="mascot-ear" x="20.4" y="11" width="2.7" height="4.4" rx="1.35" />
      <rect className="mascot-head" x="3.4" y="6.5" width="17.2" height="13.8" rx="5" />
      {/* Set a hair BELOW the middle of the head and drawn large. Both are
          the whole difference between a face that is cute and a face that is
          watching you. */}
      <circle className="mascot-eye" cx="8.8" cy="12.9" r="2" />
      <circle className="mascot-eye is-right" cx="15.2" cy="12.9" r="2" />
      <path className="mascot-smile" d="M10 17q2 1.4 4 0" />
    </>
  ),

  /** Haiku: everything swept back. Low wide head, fins rather than ears, one
   *  antenna raked over its shoulder, small eyes and a clipped mouth. It is
   *  the fastest model and it is drawn already moving. */
  haiku: () => (
    <>
      <path className="mascot-stalk" d="M15.4 9.6 18.7 5.9" />
      <circle className="mascot-lamp" cx="19.4" cy="4.9" r="1.4" />
      <path className="mascot-ear" d="M3 11.6 0.7 10.1V16.5Z" />
      <path className="mascot-ear" d="M21 11.6 23.3 10.1V16.5Z" />
      <rect className="mascot-head" x="2.9" y="9.2" width="18.2" height="10.6" rx="4.2" />
      <circle className="mascot-eye" cx="8.6" cy="13.7" r="1.6" />
      <circle className="mascot-eye is-right" cx="15.4" cy="13.7" r="1.6" />
      <path className="mascot-smile" d="M10.4 17.2h3.2" />
    </>
  ),

  /** Fable: a shield of a head under a three-spike crest, and tall oval eyes.
   *  The only one with no ears — the crest is its whole silhouette, and a
   *  drawing this narrow at the chin cannot carry both. */
  fable: () => (
    <>
      <path className="mascot-stalk" d="M8.5 8.2V5.4" />
      <path className="mascot-stalk" d="M12 6.9V3.9" />
      <path className="mascot-stalk" d="M15.5 8.2V5.4" />
      <circle className="mascot-lamp" cx="12" cy="2.7" r="1.35" />
      <path className="mascot-head" d="M12 6.9 20.4 10.6V17.3L12 21 3.6 17.3V10.6Z" />
      <ellipse className="mascot-eye" cx="9.2" cy="13.4" rx="1.7" ry="2.1" />
      <ellipse className="mascot-eye is-right" cx="14.8" cy="13.4" rx="1.7" ry="2.1" />
      <path className="mascot-smile" d="M10.1 17.4q1.9 1.2 3.8 0" />
    </>
  ),

  /** Claude's CLI default: the plainest robot on the shelf. No antenna at all
   *  — a single lamp set in its forehead — because this tile does not know
   *  which model the CLI is about to choose, and a robot that claimed a
   *  character it had not been given would be the one lie in the set. */
  claude: () => (
    <>
      <rect className="mascot-ear" x="1.4" y="12" width="2.2" height="4.2" rx="1.1" />
      <rect className="mascot-ear" x="20.4" y="12" width="2.2" height="4.2" rx="1.1" />
      <rect className="mascot-head" x="4" y="7.6" width="16" height="12.6" rx="6.3" />
      {/* A bar, not a bulb. A round lamp sat here reads as a third eye at
          eighteen pixels — the two below it are round and the same colour, and
          the head is round, so the eye wins the argument every time. */}
      <rect className="mascot-lamp" x="10.2" y="9.9" width="3.6" height="1.7" rx="0.85" />
      <circle className="mascot-eye" cx="9" cy="14.7" r="1.8" />
      <circle className="mascot-eye is-right" cx="15" cy="14.7" r="1.8" />
      <path className="mascot-smile" d="M10.2 18.2q1.8 1.1 3.6 0" />
    </>
  ),

  /* ---- Codex -------------------------------------------------------- */

  /** Sol: a round head wearing a crown of rays, and the widest grin of the
   *  nine. The rays are the antenna — the top one carries the lamp, so the
   *  same "this turn is alive" pulse reads here as the sun coming up. */
  sol: () => (
    <>
      <path className="mascot-stalk" d="M12 5.4V3.9" />
      <path className="mascot-stalk" d="M16.1 6.5 17 5.1" />
      <path className="mascot-stalk" d="M7.9 6.5 7 5.1" />
      <path className="mascot-stalk" d="M19.1 9.5 20.6 8.6" />
      <path className="mascot-stalk" d="M4.9 9.5 3.4 8.6" />
      <circle className="mascot-lamp" cx="12" cy="2.8" r="1.3" />
      <circle className="mascot-head" cx="12" cy="13.6" r="7" />
      <circle className="mascot-eye" cx="9.3" cy="13.3" r="1.9" />
      <circle className="mascot-eye is-right" cx="14.7" cy="13.3" r="1.9" />
      <path className="mascot-smile" d="M9.6 17.1q2.4 1.7 4.8 0" />
    </>
  ),

  /** Terra: the rover. Squat, wide, two stubby antennae and square eyes — the
   *  only right angles in the set, which is how it reads as built rather than
   *  grown even when it is eighteen pixels of grey. */
  terra: () => (
    <>
      <path className="mascot-stalk" d="M7.6 9V6.6" />
      <path className="mascot-stalk" d="M16.4 9V6.6" />
      <circle className="mascot-lamp" cx="7.6" cy="5.5" r="1.25" />
      <circle className="mascot-lamp is-right" cx="16.4" cy="5.5" r="1.25" />
      <rect className="mascot-ear" x="0.8" y="12.2" width="2" height="4" rx="1" />
      <rect className="mascot-ear" x="21.2" y="12.2" width="2" height="4" rx="1" />
      <rect className="mascot-head" x="2.7" y="9" width="18.6" height="11" rx="3.2" />
      <rect className="mascot-eye" x="7.1" y="12.1" width="3.4" height="3.4" rx="1" />
      <rect className="mascot-eye is-right" x="13.5" y="12.1" width="3.4" height="3.4" rx="1" />
      <path className="mascot-smile" d="M9.4 17.7q2.6 1.6 5.2 0" />
    </>
  ),

  /** Luna: a head with no antenna and a moon of its own, off its shoulder.
   *  Half-lidded eyes — flat-bottomed domes rather than discs — so the fast
   *  cheap model is the one that looks like it is barely trying. */
  luna: () => (
    <>
      <circle className="mascot-lamp" cx="19.7" cy="5.3" r="1.6" />
      <circle className="mascot-head" cx="11.4" cy="14" r="6.8" />
      <path className="mascot-eye" d="M7 14.7a2 2 0 0 1 4 0Z" />
      <path className="mascot-eye is-right" d="M11.8 14.7a2 2 0 0 1 4 0Z" />
      <path className="mascot-smile" d="M10 18q1.4 0.9 2.8 0" />
    </>
  ),

  /** Codex's CLI default: a visor, and the one face in the set with no mouth.
   *  Same reason as Claude's default — it does not know which model it is, so
   *  it is drawn as equipment rather than as somebody. */
  codex: () => (
    <>
      <path className="mascot-stalk" d="M12 7.8V5.8" />
      <circle className="mascot-lamp" cx="12" cy="4.5" r="1.4" />
      <rect className="mascot-ear" x="1.1" y="11.8" width="2.1" height="4.4" rx="1.05" />
      <rect className="mascot-ear" x="20.8" y="11.8" width="2.1" height="4.4" rx="1.05" />
      <rect className="mascot-head" x="3.2" y="7.8" width="17.6" height="12.6" rx="4" />
      <rect className="mascot-visor" x="5.7" y="11.1" width="12.6" height="4.6" rx="2.3" />
      <circle className="mascot-eye" cx="9.2" cy="13.4" r="1.35" />
      <circle className="mascot-eye is-right" cx="14.8" cy="13.4" r="1.35" />
    </>
  ),
};

export function Mascot({
  robot = "sonnet",
  size = 18,
  alert = false,
  mood = "work",
}: {
  /** Which of the nine to draw — the chosen model's `composerStyle`. Defaults
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
}) {
  const Draw = ROBOTS[robot] ?? ROBOTS.sonnet;
  return (
    // Decorative: the words immediately after it say "thinking with max effort"
    // and how long it has been at it. A reader who cannot see the robot loses a
    // joke, not a fact, and a second "Working" announced here would be read out
    // over the top of the line that says it properly.
    <svg
      className={`mascot ${alert ? "is-alert" : ""}`}
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
}
