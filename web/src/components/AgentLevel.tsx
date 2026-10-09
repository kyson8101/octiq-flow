// An agent's level: the chip on its Agents row, and the profile behind it.
//
// The chip indicates (level and a thin bar); the profile explains (XP, what
// was accepted and by whom, what waits for acceptance, tokens, and the rules).
// Every number comes from the host (`agent_level_profile`).
import { useEffect, useState } from "react";
import {
  acceptTask, acceptorLabel, compactTokens, historyXp, levelFraction, loadLevelProfile, shortDate, SIZE_LABEL, toNextLevel,
  type AcceptanceRecord, type LevelProfile, type LevelProgress,
} from "../lib/agentLevels";
import { AgentAvatar } from "./AgentAvatar";
import "./AgentLevel.css";

const LEVEL_ONE: LevelProgress = { xp: 0, level: 1, levelXp: 0, nextLevelXp: 100 };

/** "Lv 3" and a bar, as a button that opens the profile. */
export function LevelChip({ name, progress, onOpen }: {
  name: string;
  progress?: LevelProgress;
  onOpen: () => void;
}) {
  const level = progress ?? LEVEL_ONE;
  const title = `Level ${level.level} · ${level.xp.toLocaleString("en-US")} XP · ${toNextLevel(level)}`;
  return (
    <button type="button" className="level-chip" onClick={onOpen} title={title}
      aria-label={`${name}: level ${level.level}, ${level.xp} XP. Open profile`}>
      <span className="level-chip-text">Lv {level.level}</span>
      <span className="level-chip-bar" aria-hidden="true">
        <span style={{ width: `${Math.round(levelFraction(level) * 100)}%` }} />
      </span>
    </button>
  );
}

function LevelBar({ progress, name }: { progress: LevelProgress; name: string }) {
  return (
    <div className="level-bar" role="progressbar" aria-label={`${name}'s progress to level ${progress.level + 1}`}
      aria-valuemin={progress.levelXp} aria-valuemax={progress.nextLevelXp} aria-valuenow={progress.xp}
      aria-valuetext={`${progress.xp} of ${progress.nextLevelXp} XP`}>
      <span style={{ width: `${Math.round(levelFraction(progress) * 100)}%` }} />
    </div>
  );
}

/** "3 of its own: 1 leading, 2 as a worker", zero counts left out. */
function chatsLabel(usage: { chats: number; leadChats: number; workerChats: number }): string {
  if (usage.chats === 0) return "None yet";
  const parts = [
    usage.leadChats ? `${usage.leadChats} leading` : "",
    usage.workerChats ? `${usage.workerChats} as a worker` : "",
  ].filter(Boolean);
  return `${usage.chats} of its own: ${parts.join(", ")}`;
}

/** One acceptance of the agent's work: what it paid, or why nothing. */
export function XpHistoryRow({ record, onOpen }: { record: AcceptanceRecord; onOpen: () => void }) {
  const paid = historyXp(record);
  return (
    <li className="xp-row">
      <button type="button" className="xp-row-open" disabled={!record.coordinatorChatKey} onClick={onOpen}
        aria-label={`${record.title}: ${paid.amount}${paid.why ? `, ${paid.why}` : ""}. Open task`}>
        <span className="dash-item-title">{record.title}</span>
        <span className="dash-item-meta">
          {paid.why ?? (record.size ? SIZE_LABEL[record.size] : "No size recorded")}
          {" · accepted by "}{acceptorLabel(record.acceptedBy)}{" · "}{shortDate(record.acceptedAt)}
        </span>
      </button>
      <span className={record.xp > 0 ? "xp-gain" : "xp-gain is-zero"}>{paid.amount}</span>
    </li>
  );
}

export type ProfileAgent = { id: string; name: string; avatar?: string; removed?: boolean; detail?: string };

