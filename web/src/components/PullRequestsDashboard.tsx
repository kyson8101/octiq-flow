import { useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../lib/bridge";
import {
  completionLabel,
  createRequestGate,
  filterPullRequests,
  parseUnifiedDiff,
  prAgentPrompt,
  prKey,
  shortSha,
  ticketActionLabel,
  type PrAgentAction,
  type PrAgentLaunch,
  type PrDetail,
  type PrFile,
  type PrList,
  type PrPatch,
  type PrRemoteState,
  type PrRepository,
  type PrSource,
  type PrSummary,
  type PrTicketLaunch,
  type PrWorkflow,
} from "../lib/pullRequests";
import "./PullRequestsDashboard.css";

export type PrDashboardProject = {
  id: string;
  name: string;
  primary_path?: string;
  paths?: string[];
};

export type PrDashboardChat = {
  id: string;
  title: string;
  projectId: string;
  cwd?: string;
  busy?: boolean;
};

export type PrAgentSelection = {
  provider: string;
  model: string;
  access: string;
};

type LaunchNotice = { scope: string; kind: "working" | "success" | "error"; text: string; chatId?: string };
type DetailTab = "overview" | "files" | "commits";

export function PullRequestsDashboard({
  projects,
  initialProjectId,
  chats,
  agent,
  connected,
  onClose,
  onLaunch,
  onOpenChat,
}: {
  projects: PrDashboardProject[];
  initialProjectId: string | null;
  chats: PrDashboardChat[];
  agent: PrAgentSelection;
  connected: boolean;
  onClose: () => void;
  onLaunch: (launch: PrAgentLaunch) => Promise<string>;
  onOpenChat: (chatId: string) => void;
}) {
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "");
  const project = projects.find((item) => item.id === projectId) ?? null;
  const [repositories, setRepositories] = useState<PrRepository[]>([]);
  const [repositoriesState, setRepositoriesState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [repositoriesError, setRepositoriesError] = useState("");
  const [repositoriesRefresh, setRepositoriesRefresh] = useState(0);
  const [root, setRoot] = useState("");
  const repository = repositories.find((item) => item.root === root) ?? null;
  const [source, setSource] = useState<PrSource>("local");
  const [localBase, setLocalBase] = useState("");
  const [remoteState, setRemoteState] = useState<PrRemoteState>("open");
  const [listRefresh, setListRefresh] = useState(0);
  const [query, setQuery] = useState("");
  const [lists, setLists] = useState<Partial<Record<PrSource, PrList>>>({});
  const [listLoading, setListLoading] = useState<Partial<Record<PrSource, boolean>>>({});
  const [listErrors, setListErrors] = useState<Partial<Record<PrSource, string>>>({});
  const [selectedKey, setSelectedKey] = useState("");
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [tab, setTab] = useState<DetailTab>("overview");
  const [mobileDetail, setMobileDetail] = useState(false);
  const [filePath, setFilePath] = useState("");
  const [patches, setPatches] = useState<Record<string, PrPatch>>({});
  const [patchLoading, setPatchLoading] = useState(false);
  const [patchError, setPatchError] = useState("");
  const [workflow, setWorkflow] = useState<PrWorkflow | null>(null);
  const [workflowLoading, setWorkflowLoading] = useState(false);
  const [workflowError, setWorkflowError] = useState("");
  const [linkChatId, setLinkChatId] = useState("");
  const [ticketReference, setTicketReference] = useState("");
  const [ticketUrl, setTicketUrl] = useState("");
  const [completeOn, setCompleteOn] = useState<"approved" | "merged">("merged");
  const [ticketMessage, setTicketMessage] = useState("");
  const [ticketChecked, setTicketChecked] = useState(false);
  const [launchNotice, setLaunchNotice] = useState<LaunchNotice | null>(null);

  const repositoriesGate = useRef(createRequestGate()).current;
  const localListGate = useRef(createRequestGate()).current;
  const remoteListGate = useRef(createRequestGate()).current;
  const detailGate = useRef(createRequestGate()).current;
  const patchGate = useRef(createRequestGate()).current;
  const workflowGate = useRef(createRequestGate()).current;
  const detailScope = detail ? `${detail.pr.root}:${prKey(detail.pr)}:${detail.pr.headSha}` : "";

  useEffect(() => {
    const valid = projects.some((item) => item.id === projectId);
    if (!valid) setProjectId(initialProjectId ?? projects[0]?.id ?? "");
  }, [projects, projectId, initialProjectId]);

  useEffect(() => {
    const token = repositoriesGate.next();
    setRepositories([]);
    setRoot("");
    setLists({});
    setSelectedKey("");
    setDetail(null);
    setRepositoriesError("");
    if (!project) {
      setRepositoriesState("idle");
      return;
    }
    const paths = [...new Set([project.primary_path, ...(project.paths ?? [])].filter((path): path is string => !!path))];
    if (paths.length === 0) {
      setRepositoriesState("error");
      setRepositoriesError("This project has no folders to inspect.");
      return;
    }
    setRepositoriesState("loading");
    bridge.invoke<PrRepository[]>("pr_repositories", { paths })
      .then((items) => {
        if (!repositoriesGate.current(token)) return;
        const next = items ?? [];
        setRepositories(next);
        setRepositoriesState("ready");
        const preferred = next.find((item) => item.root === project.primary_path) ?? next[0];
        setRoot(preferred?.root ?? "");
      })
      .catch((error: unknown) => {
        if (!repositoriesGate.current(token)) return;
        setRepositoriesState("error");
        setRepositoriesError(errorText(error));
      });
  }, [projectId, project, repositoriesRefresh, repositoriesGate]);

  useEffect(() => {
    setLocalBase(repository?.defaultBase || repository?.branches[0] || "");
    setLists({});
    setListErrors({});
    setSelectedKey("");
    setDetail(null);
    setPatches({});
  }, [repository?.root]);

  useEffect(() => {
    const token = localListGate.next();
    if (!root || !localBase) return;
    setListLoading((before) => ({ ...before, local: true }));
    setListErrors((before) => ({ ...before, local: "" }));
    bridge.invoke<PrList>("pr_local_list", { root, base: localBase })
      .then((answer) => {
        if (!localListGate.current(token)) return;
        setLists((before) => ({ ...before, local: answer ?? { items: [], warnings: [] } }));
      })
      .catch((error: unknown) => {
        if (!localListGate.current(token)) return;
        setListErrors((before) => ({ ...before, local: errorText(error) }));
      })
      .finally(() => {
        if (localListGate.current(token)) setListLoading((before) => ({ ...before, local: false }));
      });
  }, [root, localBase, listRefresh, localListGate]);

  useEffect(() => {
    const token = remoteListGate.next();
    if (!root || source !== "github") return;
    setListLoading((before) => ({ ...before, github: true }));
    setListErrors((before) => ({ ...before, github: "" }));
    bridge.invoke<PrList>("pr_remote_list", { root, state: remoteState })
      .then((answer) => {
        if (!remoteListGate.current(token)) return;
        setLists((before) => ({ ...before, github: answer ?? { items: [], warnings: [] } }));
      })
      .catch((error: unknown) => {
        if (!remoteListGate.current(token)) return;
        setListErrors((before) => ({ ...before, github: errorText(error) }));
      })
      .finally(() => {
        if (remoteListGate.current(token)) setListLoading((before) => ({ ...before, github: false }));
      });
  }, [root, source, remoteState, listRefresh, remoteListGate]);

  const visibleItems = useMemo(
    () => filterPullRequests(lists[source]?.items ?? [], query),
    [lists, source, query],
  );
  const selected = (lists[source]?.items ?? []).find((item) => prKey(item) === selectedKey) ?? null;

  useEffect(() => {
    if (selected && visibleItems.some((item) => prKey(item) === selectedKey)) return;
    setSelectedKey(visibleItems[0] ? prKey(visibleItems[0]) : "");
  }, [source, visibleItems, selected, selectedKey]);

  useEffect(() => {
    const token = detailGate.next();
    setDetail(null);
    setDetailError("");
    setPatches({});
    setFilePath("");
    setWorkflow(null);
    setWorkflowError("");
    if (!selected) {
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    const args = selected.source === "github"
      ? { root: selected.root, source: selected.source, number: selected.number }
      : { root: selected.root, source: selected.source, branch: selected.branch, base: selected.base };
    bridge.invoke<PrDetail>("pr_detail", args)
      .then((answer) => {
        if (!detailGate.current(token)) return;
        setDetail(answer);
        setFilePath(answer.files[0]?.path ?? "");
      })
      .catch((error: unknown) => {
        if (detailGate.current(token)) setDetailError(errorText(error));
      })
      .finally(() => {
        if (detailGate.current(token)) setDetailLoading(false);
      });
  }, [selectedKey, selected, detailGate]);

  useEffect(() => {
    const token = workflowGate.next();
    setWorkflow(null);
    setWorkflowError("");
    if (!detail || detail.pr.source !== "github" || detail.pr.number == null) return;
    setWorkflowLoading(true);
    bridge.invoke<PrWorkflow | null>("pr_workflow_get", { root: detail.pr.root, number: detail.pr.number })
      .then((answer) => {
        if (workflowGate.current(token)) setWorkflow(answer);
      })
      .catch((error: unknown) => {
        if (workflowGate.current(token)) setWorkflowError(errorText(error));
      })
      .finally(() => {
        if (workflowGate.current(token)) setWorkflowLoading(false);
      });
  }, [detail?.pr.root, detail?.pr.number, detail?.pr.headSha, detail?.pr.source, workflowGate]);

  useEffect(() => {
    if (!workflow) {
      setLinkChatId("");
      setTicketReference("");
      setTicketUrl("");
      setCompleteOn("merged");
      return;
    }
    setLinkChatId(workflow.chatId ?? "");
    setTicketReference(workflow.ticket?.reference ?? "");
    setTicketUrl(workflow.ticket?.url ?? "");
    setCompleteOn(workflow.completeOn ?? "merged");
  }, [workflow?.updatedAt, workflow?.headSha]);

  useEffect(() => {
    setTicketChecked(false);
    setTicketMessage("");
  }, [workflow?.ticketAction?.id]);

  useEffect(() => {
    if (!detail || detail.pr.source !== "github" || detail.pr.number == null) return;
    return bridge.on("pull-request-workflow", (payload) => {
      const next = payload as PrWorkflow | undefined;
      if (next?.root === detail.pr.root && next.number === detail.pr.number) setWorkflow(next);
    });
  }, [detail?.pr.root, detail?.pr.number, detail?.pr.source]);

  const selectedFile = detail?.files.find((file) => file.path === filePath) ?? null;
  const patchKey = detail && selectedFile ? `${detail.pr.headSha}:${selectedFile.path}` : "";
  useEffect(() => {
    const token = patchGate.next();
    setPatchError("");
    setPatchLoading(false);
    if (!detail || !selectedFile || selectedFile.patch != null || selectedFile.binary || patches[patchKey]
      || detail.pr.source === "github") return;
    setPatchLoading(true);
    bridge.invoke<PrPatch>("pr_file_diff", {
      root: detail.pr.root,
      baseSha: detail.mergeBaseSha ?? detail.pr.baseSha,
      headSha: detail.pr.headSha,
      file: selectedFile.path,
      oldPath: selectedFile.oldPath,
    })
      .then((answer) => {
        if (patchGate.current(token)) setPatches((before) => ({ ...before, [patchKey]: answer }));
      })
      .catch((error: unknown) => {
        if (patchGate.current(token)) setPatchError(errorText(error));
      })
      .finally(() => {
        if (patchGate.current(token)) setPatchLoading(false);
      });
  }, [detail, selectedFile, patchKey, patches, patchGate]);

  const startAgent = async (action: PrAgentAction) => {
    if (!detail || !project) return;
    const scope = detailScope;
    const request = prAgentPrompt(action, detail);
    setLaunchNotice({ scope, kind: "working", text: `Starting ${action === "publish" ? "publication" : action} chat…` });
    try {
      const chatId = await onLaunch({ ...request, projectId: project.id });
      setLaunchNotice({ scope, kind: "success", text: `${request.title} started in a separate chat.`, chatId });
    } catch (error) {
      setLaunchNotice({ scope, kind: "error", text: `Could not start agent chat: ${errorText(error)}` });
    }
  };

  const saveWorkflow = async () => {
    if (!detail || detail.pr.number == null) return;
    const token = workflowGate.next();
    setWorkflowLoading(true);
    setWorkflowError("");
    try {
      const next = await bridge.invoke<PrWorkflow>("pr_workflow_save", {
        root: detail.pr.root,
        number: detail.pr.number,
        expectedHeadSha: detail.pr.headSha,
        chatId: linkChatId || null,
        ticket: ticketReference.trim()
          ? { reference: ticketReference.trim(), url: ticketUrl.trim() || null }
          : null,
        completeOn,
      });
      if (workflowGate.current(token)) setWorkflow(next);
    } catch (error) {
      if (workflowGate.current(token)) setWorkflowError(errorText(error));
    } finally {
      if (workflowGate.current(token)) setWorkflowLoading(false);
    }
  };

  const refreshWorkflow = async () => {
    if (!detail || detail.pr.number == null) return;
    const token = workflowGate.next();
    setWorkflowLoading(true);
    setWorkflowError("");
    try {
      const next = await bridge.invoke<PrWorkflow | null>("pr_completion_refresh", {
        root: detail.pr.root,
        number: detail.pr.number,
      });
      if (workflowGate.current(token)) setWorkflow(next);
    } catch (error) {
      if (workflowGate.current(token)) setWorkflowError(errorText(error));
    } finally {
      if (workflowGate.current(token)) setWorkflowLoading(false);
    }
  };

  const prepareTicket = async () => {
    if (!detail || detail.pr.number == null || !project) return;
    const token = workflowGate.next();
    const scope = detailScope;
    setWorkflowLoading(true);
    setWorkflowError("");
    setLaunchNotice({ scope, kind: "working", text: "Preparing ticket completion chat…" });
    let launch: PrTicketLaunch | null = null;
    try {
      launch = await bridge.invoke<PrTicketLaunch>("pr_ticket_prepare", {
        root: detail.pr.root,
        number: detail.pr.number,
        expectedHeadSha: detail.pr.headSha,
      });
      if (workflowGate.current(token)) setWorkflow(launch.workflow);
      const chatId = await onLaunch({
        projectId: project.id,
        cwd: launch.cwd,
        title: launch.title,
        prompt: launch.prompt,
      });
      const next = await bridge.invoke<PrWorkflow>("pr_ticket_attach", { actionId: launch.actionId, chatId });
      if (workflowGate.current(token)) setWorkflow(next);
      setLaunchNotice({ scope, kind: "success", text: "Ticket completion agent started. Confirm the ticket only after checking its result.", chatId });
    } catch (error) {
      const message = `Could not start ticket completion: ${errorText(error)}`;
      setLaunchNotice({ scope, kind: "error", text: message });
      if (workflowGate.current(token)) setWorkflowError(message);
      if (launch) {
        try {
          const failed = await bridge.invoke<PrWorkflow>("pr_ticket_confirm", {
            actionId: launch.actionId,
            confirmed: false,
            message,
          });
          if (workflowGate.current(token)) setWorkflow(failed);
        } catch {
          // The visible launch error remains authoritative when failure recording
          // itself cannot be reached; a refresh can reconcile it later.
        }
      }
    } finally {
      if (workflowGate.current(token)) setWorkflowLoading(false);
    }
  };

  const confirmTicket = async (confirmed: boolean) => {
    const action = workflow?.ticketAction;
    if (!action) return;
    const token = workflowGate.next();
    setWorkflowLoading(true);
    setWorkflowError("");
    try {
      const next = await bridge.invoke<PrWorkflow>("pr_ticket_confirm", {
        actionId: action.id,
        confirmed,
        message: ticketMessage.trim() || (confirmed
          ? "Ticket update checked and confirmed by the user."
          : "Ticket update was not completed; retry is required."),
      });
      if (workflowGate.current(token)) {
        setWorkflow(next);
        setTicketChecked(false);
        setTicketMessage("");
      }
    } catch (error) {
      if (workflowGate.current(token)) setWorkflowError(errorText(error));
    } finally {
      if (workflowGate.current(token)) setWorkflowLoading(false);
    }
  };

  const currentList = lists[source];
  const currentError = listErrors[source];
  const currentLoading = !!listLoading[source];
  const shownLaunch = launchNotice?.scope === detailScope ? launchNotice : null;
  const isLaunching = shownLaunch?.kind === "working";

  return (
    <section className={`pr-dashboard${mobileDetail ? " show-detail" : ""}`} aria-label="Pull requests dashboard">
      <header className="pr-dashboard-head">
        <button type="button" className="pr-back" onClick={onClose} aria-label="Back to chat">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          <span>Chat</span>
        </button>
        <div className="pr-heading">
          <h1>Pull requests</h1>
          <span>{repository ? repository.name : "Review local and GitHub work"}</span>
        </div>
        <div className="pr-agent-setting" title="New agent chats use the current chat settings">
          <span className="pr-agent-dot" aria-hidden="true" />
          <span>{agent.provider} · {agent.model}</span>
          <small>{agent.access}</small>
        </div>
      </header>

      <div className="pr-toolbar">
        <label>
          <span>Project</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>
          <span>Repository</span>
          <select value={root} disabled={repositoriesState !== "ready" || repositories.length === 0} onChange={(event) => setRoot(event.target.value)}>
            {repositoriesState === "loading" && <option value="">Finding repositories…</option>}
            {repositoriesState === "ready" && repositories.length === 0 && <option value="">No Git repositories</option>}
            {repositories.map((item) => <option key={item.root} value={item.root}>{item.name} — {item.root}</option>)}
          </select>
        </label>
        <div className="pr-source-switch" role="group" aria-label="Pull request source">
          <button type="button" aria-pressed={source === "local"} onClick={() => setSource("local")}>Local <span>{lists.local?.items.length ?? ""}</span></button>
          <button type="button" aria-pressed={source === "github"} onClick={() => setSource("github")}>GitHub <span>{lists.github?.items.length ?? ""}</span></button>
        </div>
        {source === "local" ? (
          <label className="pr-filter-control">
            <span>Target</span>
            <select value={localBase} disabled={!repository} onChange={(event) => setLocalBase(event.target.value)}>
              {[...new Set([repository?.defaultBase, ...(repository?.branches ?? [])].filter((item): item is string => !!item))].map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        ) : (
          <label className="pr-filter-control">
            <span>State</span>
            <select value={remoteState} onChange={(event) => setRemoteState(event.target.value as PrRemoteState)}>
              <option value="open">Open</option><option value="closed">Closed</option><option value="merged">Merged</option><option value="all">All</option>
            </select>
          </label>
        )}
        <label className="pr-search">
          <span className="sr-only">Search pull requests</span>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search title, branch, author…" />
        </label>
      </div>

      {repositoriesError && <div className="pr-banner is-error" role="alert"><span>Could not list repositories: {repositoriesError}</span><button type="button" onClick={() => setRepositoriesRefresh((value) => value + 1)}>Retry</button></div>}
      {!connected && <div className="pr-banner is-error" role="alert">The server is disconnected. Existing chats keep running; reconnect to refresh pull requests.</div>}

      <div className="pr-desk">
        <aside className="pr-list-pane" aria-label={`${source === "local" ? "Local changes" : "GitHub pull requests"} list`}>
          <div className="pr-list-title">
            <strong>{source === "local" ? "Unpublished branches" : "GitHub pull requests"}</strong>
            {currentLoading ? <span className="pr-spinner" role="status" aria-label="Loading pull requests" /> : <button type="button" onClick={() => setListRefresh((value) => value + 1)} aria-label="Refresh pull requests" title="Refresh pull requests">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5" /><path d="M18 9a7 7 0 0 0-12-2L4 11M6 15a7 7 0 0 0 12 2l2-4" /></svg>
            </button>}
          </div>
          {currentList?.warnings.map((warning) => <p key={warning} className="pr-list-warning">{warning}</p>)}
          {currentError ? (
            <EmptyPanel title={source === "github" ? "GitHub is unavailable" : "Local branches could not be read"} detail={`${currentError} ${source === "github" ? "Your Local list is still available." : ""}`} />
          ) : !root ? (
            <EmptyPanel title="Choose a repository" detail="Select a project and repository to browse its work." />
          ) : currentLoading && !currentList ? (
            <ListSkeleton />
          ) : visibleItems.length === 0 ? (
            <EmptyPanel
              title={query ? "No matching pull requests" : source === "local" ? "No unpublished branches" : "No GitHub pull requests"}
              detail={query ? "Try a branch, author, PR number, or fewer words." : source === "local" ? `Every branch matches ${localBase}, or only the target branch exists.` : `No ${remoteState} pull requests were returned.`}
            />
          ) : (
            <div className="pr-list" role="list">
              {visibleItems.map((item) => (
                <PrListItem
                  key={prKey(item)}
                  item={item}
                  active={prKey(item) === selectedKey}
                  onClick={() => { setSelectedKey(prKey(item)); setMobileDetail(true); }}
                />
              ))}
            </div>
          )}
        </aside>

        <article className="pr-detail-pane">
          <button type="button" className="pr-mobile-list-back" onClick={() => setMobileDetail(false)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            Pull requests
          </button>
          {detailLoading ? <DetailSkeleton /> : detailError ? (
            <EmptyPanel title="Could not open this snapshot" detail={detailError} />
          ) : !detail ? (
            <EmptyPanel title="Select work to inspect" detail="Choose a branch comparison or GitHub pull request. Its exact head and base SHAs will be pinned here." />
          ) : (
            <>
              <div className="pr-detail-head">
                <div>
                  <div className="pr-detail-kicker">
                    <StatusPill state={detail.pr.state} />
                    <span>{detail.pr.number == null ? "Local comparison" : `#${detail.pr.number}`}</span>
                    <span className="pr-sha">{shortSha(detail.pr.headSha)}</span>
                  </div>
                  <h2>{detail.pr.title}</h2>
                  <p><strong>{detail.pr.branch}</strong><span aria-hidden="true"> → </span>{detail.pr.base}</p>
                </div>
                <div className="pr-agent-actions">
                  <button type="button" disabled={isLaunching || !connected} onClick={() => void startAgent("study")}>Study</button>
                  <button type="button" disabled={isLaunching || !connected} onClick={() => void startAgent("review")}>Request review</button>
                  {detail.pr.source === "local" && <button type="button" className="is-primary" disabled={isLaunching || !connected} onClick={() => void startAgent("publish")}>Create GitHub PR</button>}
                  {detail.pr.url && <a href={detail.pr.url} target="_blank" rel="noreferrer noopener">Open on GitHub</a>}
                </div>
              </div>
              {shownLaunch && (
                <div className={`pr-launch-notice is-${shownLaunch.kind}`} role={shownLaunch.kind === "error" ? "alert" : "status"}>
                  <span>{shownLaunch.text}</span>
                  {shownLaunch.chatId && <button type="button" onClick={() => onOpenChat(shownLaunch.chatId!)}>Open chat</button>}
                </div>
              )}
              <div className="pr-tabs" role="tablist" aria-label="Pull request detail">
                <TabButton value="overview" current={tab} onPick={setTab}>Overview</TabButton>
                <TabButton value="files" current={tab} onPick={setTab}>Files changed <span>{detail.files.length}</span></TabButton>
                <TabButton value="commits" current={tab} onPick={setTab}>Commits <span>{detail.commits.length}</span></TabButton>
              </div>
              {detail.warnings.map((warning) => <div key={warning} className="pr-banner">{warning}</div>)}
              {tab === "overview" && (
                <Overview
                  detail={detail}
                  workflow={workflow}
                  workflowLoading={workflowLoading}
                  workflowError={workflowError}
                  chats={chats.filter((chat) => chat.projectId === projectId)}
                  linkChatId={linkChatId}
                  ticketReference={ticketReference}
                  ticketUrl={ticketUrl}
                  completeOn={completeOn}
                  ticketMessage={ticketMessage}
                  ticketChecked={ticketChecked}
                  onLinkChat={setLinkChatId}
                  onTicketReference={setTicketReference}
                  onTicketUrl={setTicketUrl}
                  onCompleteOn={setCompleteOn}
                  onTicketMessage={setTicketMessage}
                  onTicketChecked={setTicketChecked}
                  onSave={() => void saveWorkflow()}
                  onRefresh={() => void refreshWorkflow()}
                  onPrepareTicket={() => void prepareTicket()}
                  onConfirmTicket={(confirmed) => void confirmTicket(confirmed)}
                  onOpenChat={onOpenChat}
                />
              )}
              {tab === "files" && (
                <FilesView
                  detail={detail}
                  selected={selectedFile}
                  filePath={filePath}
                  patch={selectedFile?.patch ?? (patchKey ? patches[patchKey]?.text : null) ?? null}
                  loadedPatch={patchKey ? patches[patchKey] : undefined}
                  loading={patchLoading}
                  error={patchError}
                  onFile={setFilePath}
                />
              )}
              {tab === "commits" && <CommitsView detail={detail} />}
            </>
          )}
        </article>
      </div>
    </section>
  );
}

function TabButton({ value, current, onPick, children }: { value: DetailTab; current: DetailTab; onPick: (tab: DetailTab) => void; children: React.ReactNode }) {
  return <button type="button" role="tab" aria-selected={current === value} onClick={() => onPick(value)}>{children}</button>;
}

function PrListItem({ item, active, onClick }: { item: PrSummary; active: boolean; onClick: () => void }) {
  return (
    <button type="button" role="listitem" className="pr-list-item" aria-current={active ? "true" : undefined} onClick={onClick}>
      <span className="pr-list-item-top"><StatusPill state={item.state} /><span>{item.number == null ? shortSha(item.headSha) : `#${item.number}`}</span><time>{relativeDate(item.updatedAt)}</time></span>
      <strong>{item.title}</strong>
      <span className="pr-list-branch"><b>{item.branch}</b><span aria-hidden="true"> → </span>{item.base}</span>
      <span className="pr-list-stats"><i className="is-add">+{item.additions}</i><i className="is-del">−{item.deletions}</i><span>{item.changedFiles} files</span><span>{item.commitCount} commits</span></span>
    </button>
  );
}

function StatusPill({ state }: { state: PrSummary["state"] }) {
  return <span className="pr-status" data-state={state}>{state === "local" ? "Local" : state}</span>;
}

function Overview({
  detail, workflow, workflowLoading, workflowError, chats,
  linkChatId, ticketReference, ticketUrl, completeOn, ticketMessage, ticketChecked,
  onLinkChat, onTicketReference, onTicketUrl, onCompleteOn, onTicketMessage, onTicketChecked,
  onSave, onRefresh, onPrepareTicket, onConfirmTicket, onOpenChat,
}: {
  detail: PrDetail;
  workflow: PrWorkflow | null;
  workflowLoading: boolean;
  workflowError: string;
  chats: PrDashboardChat[];
  linkChatId: string;
  ticketReference: string;
  ticketUrl: string;
  completeOn: "approved" | "merged";
  ticketMessage: string;
  ticketChecked: boolean;
  onLinkChat: (value: string) => void;
  onTicketReference: (value: string) => void;
  onTicketUrl: (value: string) => void;
  onCompleteOn: (value: "approved" | "merged") => void;
  onTicketMessage: (value: string) => void;
  onTicketChecked: (value: boolean) => void;
  onSave: () => void;
  onRefresh: () => void;
  onPrepareTicket: () => void;
  onConfirmTicket: (confirmed: boolean) => void;
  onOpenChat: (chatId: string) => void;
}) {
  const { pr } = detail;
  const action = workflow?.ticketAction ?? null;
  const ticketAgentBusy = !!action?.chatId && chats.find((chat) => chat.id === action.chatId)?.busy === true;
  const canPrepareTicket = workflow?.completion.state === "completed" && !!workflow.ticket
    && action?.status !== "confirmed" && action?.status !== "running" && action?.status !== "pending";
  return (
    <div className="pr-overview">
      <div className="pr-overview-main">
        <section className="pr-summary-copy">
          <h3>Summary</h3>
          {detail.body ? <p>{detail.body}</p> : <p className="is-muted">No description was provided.</p>}
        </section>
        <section>
          <h3>Snapshot</h3>
          <dl className="pr-facts">
            <div><dt>Author</dt><dd>{pr.author || "Unknown"}</dd></div>
            <div><dt>Updated</dt><dd>{fullDate(pr.updatedAt)}</dd></div>
            <div><dt>Head</dt><dd title={pr.headSha}>{shortSha(pr.headSha)}</dd></div>
            <div><dt>Base</dt><dd title={pr.baseSha}>{shortSha(pr.baseSha)}</dd></div>
            <div><dt>Merge base</dt><dd title={detail.mergeBaseSha ?? ""}>{shortSha(detail.mergeBaseSha ?? "")}</dd></div>
            <div><dt>Review</dt><dd>{pr.approved ? "Approved for current head" : pr.reviewDecision || "No decision"}</dd></div>
          </dl>
        </section>
      </div>
      <aside className="pr-overview-side">
        <div className="pr-change-tally" aria-label={`${pr.additions} additions and ${pr.deletions} deletions`}>
          <div><strong>{pr.changedFiles}</strong><span>files</span></div><div><strong className="is-add">+{pr.additions}</strong><span>added</span></div><div><strong className="is-del">−{pr.deletions}</strong><span>removed</span></div>
        </div>
        {pr.source === "github" && (
          <section className="pr-workflow-card">
            <div className="pr-workflow-head"><div><h3>Tracked completion</h3><p>Link this PR to its work, then choose the verified event that completes it.</p></div><button type="button" disabled={workflowLoading} onClick={onRefresh}>Refresh</button></div>
            <label>Originating chat<select value={linkChatId} onChange={(event) => onLinkChat(event.target.value)}><option value="">No linked chat</option>{chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label>
            <div className="pr-workflow-ticket-row">
              <label>Ticket reference<input value={ticketReference} onChange={(event) => onTicketReference(event.target.value)} placeholder="T26050092" /></label>
              <label>Ticket URL <span>optional</span><input type="url" value={ticketUrl} onChange={(event) => onTicketUrl(event.target.value)} placeholder="https://…" /></label>
            </div>
            <fieldset><legend>Complete this work when</legend><label><input type="radio" name="pr-complete-on" checked={completeOn === "merged"} onChange={() => onCompleteOn("merged")} /> PR is merged <span>default</span></label><label><input type="radio" name="pr-complete-on" checked={completeOn === "approved"} onChange={() => onCompleteOn("approved")} /> Current head is approved</label></fieldset>
            <button type="button" className="is-primary" disabled={workflowLoading} onClick={onSave}>{workflowLoading ? "Saving…" : "Save tracking"}</button>
            {workflowError && <p className="pr-inline-error" role="alert">{workflowError}</p>}
            {workflow && (
              <div className="pr-workflow-state" data-state={workflow.completion.state}>
                <span className="pr-workflow-mark" aria-hidden="true" />
                <div><strong>{completionLabel(workflow)}</strong><p>{workflow.completion.note || `Checked against ${shortSha(workflow.headSha)}.`}</p></div>
              </div>
            )}
            {workflow?.ticket && workflow.completion.state === "pending" && <p className="pr-ticket-note">Ticket completion becomes available only after this PR meets its tracked completion rule.</p>}
            {workflow?.ticket && workflow.completion.state === "completed" && (
              <div className="pr-ticket-action">
                <div><strong>Complete {workflow.ticket.reference}</strong><span>{ticketActionLabel(action)}</span></div>
                {action?.chatId && <button type="button" onClick={() => onOpenChat(action.chatId!)}>Open agent chat</button>}
                {canPrepareTicket && <button type="button" className="is-primary" disabled={workflowLoading} onClick={onPrepareTicket}>{action?.status === "failed" ? "Retry ticket update" : "Start ticket update"}</button>}
                {action?.status === "running" && ticketAgentBusy && <p className="pr-ticket-note">The agent turn is still running. Confirmation unlocks when it finishes.</p>}
                {action?.status === "running" && !ticketAgentBusy && (
                  <div className="pr-ticket-confirm">
                    <label>Confirmation note <span>optional</span><textarea value={ticketMessage} onChange={(event) => onTicketMessage(event.target.value)} placeholder="What did you verify in the ticket?" /></label>
                    <label className="pr-check"><input type="checkbox" checked={ticketChecked} onChange={(event) => onTicketChecked(event.target.checked)} /> I checked the ticket after the agent finished and the PR link and resolution are present.</label>
                    <div><button type="button" className="is-primary" disabled={!ticketChecked || workflowLoading} onClick={() => onConfirmTicket(true)}>Confirm ticket updated</button><button type="button" disabled={workflowLoading} onClick={() => onConfirmTicket(false)}>Mark failed</button></div>
                    <p>User-confirmed status is recorded here; OctiqFlow does not claim an independent remote verification.</p>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}

function FilesView({ detail, selected, filePath, patch, loadedPatch, loading, error, onFile }: { detail: PrDetail; selected: PrFile | null; filePath: string; patch: string | null; loadedPatch?: PrPatch; loading: boolean; error: string; onFile: (path: string) => void }) {
  const unavailable = selected?.patchUnavailable;
  return (
    <div className="pr-files-view">
      <nav className="pr-file-list" aria-label="Changed files">
        {detail.files.map((file) => <button type="button" key={file.path} aria-current={file.path === filePath ? "true" : undefined} onClick={() => onFile(file.path)}><span className="pr-file-status">{file.status.slice(0, 1).toUpperCase()}</span><span title={file.path}>{file.path}</span><i className="is-add">+{file.additions}</i><i className="is-del">−{file.deletions}</i></button>)}
      </nav>
      <section className="pr-diff-pane" aria-label={selected ? `Diff for ${selected.path}` : "File diff"}>
        {selected && <header><div><strong>{selected.path}</strong>{selected.oldPath && selected.oldPath !== selected.path && <span>renamed from {selected.oldPath}</span>}</div><span><i className="is-add">+{selected.additions}</i> <i className="is-del">−{selected.deletions}</i></span></header>}
        {loading ? <div className="pr-diff-empty"><span className="pr-spinner" /> Loading the pinned file diff…</div>
          : error ? <div className="pr-diff-empty is-error" role="alert">Could not load this file diff: {error}</div>
            : selected?.binary || loadedPatch?.binary ? <div className="pr-diff-empty">Binary file. A text diff is not available.</div>
              : loadedPatch?.tooLarge ? <div className="pr-diff-empty">This patch is too large to display. The file remains part of the pinned snapshot.</div>
                : patch != null ? <UnifiedDiff text={patch} />
                  : <div className="pr-diff-empty">{unavailable || "No text patch was returned for this file."}</div>}
      </section>
    </div>
  );
}

export function UnifiedDiff({ text }: { text: string }) {
  const lines = parseUnifiedDiff(text);
  if (lines.length === 0) return <div className="pr-diff-empty">No textual changes in this patch.</div>;
  return <div className="pr-diff" role="table" aria-label="Unified diff">{lines.map((line, index) => <div className="pr-diff-line" data-kind={line.kind} role="row" key={`${index}-${line.text}`}><span role="cell" className="pr-line-no">{line.oldLine ?? ""}</span><span role="cell" className="pr-line-no">{line.newLine ?? ""}</span><code role="cell">{line.text || " "}</code></div>)}</div>;
}

function CommitsView({ detail }: { detail: PrDetail }) {
  if (detail.commits.length === 0) return <EmptyPanel title="No commits returned" detail="The selected snapshot did not include commit metadata." />;
  return <ol className="pr-commits">{detail.commits.map((commit, index) => <li key={commit.sha}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{commit.title}</strong><p>{commit.author}</p></div><code title={commit.sha}>{shortSha(commit.sha)}</code></li>)}</ol>;
}

function EmptyPanel({ title, detail }: { title: string; detail: string }) {
  return <div className="pr-empty"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M7 3h7l4 4v14H7z" /><path d="M14 3v5h5M9.5 13h5M9.5 17h3" /></svg><strong>{title}</strong><p>{detail}</p></div>;
}

function ListSkeleton() {
  return <div className="pr-list-skeleton" aria-label="Loading"><i /><i /><i /></div>;
}

function DetailSkeleton() {
  return <div className="pr-detail-skeleton" aria-label="Loading pull request"><i /><i /><i /><i /></div>;
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error);
}

function relativeDate(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "";
  const days = Math.round((Date.now() - time) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d`;
  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}

function fullDate(value: string): string {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Unknown";
}
