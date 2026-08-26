import type React from "react";

/** A table, in a box that scrolls sideways on its own.
 *
 *  A table is the one markdown block that cannot be made narrower than its
 *  content: whatever the column it sits in, the cells set a floor, and past
 *  that the table simply sticks out of the page. Every surface that draws
 *  markdown here deliberately scrolls ONE way — the transcript because an
 *  over-wide child used to drag the whole app across on a phone and take the
 *  header and composer with it, a file because a document is read down. So a
 *  table wider than its column has nowhere to go: it is cut off at the edge,
 *  with nothing to say the rest of it is there.
 *
 *  The box is what gives it somewhere to go. Inside it the table keeps its own
 *  width and is scrolled to; outside it nothing moves. It belongs to no one
 *  surface, which is why it lives here rather than beside the transcript: the
 *  chat and the file view both pass it to `react-markdown` as `table`. */
export function ProseTable({ children }: { children?: React.ReactNode }) {
  return (
    <div className="prose-table">
      <table>{children}</table>
    </div>
  );
}
