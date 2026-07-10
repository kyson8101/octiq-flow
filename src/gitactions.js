// Git tab (right panel). Common git actions for the selected project's PRIMARY
// repo: open the diff viewer, switch branch (dropdown of local branches), commit
// tracked changes, and push.
//
// How it runs:
//   * "View diff" re-uses the existing diff viewer by dispatching the same
//     `project-gitdiff` event the project right-click menu uses (spans every
//     repo in the project's folder paths).
//   * Switch / Commit / Push run as REAL PTY terminals through commands.js's
//     runManagedCommand, so output is visible in the command popup and a push
//     that needs a login prompt still works. They run in the project's primary
//     folder (git walks up to the repo root from there).
//
// The branch list is the one read-only backend call (`git_local_branches`); the
// write actions are plain git in a terminal, so we never shell out to mutate git
// from Rust.
import { runManagedCommand } from "/commands.js";
import { shQuote } from "/util.js";

const { invoke } = window.__TAURI__.core;

// A branch switch is typed into the terminal, not run by us, so there is no
// completion signal to wait on. Show the new branch optimistically, then re-read
// the real state after roughly the time `git switch` takes to finish.
const BRANCH_RECONCILE_MS = 1200;

// --- DOM handles -----------------------------------------------------------
const hintEl = document.querySelector("#git-hint");
const actionsEl = document.querySelector("#git-actions");
const branchNameEl = document.querySelector("#git-current-branch");
const branchRefreshBtn = document.querySelector("#git-branch-refresh");
const diffBtn = document.querySelector("#git-diff-btn");
const branchSelect = document.querySelector("#git-branch-select");
const switchBtn = document.querySelector("#git-switch-btn");
const commitMsgEl = document.querySelector("#git-commit-msg");
const commitBtn = document.querySelector("#git-commit-btn");
const pushBtn = document.querySelector("#git-push-btn");

// --- State -----------------------------------------------------------------
// The selected project, mirrored from the project-selected event.
let project = null; // { id, name, primaryPath, paths } or null
// The repo's current branch, kept so a no-op "switch to same branch" is skipped.
let currentBranch = "";
// True only when the primary folder is a git repo (switch/commit/push enabled).
let repoReady = false;

// --- Shell quoting ----------------------------------------------------------
// --- Project selection ------------------------------------------------------
window.addEventListener("project-selected", (e) => {
  project = e.detail || null;
  // Reset until the next branch load resolves the repo state.
  currentBranch = "";
  repoReady = false;
  // The Git section is always visible now, so load branches on every selection.
  loadBranches();
});

// --- Branch loading + state -------------------------------------------------
/** Load the primary repo's local branches and re-render the tab. No-op when no
 *  project is selected. */
async function loadBranches() {
  if (!project) {
    repoReady = false;
    renderState();
    return;
  }
  let info;
  try {
    info = await invoke("git_local_branches", { path: project.primaryPath || "" });
  } catch {
    info = { is_repo: false, current: "", branches: [] };
  }
  repoReady = !!info.is_repo;
  currentBranch = info.current || "";
  fillBranches(info.branches || [], currentBranch);
  renderState();
}

/** Fill the dropdown with branch names, selecting the current branch. */
function fillBranches(branches, current) {
  branchSelect.replaceChildren();
  for (const name of branches) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === current) opt.selected = true;
    branchSelect.append(opt);
  }
}

/** Show the right thing for the current project + repo state: a hint when there
 *  is no project, the actions otherwise, with write actions disabled when the
 *  primary folder is not a git repo. */
function renderState() {
  if (!project) {
    hintEl.textContent = "Select a project to use git.";
    hintEl.classList.remove("hidden");
    actionsEl.classList.add("hidden");
    return;
  }
  hintEl.classList.add("hidden");
  actionsEl.classList.remove("hidden");

  branchNameEl.textContent = repoReady ? currentBranch || "(detached)" : "(not a git repo)";
  branchNameEl.title = branchNameEl.textContent;

  // View diff spans every repo in the project, so it stays enabled even when the
  // primary folder itself is not a repo. The branch/commit/push actions act on
  // the primary repo, so they need one.
  const noBranches = branchSelect.options.length === 0;
  branchSelect.disabled = !repoReady || noBranches;
  switchBtn.disabled = !repoReady || noBranches;
  branchRefreshBtn.disabled = !repoReady;
  commitMsgEl.disabled = !repoReady;
  commitBtn.disabled = !repoReady;
  pushBtn.disabled = !repoReady;
}

// --- Actions ----------------------------------------------------------------
diffBtn.addEventListener("click", () => {
  if (!project) return;
  window.dispatchEvent(
    new CustomEvent("project-gitdiff", {
      detail: { id: project.id, name: project.name, paths: project.paths || [] },
    }),
  );
});

branchRefreshBtn.addEventListener("click", loadBranches);

switchBtn.addEventListener("click", () => {
  if (!project || !repoReady) return;
  const branch = branchSelect.value;
  if (!branch || branch === currentBranch) return; // already on it
  runManagedCommand({
    id: "git:switch",
    label: `git switch ${branch}`,
    command: `git switch ${shQuote(branch)}`,
  });
  // Reflect the new branch optimistically, then reconcile from git shortly after
  // the switch has had time to run in the terminal.
  currentBranch = branch;
  branchNameEl.textContent = branch;
  branchNameEl.title = branch;
  setTimeout(loadBranches, BRANCH_RECONCILE_MS);
});

commitBtn.addEventListener("click", () => {
  if (!project || !repoReady) return;
  const msg = commitMsgEl.value.trim();
  if (!msg) {
    commitMsgEl.focus();
    return;
  }
  // -am commits tracked-file changes (skips brand-new untracked files), per the
  // chosen commit behaviour.
  runManagedCommand({
    id: "git:commit",
    label: "git commit",
    command: `git commit -am ${shQuote(msg)}`,
  });
  commitMsgEl.value = "";
});

commitMsgEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    commitBtn.click();
  }
});

pushBtn.addEventListener("click", () => {
  if (!project || !repoReady) return;
  runManagedCommand({ id: "git:push", label: "git push", command: "git push" });
});

// Initial paint (no project until workspaces.js emits the first selection).
renderState();
