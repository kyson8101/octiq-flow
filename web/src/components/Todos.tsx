// The plan, behind the counter in the top bar.
//
// An agent that takes a request and goes quiet gives the person waiting nothing
// to hold on to — being understood and being ignored look exactly the same. So
// the count is always on the bar, `4/5`, which answers "did it get my request"
// and "how far in is it" in five characters. The list itself is one tap under
// it, or one hover on a machine with a mouse.
//
// A dropdown rather than a panel because the plan is glanced at, not read: a
// column of its own said the same five characters and cost 14rem of the screen
// to say them, and on a phone there is no column to give.
//
// It costs no round trip. The agent's `todo_write` call travels down the chat
// stream like any other tool call, and this reads the newest one back out of
// the transcript — so it survives a reload the way the transcript does.
import { useEffect, useRef, useState } from "react";
import { todoLook, type Todo } from "../lib/todos";

export function Todos({ todos }: { todos: Todo[] }) {
  const [open, setOpen] = useState(false);
  // Opened by a CLICK, which means it stays until it is closed. A hover-opened
  // dropdown that would not go away when the pointer left would be a trap, and
  // one that closed under a pointer you had deliberately clicked would be worse.
  const [pinned, setPinned] = useState(false);
  const look = todoLook(todos);

  // A quiet nudge when the list moves on. The counter is five characters at the
  // edge of a busy bar, and a change that draws no attention at all is a change
  // nobody notices — but it is also not worth a bang, so it is a fade.
  const [moved, setMoved] = useState(false);
  const before = useRef(look.done);
  useEffect(() => {
    if (look.done === before.current) return;
    before.current = look.done;
    setMoved(true);
    const timer = setTimeout(() => setMoved(false), 900);
    return () => clearTimeout(timer);
  }, [look.done]);

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
        className={`icon-btn plan-btn ${open ? "is-on" : ""} ${look.finished ? "is-done" : ""}`}
        type="button"
        aria-expanded={open}
        aria-label={`The plan — ${look.done} of ${look.total} done`}
        title={look.finished ? "The plan — all done" : look.current || "The plan"}
        onClick={() => {
          setPinned(!open || !pinned);
          setOpen(!open || !pinned);
        }}
      >
        <span className={`plan-count ${moved ? "is-moved" : ""}`}>
          {look.done}/{look.total}
        </span>
      </button>

      {open && (
        <>
          {/* Tapping anywhere off it puts it away — the only way out on a
              touchscreen, where there is no pointer to leave. */}
          <div
            className="plan-scrim"
            onClick={() => {
              setOpen(false);
              setPinned(false);
            }}
          />
          <div className="plan-pop" role="dialog" aria-label="The plan">
            <div className="plan-pop-head">
              <span className="plan-pop-title">The plan</span>
              <span className="plan-pop-count">
                {look.done}/{look.total}
              </span>
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
