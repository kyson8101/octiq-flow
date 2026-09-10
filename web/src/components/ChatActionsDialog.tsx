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

  const act = (action: () => void) => {
    // Restore the trigger's focus before Rename mounts its autofocus field.
    dialog.current?.close();
    onClose();
    action();
  };

  return createPortal(
    <dialog ref={dialog} className="chat-actions-dialog" aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="chat-actions-content">
        <strong id={titleId}>{chat.title}</strong>
        <button type="button" onClick={() => act(onRename)}>Rename chat</button>
        <button type="button" onClick={() => act(onPin)}>{chat.pinned ? "Unpin chat" : "Pin chat"}</button>
        <button type="button" className="is-danger" onClick={() => act(onDelete)}>Delete chat</button>
        <button type="button" onClick={onClose}>Cancel</button>
      </div>
    </dialog>, document.body,
  );
}
