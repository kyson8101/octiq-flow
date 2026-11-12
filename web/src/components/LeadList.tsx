import { useContext } from "react";
import { AgentRosterContext } from "../lib/agentRoster";
import type { ChatHold } from "../lib/chatWait";
import { leadRowStatus, type LeadThread, type LeadThreadsReading } from "../lib/leadThreads";
import type { Conversation } from "../lib/store";
import { AgentAvatar } from "./AgentAvatar";
import { usePendingActions } from "./PendingActionBadge";
import "./LeadThreads.css";

export function LeadList({ reading, conversations, current, busy, waiting, opening, onOpen }: {
  reading: LeadThreadsReading; conversations: readonly Conversation[]; current: string | null;
  busy: ReadonlySet<string>; waiting: ReadonlyMap<string, ChatHold>; opening?: string | null;
  onOpen: (lead: LeadThread) => void;
}) {
  const roster = useContext(AgentRosterContext);
  const pending = usePendingActions();
  const rows = (reading.threads ?? []).map(lead => {
    const chat = conversations.find(c => `chat:${c.id}` === lead.chatKey);
    const status = leadRowStatus(chat, current, busy, waiting, pending.forRow(lead.chatKey.replace(/^chat:/, "")));
    return { lead, chat, status };
  }).sort((a, b) => Number(b.status.needsYou) - Number(a.status.needsYou) || (b.chat?.updatedAt ?? 0) - (a.chat?.updatedAt ?? 0));
  return <section className="sidebar-leads" aria-label="Leads" aria-busy={reading.threads === null && !reading.error}>
    <h2 className="sidebar-section-heading">Talk to</h2>
    {reading.error && <p className="lead-error" role="alert">{reading.error}</p>}
    {reading.threads === null ? <div className="lead-placeholder" role="status">{reading.error ? "Leads unavailable" : "Loading leads…"}</div>
      : !rows.length ? <p className="lead-placeholder">No leads configured.</p>
      : <ul className="lead-list">{rows.map(({ lead, status }) => <li key={lead.agentId}>
        <button type="button" className="lead-row" aria-current={`chat:${current}` === lead.chatKey ? "page" : undefined}
          aria-label={`Talk to ${lead.name}${status.needsYou ? ", Needs you" : status.working ? ", Working" : status.unread ? `, ${status.unread} unread` : ""}`}
          aria-disabled={reading.freshness !== "host" || opening === lead.agentId}
          aria-description={reading.freshness !== "host" ? "Checking with the server" : undefined}
          title={reading.freshness !== "host" ? "Checking with the server" : undefined}
          onClick={() => { if (reading.freshness === "host" && opening !== lead.agentId) onOpen(lead); }}>
          <AgentAvatar id={lead.agentId} name={lead.name} avatar={roster.find(a => a.id === lead.agentId)?.avatar} size={32} decorative />
          <span className="lead-name">{lead.name}</span>
          <span className="lead-status" data-state={reading.freshness !== "host" ? "checking" : status.needsYou ? "waiting" : status.working ? "working" : "idle"}>
            {reading.freshness !== "host" ? "Checking with the server" : status.needsYou ? "Needs you" : status.working ? <><span className="lead-working" aria-hidden="true" />Working</> : status.unread ? `${status.unread} unread` : opening === lead.agentId ? "Opening…" : ""}
          </span>
        </button>
      </li>)}</ul>}
  </section>;
}
