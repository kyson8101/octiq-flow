// A request that is out and not answered yet, by what it is about.
//
// "Off from the press until its answer" was a control's own state, and a
// control unmounts: the Plan panel's Start was pressed, the panel was shut
// and opened again, and the new control knew nothing of the request still
// out, so the same Start was sent twice. What is in flight is kept here
// instead, outside every component, under a key that names the thing asked
// about (a chat's plan, a gate) and not the control that asked. Whatever
// draws a control for that thing reads the same answer, however often it is
// mounted and from however many surfaces, and the sender itself refuses a
// second request while the first is out.
//
// In memory, for this page. A reload forgets it, and so does the host's
// answer to a request the reload cut off; the host's own rule is what holds
// then (one Start is one turn, a resolved gate is refused).
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

/** What a chat's plan is asked under: its Start and its `Tell the agent`
 *  are one command and share it. */
export const planFlight = (chatId: string) => `plan-start:${chatId}`;

/** What a gate's answer is asked under: its options and its written answer
 *  share it. */
export const gateFlight = (gateId: string) => `gate:${gateId}`;
