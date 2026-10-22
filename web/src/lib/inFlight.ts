// A request that is out and not answered yet, by what it is about.
//
// A component may unmount and return while its request is still pending.
// Keep the request outside the component, under the key of the thing asked
// about, so every mounted control shares the same answer and the sender
// refuses a duplicate request. A reload forgets this page's state; the
// host still enforces its own rules for requests such as gate answers.
import { useSyncExternalStore } from "react";

const out = new Set<string>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of [...listeners]) listener();
}

/** Whether a request about `key` is out. */
export function inFlight(key: string): boolean {
  return out.has(key);
}

/** What `once` answers when it sent nothing: a request about the same thing
 *  is already out. */
export const IN_FLIGHT = Symbol("in flight");

/** Run `send` unless a request about `key` is out, and hold the key until it
 *  settles, however it settles. Taken in the same step as it is asked, so
 *  two presses in one frame are one request. */
export async function once<T>(key: string, send: () => Promise<T>): Promise<T | typeof IN_FLIGHT> {
  if (out.has(key)) return IN_FLIGHT;
  out.add(key);
  changed();
  try {
    return await send();
  } finally {
    out.delete(key);
    changed();
  }
}

export function subscribeFlights(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Whether a request about `key` is out, for a control to draw itself by. */
export function useInFlight(key: string | null): boolean {
  const read = () => (key ? out.has(key) : false);
  // The same answer for a first draw as for any other: it is this page's
  // own memory, and a control must not be drawn on for a frame.
  return useSyncExternalStore(subscribeFlights, read, read);
}

/** What a gate's answer is asked under: its options and its written answer
 *  share it. */
export const gateFlight = (gateId: string) => `gate:${gateId}`;
