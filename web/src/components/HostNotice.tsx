import { Fragment, type ReactNode } from "react";
import { FoldBody, useFold, WholeText } from "./CardFold";
import { notePress } from "../lib/pressGuard";
import { noticeSender, type HostNotice as Notice } from "../lib/hostNotice";
import "./HostNotice.css";

function NoticeRow({ notice, header }: { notice: Notice; header: ReactNode }) {
  const id = notice.id;
  const fold = useFold(id);
  const raw = useFold(`${id}:host-text`);
  return <div className="host-notice-row">
    <button type="button" className="host-notice-toggle" aria-expanded={fold.open} aria-controls={fold.controls}
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
  nameOf: (key: string) => { name: string } | null;
  reply?: string;
}) {
  return <div className="host-notices" aria-label="Host updates">
    {notices.map((notice) => <NoticeRow key={notice.id} notice={notice}
      header={<Fragment>{noticeSender(notice, nameOf)} <span className="host-notice-arrow">&gt;&gt;&gt;</span> {coordinator}: {notice.subject}</Fragment>} />)}
    {reply && <div className="host-notice-reply">{coordinator}: {reply}</div>}
  </div>;
}
