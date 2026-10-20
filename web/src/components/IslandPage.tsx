// The island: a main-area page with the 3D world (lib/island/scene), a card
// for the robot the person is watching, and a side panel with the wishes and
// who lives here (docs/island.md). Loaded on its own, the first time the page
// is opened: three.js and the island stay out of every other page.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "./ProjectsPage.css";
import "./IslandPage.css";
import { WorkspaceHeader } from "./WorkspaceHeader";
import { AgentAvatar } from "./AgentAvatar";
import { useConfirm } from "./Confirm";
import type { AgentRow } from "../lib/agentsDashboard";
import type { OrchestrationSnapshot } from "../lib/orchestration";
import type { Waiting } from "../lib/runWaits";
import { useAgentRows } from "../lib/useAgentRows";
import { useIsland } from "../lib/island/feed";
import {
  openWishes, residentsOf, wisher, type IslandAgent, type Resident, type Wish, type WishPace,
} from "../lib/island/model";
import { agentModes, ago, grantBrief } from "../lib/island/reading";
import { IslandView } from "../lib/island/scene";

const PACES: { id: WishPace; label: string }[] = [
  { id: "often", label: "Often" },
  { id: "sometimes", label: "Sometimes" },
  { id: "rarely", label: "Rarely" },
  { id: "never", label: "Never" },
];

/** How a robot feels, as the world tells it: bored (0 to 1), excited, and
 *  what it is saying right now. */
type Mood = { boredom: number; excited: boolean; said: string | null };

const TRAITS: Record<string, string> = {
  cozy: "Cozy", curious: "Curious", sporty: "Sporty", artsy: "Artsy",
  tinkerer: "Tinkerer", dreamy: "Dreamy", foodie: "Foodie", gardener: "Gardener",
};

