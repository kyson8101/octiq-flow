// In-flight paste saves, kept per drafts store (moved verbatim from Composer.tsx).
import type { Drafts } from "./drafts";
import type { Attachment } from "../components/Composer";

export type PasteSaveResult = { attachment: Attachment } | { text: string; error?: string } | { error: string | null };
export type PasteSave = { pending: number; error?: string; receive?: (pending: number, result?: PasteSaveResult) => void };
export type PasteOwner = { store: Drafts<Attachment>; session?: string };
// The parent-owned drafts outlive a composer hidden by a read-only chat. Its
// in-flight saves must outlive that mount too, and reach the current owner.
export const pasteSaves = new WeakMap<Drafts<Attachment>, Map<string | undefined, PasteSave>>();
export function pasteSaveFor(store: Drafts<Attachment>, session?: string): PasteSave {
  let chats = pasteSaves.get(store);
  if (!chats) { chats = new Map(); pasteSaves.set(store, chats); }
  let save = chats.get(session);
  if (!save) { save = { pending: 0 }; chats.set(session, save); }
  return save;
}

/** Register `receive` on a chat's paste save, hand it what arrived while no
 *  mount listened, and return the cleanup. A module-level function on purpose:
 *  the cleanup React keeps for as long as the effect's deps hold would
 *  otherwise be a closure of the Composer render the effect last ran in, and
 *  with it that render's props (`onPutBack` is an App render's closure, which
 *  holds `chats`). Here it holds only `save` and `receive`. */
export function bindPasteSave(save: PasteSave, receive: NonNullable<PasteSave["receive"]>, onError: (error: string | null) => void): () => void {
  save.receive = receive;
  receive(save.pending);
  if (save.error) { onError(save.error); save.error = undefined; }
  return () => { if (save.receive === receive) save.receive = undefined; };
}

/** Deliver through the origin's current mount, or keep it in that chat's
 *  draft until it returns. Never consult whichever chat is now on screen. */
export function deliverPaste(owner: PasteOwner, result: PasteSaveResult): void {
  const save = pasteSaveFor(owner.store, owner.session);
  if (save.receive) { save.receive(save.pending, result); return; }
  if ("attachment" in result || "text" in result) {
    const back = owner.store.take(owner.session);
    owner.store.keep(owner.session, "attachment" in result
      ? { ...back, attached: [...back.attached, result.attachment] }
      : { ...back, text: back.text + result.text });
  }
  if ("error" in result) save.error = result.error ?? undefined;
}
