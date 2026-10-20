// Every registered agent and what it is doing right now, as the Agents page
// reads it (`agentRoster`): one reading for every surface that says where an
// agent is, the Agents page and the island alike. The roster, the lead
// records and the peer teams are read on every connect and when the roster
// changes; which lead conversations are mid-turn is asked when a chat starts,
// stops or changes turn. Nothing ticks.
import { useEffect, useMemo, useState } from "react";
import { AGENT_NAME } from "./agentProviders";
import { loadAgentTeams, loadLeads, loadTeam, onTeamChanged, teamModelLabel, type AgentTeam, type TeamAgent } from "./agentsMode";
import { agentRoster, type AgentRow, type ChatActivity, type LeadRecord } from "./agentsDashboard";
import type { OrchestrationSnapshot } from "./orchestration";
import type { Waiting } from "./runWaits";
import { useHoldClock } from "./useHoldClock";
import { bridge } from "./bridge";

type Activity = { key: string; busy: boolean };

export type AgentRowsInput = {
  connected: boolean;
  /** Null until the ledger's first read lands. */
  snapshot: OrchestrationSnapshot | null;
  projects: readonly { id: string; name: string }[];
  /** Chat ids with a live process, and those mid-turn, as this page has seen. */
  running: ReadonlySet<string>;
  busy: ReadonlySet<string>;
  /** Cards on this chat itself only the person can answer. */
  waitingOn: (chatKey: string) => number;
  /** The cards the page holds, per task (`lib/pendingActions`). */
  held: Waiting;
  chatTitle: (chatKey: string) => string | undefined;
  chatExists: (chatKey: string) => boolean;
};

export function useAgentRows(input: AgentRowsInput): {
  rows: AgentRow[];
  /** Null until the roster has loaded. */
  team: TeamAgent[] | null;
  teams: AgentTeam[];
  error: string;
} {
  const { connected, snapshot, projects, running, busy, waitingOn, held, chatTitle, chatExists } = input;
  const [team, setTeam] = useState<TeamAgent[] | null>(null);
  const [teams, setTeams] = useState<AgentTeam[]>([]);
  const [leads, setLeads] = useState<LeadRecord[]>([]);
  const [error, setError] = useState("");
  const [serverActivity, setServerActivity] = useState<ReadonlyMap<string, boolean> | null>(null);

  // Every registered agent, not the current chat's project's: read again on
  // every reconnect, since agents may have been added or renamed from
  // another device meanwhile.
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    // An older backend has no teams; its rows simply carry no badge.
    Promise.all([loadTeam(null, true), loadLeads(), loadAgentTeams().catch(() => [])])
      .then(([agents, records, groups]) => {
        if (!alive) return;
        setTeam(agents);
        setTeams(groups);
        setLeads(records);
        setError("");
      })
      .catch((reason) => { if (alive) setError(String((reason as Error).message ?? reason)); });
    // An agent registered or changed from a chat, once the person approved it.
    const off = onTeamChanged(() => {
      loadTeam(null, true).then((agents) => { if (alive) setTeam(agents); }).catch(() => {});
    });
    return () => { alive = false; off(); };
  }, [connected]);

  // Which lead conversations are mid-turn. A page that has just loaded has
  // seen no events from them, so it asks the host; asked again whenever a
  // chat starts, stops or changes turn, never on a timer.
  const liveSignature = useMemo(() => [...running].sort().join(",") + "|" + [...busy].sort().join(","), [running, busy]);
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    bridge.invoke<Activity[]>("chat_activity")
      .then((list) => { if (alive) setServerActivity(new Map((list ?? []).map((item) => [item.key, item.busy]))); })
      // An older backend: this page's own evidence is all there is.
      .catch(() => { if (alive) setServerActivity(null); });
    return () => { alive = false; };
  }, [connected, liveSignature]);

  const leadActivity = (chatKey: string): ChatActivity => {
    const id = chatKey.replace(/^chat:/, "");
    if (busy.has(id)) return "busy";
    const known = serverActivity?.get(chatKey);
    if (known !== undefined) return known ? "busy" : "idle";
    if (serverActivity) return "ended";
    return running.has(id) ? "unknown" : "ended";
  };

  const projectList = useMemo(() => projects.map(({ id, name }) => ({ id, name })), [projects]);
  // The one reading here that a clock moves: a reopened task whose notice
  // has stayed unconfirmed takes the warning colour. It moves once per
  // hold, when that hold has lasted, and never ticks (`useHoldClock`).
  const now = useHoldClock(snapshot?.tasks);
  const rows = agentRoster({
    team, leads, snapshot, projects: projectList, teams,
    providerLabel: (agent) => `${AGENT_NAME[agent.agent]} ${teamModelLabel(agent)}`,
    chatTitle, chatExists, leadActivity, waitingOn, held, now,
  });
  return { rows, team, teams, error };
}
