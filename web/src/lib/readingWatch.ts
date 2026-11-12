/** Tell `setReading` which chat is on screen now and whenever the page gains or
 *  loses focus or visibility; returns the cleanup that removes every listener.
 *
 *  This MUST stay outside any component's render scope. V8 shares one scope
 *  between the closures made in a render, so a listener made inside an effect
 *  of App keeps that render alive for as long as it is registered, and with it
 *  every transcript the render's `chats` held. Here `tell` holds only
 *  `conversationId` and `setReading`. */
export function watchReading(
  conversationId: string | null,
  setReading: (id: string | null) => void,
  win: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "hidden"> = document,
): () => void {
  const tell = () => setReading(doc.hidden ? null : conversationId);
  tell();
  win.addEventListener("focus", tell);
  win.addEventListener("blur", tell);
  doc.addEventListener("visibilitychange", tell);
  return () => {
    win.removeEventListener("focus", tell);
    win.removeEventListener("blur", tell);
    doc.removeEventListener("visibilitychange", tell);
  };
}