export function AgentProfile({ agent, connected, onOpenRun, onChanged }: {
  agent: ProfileAgent;
  connected: boolean;
  /** A task's run, by its main chat. Throws when that chat is not in this
   *  browser's list. */
  onOpenRun: (coordinatorChatKey: string, runId: string) => void;
  /** Something was accepted: levels elsewhere on the page are stale. */
  onChanged: () => void;
}) {
  const [profile, setProfile] = useState<LevelProfile | null>(null);
  const [more, setMore] = useState<AcceptanceRecord[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!connected) return;
    let alive = true;
    loadLevelProfile(agent.id, 0)
      .then((next) => { if (alive) { setProfile(next); setMore([]); setError(""); } })
      .catch((reason) => { if (alive) setError(String((reason as Error).message ?? reason)); });
    return () => { alive = false; };
  }, [agent.id, connected, reload]);

  const history = profile ? [...profile.history, ...more] : [];
  const loadMore = async () => {
    if (!profile) return;
    setBusy("more");
    try {
      const page = await loadLevelProfile(agent.id, history.length);
      setMore((before) => [...before, ...page.history]);
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusy(null);
    }
  };

  const accept = async (taskId: string, attemptId: string) => {
    setBusy(taskId);
    setNotice("");
    try {
      const result = await acceptTask(taskId, attemptId);
      setNotice(result.awarded && result.award
        ? `Accepted. ${agent.name} earned ${result.award.xp} XP.`
        : `Accepted. ${result.note ?? "No XP was paid."}`);
      setReload((n) => n + 1);
      onChanged();
    } catch (reason) {
      setError(String((reason as Error).message ?? reason));
    } finally {
      setBusy(null);
    }
  };

  const open = (chatKey: string | undefined, runId: string) => {
    if (!chatKey) return;
    try { onOpenRun(chatKey, runId); } catch (reason) { setError(String((reason as Error).message ?? reason)); }
  };

  const usage = profile?.usage;
  return (
    <section className="agent-profile" aria-label={`${agent.name}'s profile`}>
      <header className="agent-profile-head">
        <AgentAvatar name={agent.name} avatar={agent.avatar} id={agent.id} size={44} removed={agent.removed} decorative />
        <div className="agent-profile-title">
          <h2><bdi>{agent.name}</bdi></h2>
          {agent.detail && <span className="team-row-meta"><bdi>{agent.detail}</bdi></span>}
        </div>
      </header>

      {error && <p className="set-warn" role="alert">{error}</p>}
      {notice && <p className="agent-profile-notice" role="status">{notice}</p>}
      {!profile && !error && <p className="projects-page-meta">Loading profile…</p>}

      {profile && (
        <>
          <div className="level-block">
            <div className="level-head">
              <strong className="level-number">Level {profile.level}</strong>
              <span className="level-xp">{profile.xp.toLocaleString("en-US")} XP</span>
            </div>
            <LevelBar progress={profile} name={agent.name} />
            <p className="level-next">{toNextLevel(profile)}</p>
          </div>

          <dl className="agent-profile-stats">
            <div>
              <dt>Accepted tasks</dt>
              <dd title="Every task accepted for this agent, counted once for good, including those that earned no XP">
                {profile.acceptedTasks.toLocaleString("en-US")}
                <span className="agent-profile-stat-note">lifetime</span>
              </dd>
            </div>
            <div>
              <dt>Tokens used</dt>
              <dd title={usage && usage.chats > 0 ? `${usage.total.toLocaleString("en-US")} tokens` : undefined}>
                {!usage ? "Unavailable" : usage.chats === 0 ? "None recorded" : compactTokens(usage.total)}
              </dd>
            </div>
          </dl>

          {profile.awaiting.length > 0 && (
            <section className="agent-profile-section" aria-label="Waiting for acceptance">
              <h3>Waiting for acceptance</h3>
              <ul className="agent-profile-list">
                {profile.awaiting.map((item) => (
                  <li key={item.taskId} className="xp-row">
                    <button type="button" className="xp-row-open" onClick={() => open(item.coordinatorChatKey, item.runId)}
                      aria-label={`Open task: ${item.title}`}>
                      <span className="dash-item-title">{item.title}</span>
                      <span className="dash-item-meta">
                        {item.size ? SIZE_LABEL[item.size] : "No size recorded"}
                        {item.unscored ? " · earns no XP" : ""}
                        {" · finished "}{shortDate(item.finishedAt)}
                      </span>
                    </button>
                    <button type="button" className="vault-button xp-accept" disabled={busy !== null || !connected}
                      onClick={() => void accept(item.taskId, item.attemptId)}>
                      {busy === item.taskId ? "Accepting…" : "Accept"}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="agent-profile-section" aria-label="XP history">
            <h3>XP history</h3>
            {history.length === 0 ? (
              <p className="projects-page-meta">No accepted tasks yet.</p>
            ) : (
              <ul className="agent-profile-list">
                {history.map((record) => (
                  <XpHistoryRow key={`${record.taskId}:${record.attemptId}`} record={record}
                    onOpen={() => open(record.coordinatorChatKey, record.runId)} />
                ))}
              </ul>
            )}
            {history.length < profile.historyTotal && (
              <button type="button" className="dash-more" disabled={busy !== null} onClick={() => void loadMore()}>
                {busy === "more" ? "Loading…" : `Show more (${profile.historyTotal - history.length})`}
              </button>
            )}
          </section>

          {usage && (
            <details className="agent-profile-details">
              <summary>Token usage</summary>
              <dl className="plan-card-facts">
                <dt>Input</dt>
                <dd>{usage.usage.input.toLocaleString("en-US")}
                  <span className="plan-card-note">
                    {usage.usage.cachedInput.toLocaleString("en-US")} from cache
                    {usage.usage.cacheWrite > 0 ? `, ${usage.usage.cacheWrite.toLocaleString("en-US")} written to cache` : ""}
                  </span>
                </dd>
                <dt>Output</dt>
                <dd>{usage.usage.output.toLocaleString("en-US")}
                  {usage.reasoningReported && (
                    <span className="plan-card-note">{usage.usage.reasoning.toLocaleString("en-US")} reasoning (Codex only)</span>
                  )}
                </dd>
                <dt>Chats</dt>
                <dd>{chatsLabel(usage)}</dd>
              </dl>
              <p className="agent-profile-fine">
                Counted since {shortDate(usage.since || profile.scoringSince)}, from what each provider reports, so this is a
                floor: earlier chats, and a turn stopped before the provider reported it, are not included. Claude’s
                figures include helper subagents it runs inside its own chat. Registered reports have their own chats
                and count for themselves. Cached and reasoning tokens are part of input and output, not extra.
              </p>
            </details>
          )}
          {profile.usageError && <p className="set-warn" role="alert">{profile.usageError}</p>}

          <details className="agent-profile-details">
            <summary>How levels work</summary>
            <ul className="agent-profile-rules">
              <li>XP is paid when you or the responsible lead accept a finished task:{" "}
                {profile.rules.sizes.map(([size, xp]) => `${SIZE_LABEL[size].toLowerCase()} ${xp}`).join(", ")}.</li>
              <li>The size is chosen before the task starts and cannot change after. Each task pays once, however often it is reopened or retried.</li>
              <li>Accepted tasks counts every task you or a lead accepted, once and for good, including tasks that earned no XP. A task reopened and accepted again shows in the history again, but is counted once.</li>
              <li>Level 1 starts at 0 XP. Going from level L to L+1 takes {profile.rules.levelStep} × L XP.</li>
              <li>Only accepted tasks in missions count. Work in ordinary chats is not scored.</li>
              <li>Scoring began {shortDate(profile.scoringSince)}. Tasks finished before then are not scored.</li>
              <li>Token usage is shown for information only. It does not affect XP.</li>
            </ul>
          </details>
        </>
      )}
    </section>
  );
}
