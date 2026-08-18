// The prompt box: type, pick a model, send.
//
// Enter sends and Shift+Enter makes a new line, the shape every agent chat
// uses. The field is 16px because anything smaller makes iOS Safari zoom the
// page the moment it takes focus.
import { useEffect, useRef, useState } from "react";

export type ModelChoice = {
  id: string;
  agent: "claude" | "codex";
  name: string;
  model: string;
  /** What the backend passes as --model / -m. Empty = the agent's own default. */
  flag: string;
};

export const MODELS: ModelChoice[] = [
  { id: "claude:opus", agent: "claude", name: "Claude", model: "Opus", flag: "opus" },
  { id: "claude:sonnet", agent: "claude", name: "Claude", model: "Sonnet", flag: "sonnet" },
  { id: "claude:haiku", agent: "claude", name: "Claude", model: "Haiku", flag: "haiku" },
  { id: "claude:fable", agent: "claude", name: "Claude", model: "Fable", flag: "fable" },
  { id: "claude:default", agent: "claude", name: "Claude", model: "Default", flag: "" },
  { id: "codex:default", agent: "codex", name: "Codex", model: "Default", flag: "" },
];

export function Composer({
  choice,
  onChoice,
  onSend,
  busy,
  disabled,
}: {
  choice: ModelChoice;
  onChoice: (c: ModelChoice) => void;
  onSend: (text: string) => void;
  busy: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a few lines, then scroll inside.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  function send() {
    const value = text.trim();
    if (!value || disabled) return;
    onSend(value);
    setText("");
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={areaRef}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={disabled ? "Pick a project first" : `Ask ${choice.name} to…`}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-row">
          <div className="picker">
            <button
              className="picker-btn"
              type="button"
              aria-haspopup="menu"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
            >
              {choice.name} · {choice.model}
              <span className="picker-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            {menu && (
              <>
                <div className="picker-scrim" onClick={() => setMenu(false)} />
                <div className="picker-menu" role="menu">
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      role="menuitem"
                      className={`picker-item ${m.id === choice.id ? "is-on" : ""}`}
                      onClick={() => {
                        onChoice(m);
                        setMenu(false);
                      }}
                    >
                      <span className="picker-name">{m.name}</span>
                      <span className="picker-model">{m.model}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <span className="composer-hint">{busy ? "working…" : "Enter to send"}</span>

          <button
            className="send"
            type="button"
            title="Send"
            disabled={!text.trim() || !!disabled}
            onClick={send}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m5 12 7-7 7 7" />
              <path d="M12 19V5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
