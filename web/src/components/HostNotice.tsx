import { Fragment, type ReactNode } from "react";
import { FoldBody, useFold, WholeText } from "./CardFold";
import { notePress } from "../lib/pressGuard";
import { noticeSender, type HostNotice as Notice } from "../lib/hostNotice";
import "./HostNotice.css";

function NoticeRow({ id, header, text }: { id: string; header: ReactNode; text: string }) {
  const fold = useFold(id);
  return <div className="host-notice-row">
    <button type="button" className="host-notice-toggle" aria-expanded={fold.open} aria-controls={fold.controls}
      onClick={(event) => { notePress(event); fold.toggle(); }}>
      <span className="host-notice-label">{header}</span>
      <span className="card-fold-chevron" aria-hidden="true" />
    </button>
    <FoldBody fold={fold} bounded={false}><WholeText text={text} className="host-notice-text" /></FoldBody>
  </div>;
}

export function HostNotice({ notices, coordinator, nameOf, reply }: {
  notices: Notice[];
  coordinator: string;
  nameOf: (key: string) => { name: string } | null;
  reply?: string;
}) {
  return <div className="host-notices" aria-label="Host updates">
    {notices.map((notice) => <NoticeRow key={notice.id} id={notice.id} text={notice.text}
      header={<Fragment>{noticeSender(notice, nameOf)} <span className="host-notice-arrow">&gt;&gt;&gt;</span> {coordinator}: {notice.subject}</Fragment>} />)}
    {reply && <NoticeRow id={`${notices[0].id}:reply`} text={reply}
      header={<Fragment>{coordinator}: {reply.split("\n").find((line) => line.trim())}</Fragment>} />}
  </div>;
}