export default function IslandPage({
  connected, snapshot, projects, running, busy, waitingOn, held, chatTitle, chatExists,
  onGrant, onAsk, onOpenChat, onClose,
}: {
  connected: boolean;
  snapshot: OrchestrationSnapshot | null;
  projects: readonly { id: string; name: string }[];
  running: ReadonlySet<string>;
  busy: ReadonlySet<string>;
  waitingOn: (chatKey: string) => number;
  /** The cards the page holds, per task: the app's one reading of them, as
   *  the Agents page takes it (`lib/runWaits.wiring.test.ts`). */
  held: Waiting;
  chatTitle: (chatKey: string) => string | undefined;
  chatExists: (chatKey: string) => boolean;
  /** Start a chat that grants this wish, with its brief in the box. */
  onGrant: (wish: Wish, brief: string, agentId: string | null) => void;
  /** Start a chat with this agent about its island, with words in the box. */
  onAsk: (agentId: string, text: string) => void;
  onOpenChat: (chatKey: string) => void;
  onClose: () => void;
}) {
  const feed = useIsland(connected);
  const { rows, team } = useAgentRows({ connected, snapshot, projects, running, busy, waitingOn, held, chatTitle, chatExists });
  const confirm = useConfirm();
  const roster = useMemo<IslandAgent[]>(
    () => (team ?? []).map((agent) => ({ id: agent.id, name: agent.name, agent: agent.agent, model: agent.model, avatar: agent.avatar })),
    [team],
  );
  const residents = useMemo(() => (feed.island ? residentsOf(feed.island, roster) : []), [feed.island, roster]);
  const wishes = useMemo(() => (feed.island ? openWishes(feed.island) : []), [feed.island]);
  const modes = useMemo(() => agentModes(rows), [rows]);
  const modesKey = useMemo(() => JSON.stringify([...modes]), [modes]);

  const stage = useRef<HTMLDivElement>(null);
  const hoverLabel = useRef<HTMLDivElement>(null);
  const selectedLabel = useRef<HTMLDivElement>(null);
  const view = useRef<IslandView | null>(null);
  const [drawn, setDrawn] = useState<"yes" | "no" | "lost" | "starting">("starting");
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [mood, setMood] = useState<Mood | null>(null);
  const [panel, setPanel] = useState(() => typeof window !== "undefined" && window.innerWidth > 860);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showGranted, setShowGranted] = useState(false);
  const [restart, setRestart] = useState(0);

  // The world, made once its stage is on the page and let go with it. The
  // view puts its own canvas in the stage (and takes it out again).
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    let made: IslandView;
    try {
      made = new IslandView(element, {
        onPick: (key) => setSelected(key),
        onLost: () => setDrawn("lost"),
      }, !!reduced?.matches);
    } catch {
      setDrawn("no");
      return;
    }
    if (hoverLabel.current && selectedLabel.current) made.setLabels(hoverLabel.current, selectedLabel.current);
    view.current = made;
    setDrawn("yes");
    const motion = () => made.setReducedMotion(!!reduced?.matches);
    reduced?.addEventListener?.("change", motion);
    return () => {
      reduced?.removeEventListener?.("change", motion);
      made.dispose();
      view.current = null;
    };
  }, [restart]);

  useEffect(() => {
    if (feed.island && view.current) view.current.setIsland(feed.island, residents);
  }, [feed.island, residents, drawn]);

  // `modesKey` says when what the robots should do has changed; the map
  // itself is new on every render.
  const modesRef = useRef(modes);
  modesRef.current = modes;
  useEffect(() => {
    view.current?.setModes(modesRef.current);
  }, [modesKey, drawn, residents]);

  // A wish made, a present given: the robot it is about does something.
  const played = useRef(0);
  useEffect(() => {
    const change = feed.change;
    const island = feed.island;
    if (!change || !island || island.rev < change.rev || played.current >= change.rev) return;
    played.current = change.rev;
    if ((change.what === "wish" || change.what === "grant") && change.id) {
      const wish = island.wishes.find((w) => w.id === change.id);
      const who = wish && wisher(wish, residents);
      if (who) view.current?.event(change.what === "wish" ? "wish" : "gift", who.key);
    }
    // Someone moved in or out: the 波特 who live there build on it together.
    if (change.what === "home" && change.id) view.current?.homeChanged(change.id);
  }, [feed.change, feed.island, residents]);

  useEffect(() => { view.current?.select(selected); }, [selected]);

  // What the followed robot is doing, in a few words, and how bored it is:
  // asked of the world twice a second while a card is open, and not at all
  // otherwise.
  useEffect(() => {
    if (!selected) { setStatus(null); setMood(null); return; }
    const read = () => {
      setStatus(view.current?.describe(selected) ?? null);
      const now = view.current?.mood(selected) ?? null;
      setMood((before) => (before && now && Math.round(before.boredom * 100) === Math.round(now.boredom * 100)
        && before.excited === now.excited && before.said === now.said ? before : now));
    };
    read();
    const timer = window.setInterval(read, 500);
    return () => window.clearInterval(timer);
  }, [selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && selected) setSelected(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selected]);

  const act = async (name: string, action: () => Promise<void>) => {
    if (busyAction) return;
    setBusyAction(name);
    setActionError(null);
    try {
      await action();
    } catch (reason) {
      setActionError(String((reason as Error)?.message ?? reason));
    } finally {
      setBusyAction(null);
    }
  };

  const resident = selected ? residents.find((r) => r.key === selected) : undefined;
  const row = resident?.agent ? rows.find((r) => r.id === resident.agent!.id) : undefined;
  const wishOf = (r: Resident) => wishes.find((w) => w.who.kind === r.owner.kind && w.who.id === r.owner.id);
  const granted = useMemo(() => (feed.island?.wishes ?? [])
    .filter((w) => w.state === "granted")
    .sort((a, b) => (b.closedAt ?? b.madeAt) - (a.closedAt ?? a.madeAt))
    .slice(0, 20), [feed.island]);
  const nameOf = (wish: Wish) => wisher(wish, residents)?.name ?? "A robot who left";
  const bots = feed.island?.bots.length ?? 0;

  const grant = (wish: Wish) => {
    const who = wisher(wish, residents);
    onGrant(wish, grantBrief(wish, who?.name ?? "a robot"), who?.agent?.id ?? null);
  };

  const chatOf = (agentRow: AgentRow | undefined) =>
    agentRow?.activities.find((a) => a.chatKey)?.chatKey ?? agentRow?.recent?.chatKey ?? null;

  const actions = <>
    <button type="button" className="projects-page-secondary island-wishes-button" aria-expanded={panel}
      aria-controls="island-panel" onClick={() => setPanel((open) => !open)}
      title={wishes.length ? `${wishes.length} open ${wishes.length === 1 ? "wish" : "wishes"}` : "Wishes and residents"}>
      <GiftIcon /><span>Wishes</span>{wishes.length > 0 && <span className="island-count">{wishes.length}</span>}
    </button>
    <button type="button" className="projects-page-secondary" disabled={!feed.island || bots >= 16 || !!busyAction}
      onClick={() => void act("invite", feed.inviteBot)} title={bots >= 16 ? "The island is full: 16 波特 at most" : "A new 波特 arrives by boat"}>
      <BoatIcon /><span>Invite a 波特</span>
    </button>
    <button type="button" className="projects-page-secondary" onClick={() => { setSelected(null); view.current?.recenter(); }}
      disabled={drawn !== "yes"} title="See the whole island">
      <IslandIcon /><span>Whole island</span>
    </button>
  </>;

  return (
    <section className="projects-page island-page" aria-label="Island">
      <WorkspaceHeader root back={{ label: "Chat", ariaLabel: "Back to chat", onClick: onClose }}
        title={<h1>Island</h1>} actions={actions} />
      <div className={`island-body${panel ? " has-panel" : ""}`}>
        <div className="island-stage" ref={stage} role="img"
          aria-label={`The island in 3D, with ${residents.length} robots. Use the panel's list to find someone.`}>
          <div className="island-name" ref={hoverLabel} hidden />
          <div className="island-name is-selected" ref={selectedLabel} hidden />
          {drawn === "no" && <p className="island-note" role="status">This browser cannot draw the island in 3D here. The wishes and residents are in the panel.</p>}
          {drawn === "lost" && <div className="island-note" role="status">
            <p>The 3D view stopped.</p>
            <button type="button" className="projects-page-secondary" onClick={() => { setDrawn("starting"); setRestart((n) => n + 1); }}>Draw it again</button>
          </div>}
          {!feed.island && !feed.error && drawn !== "no" && <p className="island-note is-quiet" role="status">Sailing to the island…</p>}
          {feed.error && !feed.island && <div className="island-note" role="alert">
            <p>{feed.error}</p>
            <button type="button" className="projects-page-secondary" onClick={feed.reload}>Try again</button>
          </div>}
          {resident && <RobotCard
            resident={resident}
            row={row}
            status={status}
            mood={mood}
            housemates={resident.owner.kind === "bot" && resident.plot
              ? residents.filter((r) => r.plot?.id === resident.plot?.id && r.key !== resident.key).map((r) => r.name)
              : []}
            wish={wishOf(resident)}
            busy={!!busyAction}
            onGrant={grant}
            onOpenChat={(key) => onOpenChat(key)}
            chatKey={chatOf(row)}
            onAsk={resident.agent ? () => onAsk(resident.agent!.id, `On the OctiqFlow island, build yourself `) : undefined}
            onFarewell={resident.owner.kind === "bot" ? async () => {
              const yes = await confirm({
                title: `Say goodbye to ${resident.name}?`,
                body: `${resident.name} sails away. Its plot, what stands on it and its open wish go with it.`,
                confirmLabel: "Say goodbye",
                danger: true,
              });
              if (!yes) return;
              setSelected(null);
              await act("farewell", () => feed.farewell(resident.owner.id));
            } : undefined}
            onClose={() => setSelected(null)}
          />}
        </div>
        {panel && <aside id="island-panel" className="island-panel" aria-label="Wishes and residents">
          <div className="island-panel-head">
            <h2>Wishes</h2>
            <button type="button" className="island-close" aria-label="Close the panel" title="Close" onClick={() => setPanel(false)}>
              <CloseIcon />
            </button>
          </div>
          {actionError && <p className="island-error" role="alert">{actionError}</p>}
          {wishes.length === 0 ? (
            <p className="island-empty">No wishes right now. Robots make one now and then.</p>
          ) : (
            <ul className="island-wishes">
              {wishes.map((wish) => {
                const who = wisher(wish, residents);
                return <li key={wish.id} className="island-wish">
                  <button type="button" className="island-wish-who" onClick={() => who && setSelected(who.key)} disabled={!who}
                    title={who ? `Show ${who.name}` : undefined}>
                    <RobotDot resident={who} />
                    <bdi>{nameOf(wish)}</bdi>
                    <span className="island-meta">{ago(wish.madeAt)}</span>
                  </button>
                  <p className="island-wish-text">wishes for <bdi>{wish.text}</bdi></p>
                  <div className="island-wish-actions">
                    <button type="button" className="projects-page-primary island-grant" onClick={() => grant(wish)}
                      title="Start a chat that builds this present">Grant</button>
                    <button type="button" className="projects-page-secondary" disabled={!!busyAction}
                      onClick={() => void act(`dismiss:${wish.id}`, () => feed.dismissWish(wish.id))}>Dismiss</button>
                  </div>
                </li>;
              })}
            </ul>
          )}
          <div className="island-pace">
            <label htmlFor="island-pace">New wishes</label>
            <select id="island-pace" value={feed.island?.settings.wishPace ?? "sometimes"} disabled={!feed.island || !!busyAction}
              onChange={(event) => void act("pace", () => feed.setPace(event.target.value as WishPace))}>
              {PACES.map((pace) => <option key={pace.id} value={pace.id}>{pace.label}</option>)}
            </select>
            <button type="button" className="projects-page-secondary" disabled={!feed.island || !!busyAction}
              onClick={() => void act("roll", feed.rollWish)}>Ask for a wish</button>
          </div>
          {granted.length > 0 && <div className="island-granted">
            <button type="button" className="island-disclosure" aria-expanded={showGranted} onClick={() => setShowGranted((v) => !v)}>
              <Chevron open={showGranted} />Granted · {granted.length}
            </button>
            {showGranted && <ul>
              {granted.map((wish) => <li key={wish.id}>
                <bdi>{nameOf(wish)}</bdi> got <bdi>{wish.text}</bdi>
                {wish.grant?.by.name && <span className="island-meta"> · from <bdi>{wish.grant.by.name}</bdi></span>}
              </li>)}
            </ul>}
          </div>}
          <h2 className="island-panel-sub">Who lives here</h2>
          <ul className="island-residents">
            {residents.map((r) => {
              const agentRow = r.agent ? rows.find((x) => x.id === r.agent!.id) : undefined;
              return <li key={r.key}>
                <button type="button" aria-pressed={selected === r.key} onClick={() => setSelected(r.key)}>
                  <RobotDot resident={r} />
                  <bdi className="island-resident-name">{r.name}</bdi>
                  <span className="island-meta">{r.agent ? agentWord(agentRow) : botWord(r)}</span>
                  {wishOf(r) && <span className="island-has-wish" title="Has a wish"><GiftIcon /></span>}
                </button>
              </li>;
            })}
          </ul>
        </aside>}
      </div>
    </section>
  );
}

