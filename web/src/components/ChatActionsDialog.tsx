import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { Conversation } from "../lib/store";

/** Native modal focus containment, above the scrolling project list. */
export function ChatActionsDialog({ chat, onClose, onRename, onPin, onDelete }: {
  chat: Conversation;
  onClose: () => void;
  onRename: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropPress = useRef(false);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const resized = () => close.current();
    window.addEventListener("resize", resized);
    return () => { element.close(); window.removeEventListener("resize", resized); };
  }, []);

  const dismiss = () => {
    // Close while still connected so the browser can restore the opener's focus.
    dialog.current?.close();
    onClose();
  };
  const act = (action: () => void) => {
    dismiss();
    action();
  };

  return createPortal(
    <dialog ref={dialog} className="chat-actions-dialog" aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); dismiss(); }}
      onPointerDown={(event) => { backdropPress.current = event.target === event.currentTarget; }}
      onClick={(event) => {
        // A hold begins on the chat underneath this dialog. Its release must
        // not immediately dismiss the menu it just opened.
        if (backdropPress.current && event.target === event.currentTarget) dismiss();
        backdropPress.current = false;
      }}>
      <div className="chat-actions-content">
        <strong id={titleId}>{chat.title}</strong>
        <button type="button" onClick={() => act(onRename)}>Rename chat</button>
        <button type="button" onClick={() => act(onPin)}>{chat.pinned ? "Unpin chat" : "Pin chat"}</button>
        <button type="button" className="is-danger" onClick={() => act(onDelete)}>Delete chat</button>
        <button type="button" onClick={dismiss}>Cancel</button>
      </div>
    </dialog>, document.body,
  );
}
