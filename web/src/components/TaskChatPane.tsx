// The right half of [ Main | Task ]: one task's chat, read-only, beside the
// main chat that coordinates it (lib/chatBeside).
//
// It is the same transcript the full-width view draws — MessageList over the
// chat App already holds and folds live events into — not a second App. No
// composer: a task chat is read-only (the badge by its title says so), and
// instructions go through the main chat on the left, exactly as they do when
// the task is open on its own.
import { forwardRef, type Ref } from "react";
import type { Message } from "../lib/chat";
import type { Persona } from "../lib/agentPersona";
import { MessageList } from "./MessageList";
import { BackgroundProvider } from "./Background";
import { PathCwdProvider } from "./ProsePath";
import { AgentAvatar } from "./AgentAvatar";
import { ChatTaskBar, type PanelContext } from "./ChatTaskBar";
import { ReadOnlyBadge } from "./ReadOnlyBadge";
import { SplitIcon } from "./OpenBesideButton";
import "./TaskChatPane.css";

const NO_CALLS: ReadonlySet<string> = new Set();

export type TaskChatPaneProps = {
  chatId: string;
  title: string;
  messages: Message[];
  busy: boolean;
  stoppedAt?: string;
  compactingSince?: number;
  /** Its transcript is still being read back. */
  reading: boolean;
  hostName: string;
  persona: Persona | null;
  cwd: string;
  runningCalls?: ReadonlySet<string>;
  hasEarlier: boolean;
  loadingEarlier: boolean;
  earlierError?: string;
  onLoadEarlier: () => Promise<void>;
  connected: boolean;
  context?: PanelContext;
  waiting: boolean;
  /** Side by side. Otherwise the panes take turns (not enough room), and the
   *  bar above them carries Close split and the way back to Main. */
  split: boolean;
  hidden: boolean;
  onExpand: () => void;
  onClose: () => void;
};

export const TaskChatPane = forwardRef(function TaskChatPane(props: TaskChatPaneProps, headingRef: Ref<HTMLHeadingElement>) {
  const { chatId, title, messages, busy, reading, persona, split, hidden } = props;
  return (
    <section className="beside-pane is-task" aria-label={`Task chat: ${title}`} hidden={hidden} data-chat={chatId}>
      <header className="beside-head">
        {persona && <AgentAvatar name={persona.name} avatar={persona.avatar} id={persona.id} size={22} decorative />}
        <div className="beside-head-text">
          <div className="beside-title-row">
            <h2 className="beside-title" ref={headingRef} tabIndex={-1} title={title}>{title}</h2>
            <ReadOnlyBadge />
          </div>
          <span className="beside-sub">{persona ? `${persona.name} · ` : ""}Task chat</span>
        </div>
        <ChatTaskBar chatId={chatId} connected={props.connected} context={props.context} busy={busy} waiting={props.waiting} />
        <div className="beside-actions">
          <button type="button" className="beside-btn" onClick={props.onExpand}
            aria-label={`Expand to full chat: ${title}`} title="Expand to full chat">
            <ExpandIcon />
          </button>
          {split && <button type="button" className="beside-btn" onClick={props.onClose}
            aria-label="Close split" title="Close split · keep the main chat">
            <CloseIcon />
          </button>}
        </div>
      </header>
      {messages.length === 0 ? (
        <div className={`hero${reading ? " is-waiting" : ""}`}>
          {reading ? <>
            <div className="dots" aria-label="opening" />
            <p className="hero-sub">opening “{title}”…</p>
          </> : <>
            <h2 className="hero-title">Agent conversation</h2>
            <p className="hero-sub">The agent's progress will appear here.</p>
          </>}
        </div>
      ) : (
        <div className="chat-body">
          <PathCwdProvider value={props.cwd}>
            <BackgroundProvider value={props.runningCalls ?? NO_CALLS}>
              <div className="chat-main">
                <MessageList
                  messages={messages}
                  conversationId={chatId}
                  busy={busy}
                  stoppedAt={props.stoppedAt}
                  compactingSince={props.compactingSince}
                  hasEarlier={props.hasEarlier}
                  loadingEarlier={props.loadingEarlier}
                  earlierError={props.earlierError}
                  onLoadEarlier={props.onLoadEarlier}
                  hostName={props.hostName}
                  hostPersona={persona}
                  // Read-only: nothing here can queue, take back or send.
                />
              </div>
            </BackgroundProvider>
          </PathCwdProvider>
        </div>
      )}
    </section>
  );
});

/** Over the main chat's pane while both are side by side: which one it is. */
export function BesideMainHead({ persona }: { persona: Persona | null }) {
  return (
    <header className="beside-head is-main">
      {persona && <AgentAvatar name={persona.name} avatar={persona.avatar} id={persona.id} size={22} decorative />}
      <div className="beside-head-text">
        <h2 className="beside-title">Main chat</h2>
        {persona && <span className="beside-sub">{persona.name} · coordinates this run</span>}
      </div>
    </header>
  );
}

/** Where there is not room for both: say so, and let the person pick which. */
export function BesideBar({ showing, taskTitle, onShow, onClose }: {
  showing: "main" | "task";
  taskTitle: string;
  onShow: (pane: "main" | "task") => void;
  onClose: () => void;
}) {
  return (
    <div className="beside-bar" role="region" aria-label="Main and task chats">
      <p className="beside-note" id="beside-note">
        <SplitIcon />Side by side needs a wider chat area. Showing one chat at a time.
      </p>
      <div className="beside-switch" role="group" aria-label="Chat shown" aria-describedby="beside-note">
        <button type="button" aria-pressed={showing === "main"} onClick={() => onShow("main")}>Main chat</button>
        <button type="button" aria-pressed={showing === "task"} onClick={() => onShow("task")} title={taskTitle}>
          <span>Task</span><span className="beside-switch-title">{taskTitle}</span>
        </button>
      </div>
      <button type="button" className="beside-btn" onClick={onClose} aria-label="Close split" title="Close split · keep the main chat">
        <CloseIcon />
      </button>
    </div>
  );
}

function ExpandIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" />
  </svg>;
}
function CloseIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>;
}
