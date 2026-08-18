// The prompt box: type, pick a model, send.
//
// Enter sends and Shift+Enter makes a new line, the shape every agent chat
// uses. The field is 16px because anything smaller makes iOS Safari zoom the
// page the moment it takes focus.
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import { FolderPicker } from "./FolderPicker";

export type Provider = "claude" | "codex";

export type ModelChoice = {
  id: string;
  agent: Provider;
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
  { id: "codex:gpt5", agent: "codex", name: "Codex", model: "GPT-5.6", flag: "gpt-5.6-sol" },
  { id: "codex:default", agent: "codex", name: "Codex", model: "Default", flag: "" },
];

/** How much the agent may do without asking.
 *
 *  ONE question, asked once, because that is the decision being made — but the
 *  two agents answer to different flags: Claude to `--permission-mode`, Codex
 *  to `--sandbox`. The backend maps this level to whichever applies, so the
 *  spelling never reaches the UI.
 *
 *  This is NOT a hidden default. A chat has no channel for answering a
 *  permission prompt, so whatever is chosen here is what the agent will do
 *  unattended — and that has to be on screen, next to the send button. */
export type AccessLevel = "read" | "edit" | "full";

export const ACCESS: Record<Provider, { id: AccessLevel; label: string; hint: string }[]> = {
  claude: [
    { id: "read", label: "Read only", hint: "look and plan, change nothing" },
    { id: "edit", label: "Can edit", hint: "edit files without asking" },
    { id: "full", label: "Full access", hint: "run anything without asking" },
  ],
  codex: [
    { id: "read", label: "Read only", hint: "sandboxed, no writes" },
    { id: "edit", label: "Can edit", hint: "write inside the project only" },
    { id: "full", label: "Full access", hint: "no sandbox, no approvals" },
  ],
};

/** How hard the model thinks before answering.
 *
 *  Both agents have this and neither has the same levels: Codex has a `minimal`
 *  Claude lacks, Claude has a `max` Codex lacks. So the list is per provider,
 *  and the backend refuses anything outside the one it is given. */
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORTS: Record<Provider, { id: Effort; label: string; hint: string }[]> = {
  claude: [
    { id: "low", label: "Low", hint: "quick answers, least thinking" },
    { id: "medium", label: "Medium", hint: "the usual balance" },
    { id: "high", label: "High", hint: "thinks longer, costs more" },
    { id: "xhigh", label: "Very high", hint: "for problems worth the wait" },
    { id: "max", label: "Max", hint: "everything it has" },
  ],
  codex: [
    { id: "minimal", label: "Minimal", hint: "barely reasons, fastest" },
    { id: "low", label: "Low", hint: "quick answers" },
    { id: "medium", label: "Medium", hint: "the usual balance" },
    { id: "high", label: "High", hint: "thinks longer, costs more" },
    { id: "xhigh", label: "Very high", hint: "for problems worth the wait" },
  ],
};

/** The effort to use for a provider, given what is currently chosen. Falls back
 *  to Medium — which both offer — when the level does not exist over there. */
export function effortFor(provider: Provider, wanted: Effort): Effort {
  return EFFORTS[provider].some((e) => e.id === wanted) ? wanted : "medium";
}

