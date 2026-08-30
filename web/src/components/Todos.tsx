// The plan, held just above the chat box.
//
// It belongs to the conversation rather than the window chrome: when an agent
// is working, the next step is most useful at the point where someone might
// send a follow-up. The closed state is deliberately only one compact pill;
// opening it reveals the complete checklist upward, without pushing the
// composer away from the bottom of the chat.
//
// It costs no round trip. The agent's `todo_write` call travels down the chat
// stream like any other tool call, and this reads the newest one back out of
// the transcript — so it survives a reload the way the transcript does.
import { useEffect, useRef, useState } from "react";
import { todoLook, type Todo } from "../lib/todos";
import { RollingText } from "./RollingNumber";

export function Todos({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  // Opened by a CLICK, which means it stays until it is closed. A hover-opened
  // dropdown that would not go away when the pointer left would be a trap, and
  // one that closed under a pointer you had deliberately clicked would be worse.
  const [pinned, setPinned] = useState(false);
  const look = todoLook(todos);

  // A quiet nudge when the list moves on. The pill is intentionally modest, but
  // a progress change should still be noticeable without competing with chat.
  const [moved, setMoved] = useState(false);
  const before = useRef(look.done);
  useEffect(() => {
    if (look.done === before.current) return;
    before.current = look.done;
    setMoved(true);
    const timer = setTimeout(() => setMoved(false), 900);
    return () => clearTimeout(timer);
  }, [look.done]);

  const close = () => {
    setOpen(false);
    setPinned(false);
  };

  if (todos.length === 0) return null;

  return (
    <div
      className="plan"
      // Mouse only. A touch "hover" is the tap that is already handled below,
      // and letting it through opened the list twice and closed it again.
      onPointerEnter={(e) => e.pointerType === "mouse" && setOpen(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && !pinned && setOpen(false)}
    >
      <button
        className={`plan-btn ${open ? "is-on" : ""} ${look.finished ? "is-done" : ""}`}
        type="button"
        aria-expanded={open}
        aria-label={`The plan — ${look.done} of ${look.total} done`}
        title={look.finished ? "The plan — all done" : look.current || "The plan"}
        onClick={() => {
          setPinned(!open || !pinned);
          setOpen(!open || !pinned);
        }}
      >
        <span className="plan-state" aria-hidden="true" />
        <span className={`plan-count ${moved ? "is-moved" : ""}`}>
          <RollingText>
            {look.finished
              ? `All ${look.total} steps done`
              : `Step ${Math.min(look.done + 1, look.total)} / ${look.total}`}
          </RollingText>
        </span>
      </button>

      {open && (
        <>
          {/* Tapping anywhere off it puts it away — the only way out on a
              touchscreen, where there is no pointer to leave. */}
          <div className="plan-scrim" onClick={close} />
          <div className="plan-pop" role="dialog" aria-label="The plan">
            <div className="plan-pop-head">
              <span className="plan-pop-title">The plan</span>
              <span className="plan-pop-count">
                <RollingText>{`${look.done}/${look.total}`}</RollingText>
              </span>
              {/* The close button is useful on touch screens, where there is no
                  pointer leaving the card. */}
              <button className="plan-pop-close" type="button" aria-label="Close" onClick={close}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <ol className="todos-list">
              {todos.map((t, i) => (
                <li className={`todo is-${t.status}`} key={`${i}-${t.content}`}>
                  <span className="todo-mark" aria-hidden="true" />
                  <span className="todo-text">
                    {t.status === "in_progress" ? t.activeForm || t.content : t.content}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </div>
  );
}