/** "Bolt, Mochi & Rivet". */
function listNames(names: readonly string[]): string {
  return names.length <= 1 ? names[0] ?? "" : `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

/** What an island bot is: a 波特 (the person's name for them), by its trait. */
function botWord(resident: Resident): string {
  const trait = TRAITS[resident.trait ?? ""];
  return trait ? `${trait} 波特` : "波特";
}

function agentWord(row: AgentRow | undefined): string {
  switch (row?.state) {
    case "working": return "Working";
    case "needs_you": return "Needs you";
    case "failed": return "Failed";
    default: return "Agent";
  }
}

function RobotCard({ resident, row, status, mood, housemates, wish, busy, chatKey, onGrant, onOpenChat, onAsk, onFarewell, onClose }: {
  resident: Resident;
  row: AgentRow | undefined;
  status: string | null;
  /** How bored it is, and whether work just made it happy. */
  mood: Mood | null;
  /** The 波特 it shares its home with. */
  housemates: string[];
  wish: Wish | undefined;
  busy: boolean;
  chatKey: string | null;
  onGrant: (wish: Wish) => void;
  onOpenChat: (chatKey: string) => void;
  onAsk?: () => void;
  onFarewell?: () => void;
  onClose: () => void;
}) {
  const agent = resident.agent;
  const tone = row?.state === "needs_you" ? "decide" : row?.state === "failed" ? "danger" : undefined;
  return (
    <div className="island-card" role="dialog" aria-label={resident.name}>
      <div className="island-card-head">
        {agent
          ? <AgentAvatar name={agent.name} id={agent.id} avatar={agent.avatar} size={30} decorative />
          : <RobotDot resident={resident} large />}
        <div className="island-card-who">
          <bdi className="island-card-name">{resident.name}</bdi>
          <span className="island-meta">{agent ? "Agent" : botWord(resident)}</span>
        </div>
        <button type="button" className="island-close" aria-label="Stop following" title="Stop following" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      {status && <p className="island-card-status" data-tone={tone}>{status}</p>}
      {housemates.length > 0 && <p className="island-meta island-card-home">Lives with <bdi>{listNames(housemates)}</bdi></p>}
      {mood?.said && <p className="island-card-said">“<bdi>{mood.said}</bdi>”</p>}
      {mood && <BoredomMeter boredom={mood.boredom} excited={mood.excited} />}
      {wish && <div className="island-card-wish">
        <p>Wishes for <bdi>{wish.text}</bdi></p>
        <button type="button" className="projects-page-primary island-grant" onClick={() => onGrant(wish)}>Grant</button>
      </div>}
      <div className="island-card-actions">
        {chatKey && <button type="button" className="projects-page-secondary" onClick={() => onOpenChat(chatKey)}>Open chat</button>}
        {onAsk && <button type="button" className="projects-page-secondary" onClick={onAsk}
          title="Start a chat with this agent about something to build for itself">Ask to build</button>}
        {onFarewell && <button type="button" className="projects-page-secondary" disabled={busy} onClick={onFarewell}>Say goodbye</button>}
      </div>
    </div>
  );
}

/** How bored a robot is, as a quiet bar and a number. Boredom is not a
 *  problem, so it has no colour of its own; just after work came it says
 *  so instead. */
function BoredomMeter({ boredom, excited }: { boredom: number; excited: boolean }) {
  const percent = Math.round(boredom * 100);
  return <div className="island-boredom">
    <span className="island-meta">{excited ? "Excited: work came!" : "Boredom"}</span>
    <span className="island-boredom-bar" role="meter" aria-label="Boredom" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </span>
    <span className="island-meta island-boredom-value">{percent}%</span>
  </div>;
}

function RobotDot({ resident, large = false }: { resident: Resident | undefined; large?: boolean }) {
  const style = resident
    ? { "--robot-shell": resident.look.shell, "--robot-trim": resident.look.trim, "--robot-glow": resident.look.glow } as CSSProperties
    : undefined;
  return <span className={`island-dot${large ? " is-large" : ""}`} style={style} aria-hidden="true"><span /></span>;
}

function GiftIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
    <path d="M7.5 8a2.5 2.5 0 0 1 0-5C9 3 12 8 12 8s3-5 4.5-5a2.5 2.5 0 0 1 0 5" />
  </svg>;
}

function BoatIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 17h18l-2.5 3.5H5.5z" /><path d="M12 3v14M12 4l6 9h-6" />
  </svg>;
}

function IslandIcon() {
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 18c3 0 3-1.5 5-1.5S10 18 12 18s3-1.5 5-1.5 2 1.5 5 1.5" /><path d="M5 15c2-3 12-3 14 0" />
    <path d="M12 13V6M12 6c-1.5-2-4-2-5.5-.5M12 6c1.5-2 4-2 5.5-.5M12 6c-.5-2 .5-3.5 2-4" />
  </svg>;
}

function CloseIcon() {
  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>;
}

function Chevron({ open }: { open: boolean }) {
  return <svg className={`island-chevron${open ? " is-open" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>;
}