export type Attachment = {
  path: string;
  name: string;
  isImage: boolean;
  /** A local object URL for the thumbnail, when the browser already holds the
   *  bytes (a paste or an upload). Absent for a file picked on the machine —
   *  that one is fetched instead. Owned by the composer, which revokes it. */
  url?: string;
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export function Composer({
  choice,
  onChoice,
  access,
  onAccess,
  onSend,
  onStop,
  busy,
  disabled,
  started,
  commands,
  contextTokens,
  contextWindow,
  effort,
  onEffort,
  cwd,
  onTerminal,
  terminalOpen,
}: {
  choice: ModelChoice;
  onChoice: (c: ModelChoice) => void;
  access: AccessLevel;
  onAccess: (a: AccessLevel) => void;
  onSend: (text: string, attachments: Attachment[]) => void;
  onStop: () => void;
  busy: boolean;
  disabled?: boolean;
  /** True once this conversation has turns in it. The model and the provider
   *  are fixed when the agent process spawns, so from here on picking another
   *  one opens a new chat — the menu says so rather than looking inert. */
  started?: boolean;
  /** The slash commands this agent accepts, reported by the session itself.
   *  Empty until a chat has run at least once in this project. */
  commands?: string[];
  /** How much of the model's context this session is holding, and its ceiling.
   *  Both absent until the first turn ends — the agent only reports them with
   *  its `result`. */
  contextTokens?: number;
  contextWindow?: number;
  effort: Effort;
  onEffort: (e: Effort) => void;
  /** The project folder, so the file picker opens where the work is. */
  cwd?: string;
  /** Show the shell drawer. Absent when there is no project to open one in. */
  onTerminal?: () => void;
  terminalOpen?: boolean;
}) {
  const [text, setText] = useState("");
  const [menu, setMenu] = useState(false);
  const [permMenu, setPermMenu] = useState(false);
  const [pick, setPick] = useState(0);
  // Every option list depends on which provider is chosen: the two agents do
  // not offer the same access wording or the same effort levels.
  const accessList = ACCESS[choice.agent];
  const effortList = EFFORTS[choice.agent];
  const perm = accessList.find((p) => p.id === access) ?? accessList[0];
  const eff = effortList.find((e) => e.id === effort) ?? effortList[Math.floor(effortList.length / 2)];
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [effMenu, setEffMenu] = useState(false);
  const [attached, setAttached] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [filePicker, setFilePicker] = useState(false);

  // The slash menu is open while the WHOLE input is one `/word` — a slash
  // deeper in a sentence is a path or a date, not a command.
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const matches =
    slashQuery === undefined
      ? []
      : (commands ?? [])
          .filter((c) => c.toLowerCase().startsWith(slashQuery.toLowerCase()))
          .slice(0, 40);
  const slashOpen = matches.length > 0;

  // Keep the highlight inside the list as it narrows.
  useEffect(() => {
    setPick((i) => (i < matches.length ? i : 0));
  }, [matches.length]);

  function complete(name: string) {
    setText(`/${name} `);
    areaRef.current?.focus();
  }

  // Grow with the text, up to a few lines, then scroll inside.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // Room to actually write in. A prompt is often a paragraph or a pasted
    // stack trace, and a three-line window turns that into a keyhole.
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  }, [text]);

  /** Take files from a paste or a file input and turn each into an attachment.
   *
   *  Images are saved on the server and travel as a path, because that is what
   *  both agents can use: Codex wants `-i <FILE>`, and Claude needs bytes to
   *  read. Anything that is not an image is refused here rather than silently
   *  dropped later — see `attachPaths` for referencing a file that already
   *  exists on the machine. */
  const attachFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        setAttachError("Only images can be pasted. Use “Attach” for other files.");
        continue;
      }
      try {
        const buffer = await file.arrayBuffer();
        // Chunked, because spreading a few million bytes into String.fromCharCode
        // in one call overflows the argument stack.
        let binary = "";
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        const extension = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
        const path = await bridge.invoke<string>("save_attachment", {
          dataBase64: btoa(binary),
          extension,
        });
        setAttachError(null);
        setAttached((prev) => [
          ...prev,
          {
            path,
            name: file.name || `pasted.${extension}`,
            isImage: true,
            // The bytes are already here; showing them costs nothing and
            // needs no trip back to the server.
            url: URL.createObjectURL(file),
          },
        ]);
      } catch (err) {
        setAttachError(String((err as Error).message ?? err));
      }
    }
  }, []);

  /** Reference files that already exist on the machine, by path. */
  const attachPaths = useCallback((paths: string[]) => {
    setAttachError(null);
    setAttached((prev) => {
      const seen = new Set(prev.map((a) => a.path));
      const add = paths
        .filter((p) => p && !seen.has(p))
        .map((p) => ({
          path: p,
          name: p.split("/").filter(Boolean).pop() ?? p,
          isImage: IMAGE_EXT.test(p),
        }));
      return [...prev, ...add];
    });
  }, []);

  /** Drop an attachment, and the object URL that was drawing its thumbnail. */
  const forget = useCallback((gone: Attachment[]) => {
    for (const a of gone) if (a.url) URL.revokeObjectURL(a.url);
  }, []);

  function send() {
    const value = text.trim();
    if ((!value && attached.length === 0) || disabled) return;
    onSend(value, attached);
    setText("");
    // The message owns them now; these previews are done.
    forget(attached);
    setAttached([]);
    setAttachError(null);
  }

  return (
    <div className="composer">
      {slashOpen && (
        <div className="slash" role="listbox">
          <div className="slash-head">
            {matches.length} command{matches.length === 1 ? "" : "s"} · Tab to complete
          </div>
          <ul className="slash-list">
            {matches.map((name, i) => (
              <li key={name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === pick}
                  className={`slash-item ${i === pick ? "is-on" : ""}`}
                  onMouseEnter={() => setPick(i)}
                  onClick={() => complete(name)}
                >
                  /{name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {filePicker && (
        <FolderPicker
          start={cwd ?? ""}
          title="Reference a file"
          files
          onPick={(p) => {
            attachPaths([p]);
            setFilePicker(false);
          }}
          onClose={() => setFilePicker(false)}
        />
      )}
      <div className="composer-box">
        {(attached.length > 0 || attachError) && (
          <div className="attach">
            {attached.map((a) => (
              <span className={`chip ${a.isImage ? "is-image" : ""}`} key={a.path} title={a.path}>
                {a.isImage ? <Thumb attachment={a} /> : <PaperIcon />}
                <span className="chip-name">{a.name}</span>
                <button
                  className="chip-x"
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => {
                    forget([a]);
                    setAttached((prev) => prev.filter((x) => x.path !== a.path));
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
            {attachError && <span className="attach-error">{attachError}</span>}
          </div>
        )}
        <textarea
          ref={areaRef}
          className="composer-input"
          rows={2}
          value={text}
          placeholder={disabled ? "Pick a project first" : `Ask ${choice.name} to…`}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // Only intercept when the clipboard actually carries a file.
            // Pasting text must stay ordinary pasting.
            const files = [...(e.clipboardData?.files ?? [])];
            if (!files.length) return;
            e.preventDefault();
            void attachFiles(files);
          }}
          onKeyDown={(e) => {
            // While the command list is up it owns the arrows, Tab and Enter —
            // the same keys a shell completion takes.
            if (slashOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setPick((i) => (i + 1) % matches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setPick((i) => (i - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
                e.preventDefault();
                complete(matches[pick]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setText("");
                return;
              }
            }
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
                  {started && (
                    <div className="picker-note">
                      Another {choice.name} model keeps this chat · the other agent starts a new one
                    </div>
                  )}
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

          <div className="picker">
            <button
              className={`picker-btn perm-${perm.id}`}
              type="button"
              aria-haspopup="menu"
              aria-expanded={permMenu}
              title={perm.hint}
              onClick={() => setPermMenu((v) => !v)}
            >
              {perm.label}
              <span className="picker-caret" aria-hidden="true">
                ▾
              </span>
            </button>
            {permMenu && (
              <>
                <div className="picker-scrim" onClick={() => setPermMenu(false)} />
                <div className="picker-menu" role="menu">
                  {accessList.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      role="menuitem"
                      className={`picker-item ${p.id === access ? "is-on" : ""}`}
                      onClick={() => {
                        onAccess(p.id);
                        setPermMenu(false);
                      }}
                    >
                      <span className="picker-name">{p.label}</span>
                      <span className="picker-model">{p.hint}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Claude only: Codex has no effort flag, so offering one here would
              be a setting that does nothing. */}
          {(
            <div className="picker">
              <button
                className="picker-btn"
                type="button"
                aria-haspopup="menu"
                aria-expanded={effMenu}
                title={`Effort: ${eff.hint}`}
                onClick={() => setEffMenu((v) => !v)}
              >
                {eff.label}
                <span className="picker-caret" aria-hidden="true">
                  ▾
                </span>
              </button>
              {effMenu && (
                <>
                  <div className="picker-scrim" onClick={() => setEffMenu(false)} />
                  <div className="picker-menu" role="menu">
                    {started && (
                      <div className="picker-note">
                        {choice.agent === "claude"
                          ? "Changes this chat straight away"
                          : "Applies from your next message"}
                      </div>
                    )}
                    {effortList.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        role="menuitem"
                        className={`picker-item ${e.id === effort ? "is-on" : ""}`}
                        onClick={() => {
                          onEffort(e.id);
                          setEffMenu(false);
                        }}
                      >
                        <span className="picker-name">{e.label}</span>
                        <span className="picker-model">{e.hint}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Two different things, which is why they are two buttons.
              The clip references a file that already lives on the MACHINE
              running the agents — the agent opens it itself, so a whole file
              never has to travel through the prompt. The picture button uploads
              from the DEVICE in your hand, which is the only way to get a photo
              off a phone. Pasting covers the same ground as the latter. */}
          <button
            className="picker-btn"
            type="button"
            title="Reference a file on the machine"
            onClick={() => setFilePicker(true)}
          >
            <ClipIcon />
          </button>
          <button
            className="picker-btn"
            type="button"
            title="Upload an image from this device"
            onClick={() => fileRef.current?.click()}
          >
            <ImageIcon />
          </button>
          <input
            ref={fileRef}
            className="attach-input"
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => {
              void attachFiles([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />

          {/* A shell in this project, for the things you would rather run than
              ask for. Next to the agent's own settings because it is the same
              decision: who does this — you, or it. */}
          {onTerminal && (
            <button
              className={`picker-btn ${terminalOpen ? "is-on" : ""}`}
              type="button"
              title={terminalOpen ? "Hide the terminal" : "Open a terminal here"}
              onClick={onTerminal}
            >
              <TerminalIcon />
            </button>
          )}

          <span className="composer-hint">{busy ? "working…" : "Enter to send"}</span>

          <ContextMeter tokens={contextTokens} window={contextWindow} />

          {busy ? (
            // While a turn runs, the same spot stops it. A chat you cannot
            // interrupt is a chat you have to kill, which costs the whole
            // conversation.
            <button className="send stop" type="button" title="Stop" onClick={onStop}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <rect x="5" y="5" width="14" height="14" rx="2.5" />
              </svg>
            </button>
          ) : (
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
          )}
        </div>
      </div>
    </div>
  );
}

/** How full this session's context is, next to the send button.
 *
 *  A conversation has a ceiling, and running into it is the thing that ends a
 *  session — so it belongs where you decide whether to keep going, not in a
 *  settings page. Both numbers arrive with the turn's `result`, so this shows
 *  nothing until the first answer has landed rather than guessing.
 *
 *  The ring fills as the context does, and turns amber then red. That is the
 *  whole message; the exact numbers are in the tooltip for when you want them. */
function ContextMeter({ tokens, window }: { tokens?: number; window?: number }) {
  if (!tokens || !window) return null;
  const percent = Math.min(100, Math.round((tokens / window) * 100));
  const level = percent >= 90 ? "is-danger" : percent >= 70 ? "is-warn" : "";
  // A circle drawn with a dash: the visible run is the used share of it.
  const R = 7;
  const C = 2 * Math.PI * R;

  return (
    <span
      className={`ctx ${level}`}
      title={`Context: ${short(tokens)} of ${short(window)} used (${percent}%)`}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle className="ctx-track" cx="9" cy="9" r={R} fill="none" strokeWidth="2.5" />
        <circle
          className="ctx-fill"
          cx="9"
          cy="9"
          r={R}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(percent / 100) * C} ${C}`}
          // Start the run at the top rather than at three o'clock.
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="ctx-val">{percent}%</span>
    </span>
  );
}

/** 357076 → "357k". Token counts are only ever read as a rough size. */
function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function ImageIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}

function PaperIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

function ClipIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l9.2-9.19a3.67 3.67 0 0 1 5.18 5.18l-9.2 9.2a1.83 1.83 0 0 1-2.6-2.6l8.5-8.48" />
    </svg>
  );
}

/** The little picture on an image chip.
 *
 *  A name like `image.png` says nothing about which screenshot you pasted, and
 *  when two are attached it says even less. The bytes are already in the page
 *  for a paste or an upload; a file picked on the machine is fetched instead —
 *  through the bridge's `/file` route, so the access token stays out of the
 *  markup. Falls back to the icon if either is unavailable. */
function Thumb({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState<string | null>(attachment.url ?? null);

  useEffect(() => {
    if (attachment.url) {
      setUrl(attachment.url);
      return;
    }
    let alive = true;
    let made: string | null = null;
    bridge
      .fetchFile(attachment.path)
      .then((blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch(() => alive && setUrl(null));
    return () => {
      alive = false;
      // Only ours to revoke — the one on the attachment belongs to the composer.
      if (made) URL.revokeObjectURL(made);
    };
  }, [attachment.path, attachment.url]);

  if (!url) return <ImageIcon />;
  return <img className="chip-thumb" src={url} alt="" />;
}

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5 8 4 4-4 4" />
      <path d="M13 16h6" />
    </svg>
  );
}
