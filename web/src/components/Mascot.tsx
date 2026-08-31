/** The little robot that sits at the head of the status line while a turn runs.
 *
 *  It is drawn rather than shipped as a picture, for the same reasons
 *  `AgentLogo` is: the office cast in `assets/agents/` are megabyte PNGs of
 *  people, unreadable at this size and unthemeable, and a mark that has to work
 *  in every pasted theme has to be able to take its colours from one.
 *
 *  THREE things move on it, which sounds like exactly what was just taken off
 *  this screen — it is not. Those were three separate marks each answering "is
 *  it alive?" in a different corner. These are three parts of ONE creature, and
 *  a creature that only blinked, or only bobbed, would read as a broken loop
 *  rather than as something alive. The eye is a character; the eye is not a
 *  spinner.
 *
 *  It draws only while a turn is in flight, which is what buys it its accent:
 *  the lamp and the eyes are the one colour on this line that means "running
 *  right now", and they are three pixels across, so they say it without
 *  competing with the tool spinner that means "and this is the call".
 *
 *  The bob is animated on the inner `<g>`, never on the `<svg>` — the line it
 *  sits in clips its overflow to keep its ellipsis, so a robot that moved the
 *  whole box would have its antenna shaved off at the top of every float. The
 *  drawing keeps a unit of headroom inside the viewBox instead, and moves
 *  around inside a box that never moves.
 */
export function Mascot({ size = 18 }: { size?: number }) {
  return (
    // Decorative: the words immediately after it say "thinking with max effort"
    // and how long it has been at it. A reader who cannot see the robot loses a
    // joke, not a fact, and a second "Working" announced here would be read out
    // over the top of the line that says it properly.
    <svg
      className="mascot"
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
      </g>
    </svg>
  );
}
