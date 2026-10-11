// A thing that must push what is below it, coming in.
//
// Two boxes, always: the outer one is a one-row grid whose row opens from
// nothing, the inner one is what gets clipped while it does. A card cannot be
// its own inner box, because a box cannot be shorter than its own padding.
// The same two boxes are drawn whether or not this one is arriving, so being
// late is a class and never a different tree — nothing remounts on it.
//
// Who is late is `lib/arrival`'s to say. Left to itself this decides from
// `when`: there when this mounted, or not. A list hands `late` in instead,
// because each of its items mounts WITH its content and would never be late
// by its own account.
import { createContext, useContext, useState, type ReactNode } from "react";
import { useLate } from "../lib/useArrival";

/** Whether what the transcript is mounting right now was just said, as
 *  opposed to read back (`lib/arrival.liveSince`). The transcript hands down
 *  a new box only when the answer changes, so a delta re-renders no reader,
 *  and a reader takes the answer once, as it mounts. Off outside a
 *  transcript. */
export const LiveArrivals = createContext<{ current: boolean }>({ current: false });

/** The entry class for a block inside the conversation, decided once as it
 *  mounts: a block from history gets none, and keeps none. */
export function useLiveEntry(className = "enter-rise"): string {
  const live = useContext(LiveArrivals);
  const [entry] = useState(() => (live.current ? className : ""));
  return entry;
}

export function Arrive({
  when = true,
  late,
  scope,
  inline = false,
  className,
  children,
}: {
  /** Whether there is anything to draw. */
  when?: boolean;
  /** Said outright by a list that tracks its own arrivals. */
  late?: boolean;
  /** What the place is, when one mounted box serves several — a chat id. */
  scope?: string;
  /** Spans, for inside a button. */
  inline?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const own = useLate(when, scope);
  if (!when) return null;
  const Box = inline ? "span" : "div";
  return (
    <Box className={`arrive${late ?? own ? " is-late" : ""}${className ? ` ${className}` : ""}`}>
      <Box className="arrive-body">{children}</Box>
    </Box>
  );
}
