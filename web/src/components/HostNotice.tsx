import { useContext, type ReactNode } from "react";
import { FoldBody, useFold, WholeText } from "./CardFold";
import { notePress } from "../lib/pressGuard";
import { noticeSender, type HostNotice as Notice } from "../lib/hostNotice";
import { AgentAvatar } from "./AgentAvatar";
import { AgentRosterContext } from "../lib/agentRoster";
import type { Persona } from "../lib/agentPersona";
import "./HostNotice.css";

function NoticeFace({ persona }: { persona?: Persona | null }) {
  return persona
    ? <AgentAvatar island name={persona.name} avatar={persona.avatar} id={persona.id ?? persona.name} removed={persona.removed} size={16} decorative />
    : <svg className="host-notice-face" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true"><rect x="2.5" y="4.5" width="11" height="9" rx="3" /><path d="M8 2v2.5M5.5 8h.01M10.5 8h.01M6 11h4" strokeLinecap="round" /></svg>;
}

const kindPaths: Record<string, ReactNode> = {
  status: <circle cx="8" cy="8" r="3" />,
  reply: <path d="m6 4-4 4 4 4M2 8h7a4 4 0 0 1 4 4" />,
  question: <><path d="M5.5 5a2.5 2.5 0 1 1 4 2c-1 .6-1.5 1-1.5 2.5" /><path d="M8 12h.01" /></>,
  instruction: <path d="M2 4h7M2 8h4M2 12h4m4-7 3 3-3 3M8 8h5" />,
  escalation: <><path d="m8 2 6 11H2L8 2Z" /><path d="M8 6v3m0 2h.01" /></>,
  report: <path d="m3 8 3 3 7-7" />,
  failure: <path d="m4 4 8 8m0-8-8 8" />,
  capacity: <><circle cx="8" cy="8" r="5.5" /><path d="M8 4.5V8l2.5 1.5" /></>,
  unknown: <><circle cx="8" cy="8" r="5.5" /><path d="M8 7v4m0-6h.01" /></>,
};

function NoticeKind({ kind }: { kind: string }) {
  const known = Object.hasOwn(kindPaths, kind) ? kind : "unknown";
  return <svg className={`host-notice-kind host-notice-kind-${known}`} width="12" height="12" viewBox="0 0 16 16"
    fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{kindPaths[known]}</svg>;
}

function NoticeRow({ notice, header, label }: { notice: Notice; header: ReactNode; label: string }) {
  const id = notice.id;
  const fold = useFold(id);
  const raw = useFold(`${id}:host-text`);
  return <div className="host-notice-row">
    <button type="button" className="host-notice-toggle" aria-label={label} title={label} aria-expanded={fold.open} aria-controls={fold.controls}
      onClick={(event) => { notePress(event); fold.toggle(); }}>
      <span className="host-notice-label">{header}</span>
      <span className="card-fold-chevron" aria-hidden="true" />
    </button>
    <FoldBody fold={fold} bounded={false}>
      <WholeText text={notice.body} className="host-notice-text" />
      <button type="button" className="host-notice-raw-toggle" aria-expanded={raw.open} aria-controls={raw.controls}
        onClick={(event) => { notePress(event); raw.toggle(); }}>
        Host text <span className="card-fold-chevron" aria-hidden="true" />
      </button>
      <FoldBody fold={raw} bounded={false}><WholeText text={notice.text} className="host-notice-text host-notice-raw" /></FoldBody>
    </FoldBody>
  </div>;
}

export function HostNotice({ notices, coordinator, nameOf, reply }: {
  notices: Notice[];
  coordinator: string;
  nameOf: (key: string) => Persona | null;
  reply?: string;
}) {
  const roster = useContext(AgentRosterContext);
  const coordinatorPersona = roster.find((agent) => agent.name === coordinator);
  return <div className="host-notices" aria-label="Host updates">
    {notices.map((notice) => {
      const sender = noticeSender(notice, nameOf);
      const persona = notice.from ? nameOf(notice.from) : null;
      return <NoticeRow key={notice.id} notice={notice} label={`${sender} to ${coordinator}, ${notice.kind}: ${notice.subject}`}
        header={<>
          <NoticeFace persona={persona} />
          <span className="host-notice-sender">{sender}</span>
          <svg className="host-notice-arrow" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4" /></svg>
          <span className="host-notice-coordinator">{coordinator}</span>
          <NoticeKind kind={notice.kind} />
          <span className="host-notice-subject">{notice.subject}</span>
        </>} />;
    })}
    {reply && <div className="host-notice-reply"><NoticeFace persona={coordinatorPersona} /><span className="host-notice-sender">{coordinator}</span><span className="host-notice-reply-text">{reply}</span></div>}
  </div>;
}
