//! Read-only pull-request data for the dashboard.
//!
//! GitHub owns remote PR state. The local side deliberately models only
//! comparisons between local branch tips and a selected local base branch.
//! Every local detail response pins the two tips and their merge base so a
//! later branch movement cannot change an already-opened diff.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::Path;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
const GH_COMMAND_TIMEOUT: Duration = Duration::from_secs(45);
const COMMAND_OUTPUT_MAX: usize = 32 * 1024 * 1024;
const DIFF_MAX_BYTES: usize = 1_500_000;
const LOCAL_BRANCH_LIMIT: usize = 100;
const DETAIL_FILE_LIMIT: usize = 500;
const DETAIL_COMMIT_LIMIT: usize = 500;
const REMOTE_LIST_LIMIT: usize = 100;
const REMOTE_PAGE_SIZE: usize = 100;
const GH_SUMMARY_FIELDS: &str = "additions,author,baseRefName,baseRefOid,changedFiles,deletions,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,isDraft,mergedAt,number,reviewDecision,reviews,state,title,updatedAt,url";
const GH_DETAIL_FIELDS: &str = "additions,author,baseRefName,baseRefOid,body,changedFiles,commits,deletions,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,isDraft,mergedAt,number,reviewDecision,reviews,state,title,updatedAt,url";
const GH_LIST_JQ: &str = r#"map({
    additions, author, baseRefName, baseRefOid, changedFiles,
    commitCount: ((.commits // []) | length), deletions,
    headRefName, headRefOid, headRepository, headRepositoryOwner,
    isCrossRepository, isDraft, mergedAt, number, reviewDecision,
    reviews: [(.reviews // [])[] | {
        state,
        commit: (if .commit == null then null else {oid: .commit.oid} end)
    }],
    state, title, updatedAt, url
})"#;
const GH_SUMMARY_JQ: &str = r#"{
    additions, author, baseRefName, baseRefOid, changedFiles, deletions,
    headRefName, headRefOid, headRepository, headRepositoryOwner,
    isCrossRepository, isDraft, mergedAt, number, reviewDecision,
    reviews: [(.reviews // [])[] | {
        state,
        commit: (if .commit == null then null else {oid: .commit.oid} end)
    }],
    state, title, updatedAt, url
}"#;
const GH_DETAIL_JQ: &str = r#"{
    additions, author, baseRefName, baseRefOid, body, changedFiles,
    commits: [(.commits // [])[] | {oid, messageHeadline, authors}],
    deletions, headRefName, headRefOid, headRepository, headRepositoryOwner,
    isCrossRepository, isDraft, mergedAt, number, reviewDecision,
    reviews: [(.reviews // [])[] | {
        state,
        commit: (if .commit == null then null else {oid: .commit.oid} end)
    }],
    state, title, updatedAt, url
}"#;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrRepository {
    pub root: String,
    pub name: String,
    pub branches: Vec<String>,
    pub default_base: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub id: String,
    pub source: String,
    pub root: String,
    pub title: String,
    pub number: Option<u64>,
    pub url: Option<String>,
    pub state: String,
    pub branch: String,
    pub base: String,
    pub head_sha: String,
    pub base_sha: String,
    pub author: String,
    pub updated_at: String,
    pub commit_count: u64,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub review_decision: String,
    pub approved: bool,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrList {
    pub items: Vec<PrSummary>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub binary: bool,
    pub patch: Option<String>,
    pub patch_unavailable: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrCommit {
    pub sha: String,
    pub title: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub pr: PrSummary,
    pub body: String,
    pub files: Vec<PrFile>,
    pub commits: Vec<PrCommit>,
    pub merge_base_sha: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrPatch {
    pub text: String,
    pub binary: bool,
    pub too_large: bool,
}

#[derive(Debug, Clone)]
struct Repository {
    primary_root: String,
    branches: Vec<Branch>,
    worktrees: Vec<Worktree>,
}

#[derive(Debug, Clone)]
struct Branch {
    name: String,
    sha: String,
    author: String,
    updated_at: String,
    title: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Worktree {
    path: String,
    head_sha: String,
    branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemoteIdentity {
    host: String,
    owner: String,
    repo: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RemotePrMetadata {
    repository: String,
    number: u64,
    url: String,
    head_sha: String,
    base_sha: String,
    commit_count: u64,
}

impl RemoteIdentity {
    fn name_with_owner(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    fn selector(&self) -> String {
        if self.host.eq_ignore_ascii_case("github.com") {
            self.name_with_owner()
        } else {
            format!("{}/{}", self.host, self.name_with_owner())
        }
    }
}

#[derive(Debug)]
struct Captured {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

#[derive(Debug, Default)]
struct DiffStats {
    additions: u64,
    deletions: u64,
    changed_files: u64,
    binary: HashSet<String>,
    counts: HashMap<String, (u64, u64)>,
}

#[derive(Debug, Clone)]
struct NameStatus {
    path: String,
    old_path: Option<String>,
    status: String,
}

/// Resolve project paths to canonical primary checkouts and de-duplicate linked
/// worktrees that share one common repository.
pub fn pr_repositories(paths: Vec<String>) -> Result<Vec<PrRepository>, String> {
    let mut seen = HashSet::new();
    let mut repositories = Vec::new();
    let mut failures = Vec::new();

    for path in paths {
        match discover_repository(&path) {
            Ok(repo) => {
                if !seen.insert(repo.primary_root.clone()) {
                    continue;
                }
                let default_base = default_base(&repo);
                let name = Path::new(&repo.primary_root)
                    .file_name()
                    .and_then(OsStr::to_str)
                    .filter(|name| !name.is_empty())
                    .unwrap_or(&repo.primary_root)
                    .to_string();
                repositories.push(PrRepository {
                    root: repo.primary_root,
                    name,
                    branches: repo
                        .branches
                        .into_iter()
                        .map(|branch| branch.name)
                        .collect(),
                    default_base,
                });
            }
            Err(error) => failures.push(format!("{path}: {error}")),
        }
    }

    if repositories.is_empty() && !failures.is_empty() {
        return Err(format!(
            "No Git repositories could be discovered: {}",
            failures.join("; ")
        ));
    }
    Ok(repositories)
}

/// List branch comparisons that contain commits not reachable from `base`.
pub fn pr_local_list(root: String, base: String) -> Result<PrList, String> {
    let repo = discover_repository(&root)?;
    let base_sha = resolve_local_branch(&repo, &base)?;
    let mut warnings = Vec::new();
    let mut items = Vec::new();
    let candidates: Vec<Branch> = repo
        .branches
        .iter()
        .filter(|branch| branch.name != base)
        .cloned()
        .collect();

    if candidates.len() > LOCAL_BRANCH_LIMIT {
        warnings.push(format!(
            "Showing the first {LOCAL_BRANCH_LIMIT} of {} local branches.",
            candidates.len()
        ));
    }

    for branch in candidates.into_iter().take(LOCAL_BRANCH_LIMIT) {
        let count = match rev_count(&repo.primary_root, &base_sha, &branch.sha) {
            Ok(count) => count,
            Err(error) => {
                warnings.push(format!("Could not compare {}: {error}", branch.name));
                continue;
            }
        };
        if count == 0 {
            continue;
        }
        match local_summary(&repo, &base, &base_sha, &branch, count) {
            Ok(summary) => items.push(summary),
            Err(error) => warnings.push(format!("Could not summarize {}: {error}", branch.name)),
        }
    }

    Ok(PrList { items, warnings })
}

/// List GitHub pull requests using `gh`. A remote failure is returned honestly;
/// it never mutates or replaces the independent local branch list.
pub fn pr_remote_list(root: String, state: String) -> Result<PrList, String> {
    if !matches!(state.as_str(), "open" | "closed" | "merged" | "all") {
        return Err(format!("Unsupported pull-request state: {state}"));
    }
    let repo = discover_repository(&root)?;
    let remote = github_remote(&repo.primary_root)?;
    let fields = "additions,author,baseRefName,baseRefOid,changedFiles,commits,deletions,headRefName,headRefOid,headRepository,headRepositoryOwner,isCrossRepository,isDraft,mergedAt,number,reviewDecision,reviews,state,title,updatedAt,url";
    let raw = run_gh_text(
        &repo.primary_root,
        &[
            "pr".into(),
            "list".into(),
            "--repo".into(),
            remote.selector(),
            "--state".into(),
            state,
            "--limit".into(),
            (REMOTE_LIST_LIMIT + 1).to_string(),
            "--json".into(),
            fields.into(),
            "--jq".into(),
            GH_LIST_JQ.into(),
        ],
    )?;
    let values: Vec<Value> = serde_json::from_str(&raw)
        .map_err(|error| format!("gh returned invalid pull-request JSON: {error}"))?;
    let mut warnings = Vec::new();
    if values.len() > REMOTE_LIST_LIMIT {
        warnings.push(format!(
            "Showing the first {REMOTE_LIST_LIMIT} GitHub pull requests; refine the state filter to see more."
        ));
    }
    if !values.is_empty() {
        warnings.push(
            "Commit counts in the GitHub list reflect the bounded commit arrays returned by gh and may be lower than the PR total; open a pull request for its authoritative count."
                .to_string(),
        );
    }
    let mut items = Vec::new();
    for value in values.into_iter().take(REMOTE_LIST_LIMIT) {
        match parse_remote_summary(&value, &repo, &remote) {
            Ok((summary, approval_without_head)) => {
                if approval_without_head {
                    warnings.push(format!(
                        "PR #{} is reported approved by GitHub, but no approval for its current head SHA was returned; it is not marked approved here.",
                        summary.number.unwrap_or_default()
                    ));
                }
                items.push(summary);
            }
            Err(error) => {
                let number = value
                    .get("number")
                    .and_then(Value::as_u64)
                    .map(|number| format!(" #{number}"))
                    .unwrap_or_default();
                warnings.push(format!("Skipped malformed GitHub PR{number}: {error}"));
            }
        }
    }
    Ok(PrList { items, warnings })
}

/// Load the current verified metadata needed by trusted completion workflows.
/// This intentionally avoids changed-file patches and the full commit list.
pub fn pr_remote_get(root: String, number: u64) -> Result<PrSummary, String> {
    if number == 0 {
        return Err("Pull-request number must be greater than zero".into());
    }
    let repo = discover_repository(&root)?;
    let remote = github_remote(&repo.primary_root)?;
    let mut run_gh = |cwd: &str, args: &[String]| run_gh_text(cwd, args);
    github_remote_get_with(&repo, &remote, number, &mut run_gh)
}

/// Load one commit-pinned local comparison or one current GitHub PR.
pub fn pr_detail(
    root: String,
    source: String,
    branch: Option<String>,
    base: Option<String>,
    number: Option<u64>,
) -> Result<PrDetail, String> {
    match source.as_str() {
        "local" => local_detail(
            &root,
            branch.ok_or_else(|| "branch is required for a local comparison".to_string())?,
            base.ok_or_else(|| "base is required for a local comparison".to_string())?,
        ),
        "github" => github_detail(
            &root,
            number.ok_or_else(|| "number is required for a GitHub pull request".to_string())?,
        ),
        _ => Err(format!("Unsupported pull-request source: {source}")),
    }
}

/// Diff one literal repository-relative path between two exact commit IDs.
pub fn pr_file_diff(
    root: String,
    base_sha: String,
    head_sha: String,
    file: String,
    old_path: Option<String>,
) -> Result<PrPatch, String> {
    let repo = discover_repository(&root)?;
    validate_relative_git_path(&file)?;
    if let Some(old_path) = old_path.as_deref() {
        validate_relative_git_path(old_path)?;
    }
    let base_sha = resolve_snapshot(&repo.primary_root, &base_sha, "baseSha")?;
    let head_sha = resolve_snapshot(&repo.primary_root, &head_sha, "headSha")?;
    let mut args = vec![
        "--literal-pathspecs".into(),
        "-c".into(),
        "diff.external=".into(),
        "diff".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--find-renames".into(),
        format!("{base_sha}..{head_sha}"),
        "--".into(),
    ];
    if let Some(old_path) = old_path {
        args.push(old_path);
    }
    args.push(file);
    let captured = run_git_capture(&repo.primary_root, &args, DIFF_MAX_BYTES + 1)?;
    if captured.stdout_truncated || captured.stdout.len() > DIFF_MAX_BYTES {
        return Ok(PrPatch {
            text: String::new(),
            binary: false,
            too_large: true,
        });
    }
    let text = decode_stdout(captured.stdout, "git diff")?;
    let binary = text
        .lines()
        .any(|line| line.starts_with("Binary files ") || line.starts_with("GIT binary patch"));
    Ok(PrPatch {
        text: if binary { String::new() } else { text },
        binary,
        too_large: false,
    })
}

fn local_detail(root: &str, branch_name: String, base: String) -> Result<PrDetail, String> {
    let repo = discover_repository(root)?;
    let base_sha = resolve_local_branch(&repo, &base)?;
    let branch = repo
        .branches
        .iter()
        .find(|candidate| candidate.name == branch_name)
        .cloned()
        .ok_or_else(|| format!("Local branch does not exist: {branch_name}"))?;
    let merge_base = merge_base(&repo.primary_root, &base_sha, &branch.sha)?;
    let commit_count = rev_count(&repo.primary_root, &base_sha, &branch.sha)?;
    let pr = local_summary(&repo, &base, &base_sha, &branch, commit_count)?;
    let mut warnings = Vec::new();
    let statuses = diff_name_status(&repo.primary_root, &merge_base, &branch.sha)?;
    let stats = diff_stats(&repo.primary_root, &merge_base, &branch.sha)?;
    if statuses.len() > DETAIL_FILE_LIMIT {
        warnings.push(format!(
            "Showing the first {DETAIL_FILE_LIMIT} of {} changed files.",
            statuses.len()
        ));
    }
    let files = statuses
        .into_iter()
        .take(DETAIL_FILE_LIMIT)
        .map(|status| {
            let binary = stats.binary.contains(&status.path);
            let (additions, deletions) =
                stats.counts.get(&status.path).copied().unwrap_or_default();
            PrFile {
                path: status.path,
                old_path: status.old_path,
                status: status.status,
                additions,
                deletions,
                binary,
                patch: None,
                patch_unavailable: binary
                    .then(|| "Binary file; no text patch is available.".to_string()),
            }
        })
        .collect();
    let (commits, commits_truncated) = local_commits(
        &repo.primary_root,
        &base_sha,
        &branch.sha,
        DETAIL_COMMIT_LIMIT,
    )?;
    if commits_truncated {
        warnings.push(format!(
            "Showing the first {DETAIL_COMMIT_LIMIT} commits in this comparison."
        ));
    }
    let body = git_text(
        &repo.primary_root,
        &[
            "log".into(),
            "-1".into(),
            "--format=%B".into(),
            branch.sha.clone(),
        ],
    )?
    .trim_end()
    .to_string();

    Ok(PrDetail {
        pr,
        body,
        files,
        commits,
        merge_base_sha: Some(merge_base),
        warnings,
    })
}

fn github_detail(root: &str, number: u64) -> Result<PrDetail, String> {
    if number == 0 {
        return Err("Pull-request number must be greater than zero".into());
    }
    let repo = discover_repository(root)?;
    let remote = github_remote(&repo.primary_root)?;
    let mut run_gh = |cwd: &str, args: &[String]| run_gh_text(cwd, args);
    github_detail_with(&repo, &remote, number, &mut run_gh)
}

fn github_detail_with<F>(
    repo: &Repository,
    remote: &RemoteIdentity,
    number: u64,
    run_gh: &mut F,
) -> Result<PrDetail, String>
where
    F: FnMut(&str, &[String]) -> Result<String, String>,
{
    let value =
        github_view_json_with(repo, remote, number, GH_DETAIL_FIELDS, GH_DETAIL_JQ, run_gh)?;
    let (mut pr, approval_without_head) = parse_remote_summary(&value, repo, remote)?;
    let mut warnings = Vec::new();
    if approval_without_head {
        warnings.push(
            "GitHub reports this PR approved, but returned no approval for its current head SHA; it is not marked approved here."
                .to_string(),
        );
    }
    let (files, file_warnings) = github_files_with(repo, remote, number, pr.changed_files, run_gh)?;
    warnings.extend(file_warnings);

    // File pages are mutable REST reads. Re-read fixed PR metadata afterwards
    // so patches can never be paired with stale head/base SHAs.
    let metadata = github_metadata_with(repo, remote, number, run_gh)?;
    verify_remote_snapshot(&pr, remote, &metadata)?;
    pr.commit_count = metadata.commit_count;

    let mut commits = parse_remote_commits(value.get("commits"));
    if commits.len() > DETAIL_COMMIT_LIMIT {
        commits.truncate(DETAIL_COMMIT_LIMIT);
        warnings.push(format!(
            "Showing the first {DETAIL_COMMIT_LIMIT} commits returned by GitHub."
        ));
    }
    if (commits.len() as u64) < pr.commit_count {
        warnings.push(format!(
            "GitHub returned {} of {} commits for this PR.",
            commits.len(),
            pr.commit_count
        ));
    }

    Ok(PrDetail {
        pr,
        body: json_string(&value, "body"),
        files,
        commits,
        merge_base_sha: None,
        warnings,
    })
}

fn github_remote_get_with<F>(
    repo: &Repository,
    remote: &RemoteIdentity,
    number: u64,
    run_gh: &mut F,
) -> Result<PrSummary, String>
where
    F: FnMut(&str, &[String]) -> Result<String, String>,
{
    let value = github_view_json_with(
        repo,
        remote,
        number,
        GH_SUMMARY_FIELDS,
        GH_SUMMARY_JQ,
        run_gh,
    )?;
    let (mut pr, _) = parse_remote_summary(&value, repo, remote)?;
    let metadata = github_metadata_with(repo, remote, number, run_gh)?;
    verify_remote_snapshot(&pr, remote, &metadata)?;
    pr.commit_count = metadata.commit_count;
    Ok(pr)
}

fn github_view_json_with<F>(
    repo: &Repository,
    remote: &RemoteIdentity,
    number: u64,
    fields: &str,
    jq: &str,
    run_gh: &mut F,
) -> Result<Value, String>
where
    F: FnMut(&str, &[String]) -> Result<String, String>,
{
    let raw = run_gh(
        &repo.primary_root,
        &[
            "pr".into(),
            "view".into(),
            number.to_string(),
            "--repo".into(),
            remote.selector(),
            "--json".into(),
            fields.into(),
            "--jq".into(),
            jq.into(),
        ],
    )?;
    serde_json::from_str(&raw)
        .map_err(|error| format!("gh returned invalid pull-request JSON: {error}"))
}

fn github_files_with<F>(
    repo: &Repository,
    remote: &RemoteIdentity,
    number: u64,
    expected_files: u64,
    run_gh: &mut F,
) -> Result<(Vec<PrFile>, Vec<String>), String>
where
    F: FnMut(&str, &[String]) -> Result<String, String>,
{
    let mut files = Vec::new();
    let mut warnings = Vec::new();
    let max_pages = DETAIL_FILE_LIMIT.div_ceil(REMOTE_PAGE_SIZE);

    for page in 1..=max_pages {
        let endpoint = format!(
            "repos/{}/{}/pulls/{number}/files?per_page={REMOTE_PAGE_SIZE}&page={page}",
            remote.owner, remote.repo
        );
        let raw = run_gh(
            &repo.primary_root,
            &[
                "api".into(),
                "--hostname".into(),
                remote.host.clone(),
                "--method".into(),
                "GET".into(),
                endpoint,
            ],
        )?;
        let page_values: Vec<Value> = serde_json::from_str(&raw)
            .map_err(|error| format!("gh returned invalid changed-file JSON: {error}"))?;
        let page_len = page_values.len();
        for value in page_values {
            match parse_remote_file(&value) {
                Ok(file) => files.push(file),
                Err(error) => warnings.push(format!("Skipped a malformed GitHub file: {error}")),
            }
        }
        if page_len < REMOTE_PAGE_SIZE {
            break;
        }
    }

    if files.len() > DETAIL_FILE_LIMIT {
        files.truncate(DETAIL_FILE_LIMIT);
    }
    if expected_files > files.len() as u64 {
        warnings.push(format!(
            "Showing {} of {expected_files} files returned for this PR.",
            files.len()
        ));
    }
    let unavailable = files.iter().filter(|file| file.patch.is_none()).count();
    if unavailable > 0 {
        warnings.push(format!(
            "GitHub did not provide {unavailable} file patch(es); they may be binary or truncated by GitHub."
        ));
    }
    Ok((files, warnings))
}

fn github_metadata_with<F>(
    repo: &Repository,
    remote: &RemoteIdentity,
    number: u64,
    run_gh: &mut F,
) -> Result<RemotePrMetadata, String>
where
    F: FnMut(&str, &[String]) -> Result<String, String>,
{
    let endpoint = format!("repos/{}/{}/pulls/{number}", remote.owner, remote.repo);
    let raw = run_gh(
        &repo.primary_root,
        &[
            "api".into(),
            "--hostname".into(),
            remote.host.clone(),
            "--method".into(),
            "GET".into(),
            endpoint,
        ],
    )?;
    let value: Value = serde_json::from_str(&raw)
        .map_err(|error| format!("gh returned invalid pull-request metadata JSON: {error}"))?;
    parse_remote_metadata(&value)
}

fn parse_remote_metadata(value: &Value) -> Result<RemotePrMetadata, String> {
    let nested_string = |parent: &str, child: &str| {
        value
            .get(parent)
            .and_then(|value| value.get(child))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("GitHub PR metadata is missing {parent}.{child}"))
    };
    let repository = value
        .get("base")
        .and_then(|base| base.get("repo"))
        .and_then(|repo| repo.get("full_name"))
        .and_then(Value::as_str)
        .filter(|repository| !repository.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "GitHub PR metadata is missing base.repo.full_name".to_string())?;
    Ok(RemotePrMetadata {
        repository,
        number: value
            .get("number")
            .and_then(Value::as_u64)
            .ok_or_else(|| "GitHub PR metadata is missing number".to_string())?,
        url: required_json_string(value, "html_url")?,
        head_sha: nested_string("head", "sha")?,
        base_sha: nested_string("base", "sha")?,
        commit_count: value
            .get("commits")
            .and_then(Value::as_u64)
            .ok_or_else(|| "GitHub PR metadata is missing commits".to_string())?,
    })
}

fn verify_remote_snapshot(
    initial: &PrSummary,
    remote: &RemoteIdentity,
    current: &RemotePrMetadata,
) -> Result<(), String> {
    let mut changes = Vec::new();
    let expected_number = initial.number.unwrap_or_default();
    let expected_url = initial.url.as_deref().unwrap_or_default();
    if !current
        .repository
        .eq_ignore_ascii_case(&remote.name_with_owner())
        || current.number != expected_number
        || current.url != expected_url
    {
        changes.push("pull-request identity");
    }
    if !current.head_sha.eq_ignore_ascii_case(&initial.head_sha) {
        changes.push("head SHA");
    }
    if !current.base_sha.eq_ignore_ascii_case(&initial.base_sha) {
        changes.push("base SHA");
    }
    if changes.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Pull request #{expected_number} changed while GitHub data was loading ({} changed). Refresh the pull request and try again.",
        changes.join(", ")
    ))
}

fn parse_remote_file(value: &Value) -> Result<PrFile, String> {
    let raw_patch = value.get("patch").and_then(Value::as_str);
    let patch_too_large = raw_patch
        .map(|patch| patch.len() > DIFF_MAX_BYTES)
        .unwrap_or(false);
    let binary = raw_patch
        .map(|patch| {
            patch.lines().any(|line| {
                line.starts_with("Binary files ") || line.starts_with("GIT binary patch")
            })
        })
        .unwrap_or(false);
    let patch = if binary || patch_too_large {
        None
    } else {
        raw_patch.map(str::to_string)
    };
    let patch_unavailable = if binary {
        Some("Binary file; no text patch is available.".to_string())
    } else if patch_too_large {
        Some(format!(
            "Patch exceeds the {} byte display limit.",
            DIFF_MAX_BYTES
        ))
    } else if patch.is_none() {
        Some(
            "GitHub did not provide a patch; the file may be binary or the patch may be truncated."
                .to_string(),
        )
    } else {
        None
    };
    Ok(PrFile {
        path: required_json_string(value, "filename")?,
        old_path: value
            .get("previous_filename")
            .and_then(Value::as_str)
            .map(str::to_string),
        status: required_json_string(value, "status")?,
        additions: json_u64(value, "additions"),
        deletions: json_u64(value, "deletions"),
        binary,
        patch,
        patch_unavailable,
    })
}

fn parse_remote_summary(
    value: &Value,
    repo: &Repository,
    remote: &RemoteIdentity,
) -> Result<(PrSummary, bool), String> {
    let number = value
        .get("number")
        .and_then(Value::as_u64)
        .ok_or_else(|| "GitHub PR JSON is missing number".to_string())?;
    let head_sha = required_json_string(value, "headRefOid")?;
    let base_sha = required_json_string(value, "baseRefOid")?;
    let head_ref = required_json_string(value, "headRefName")?;
    let base_ref = required_json_string(value, "baseRefName")?;
    let head_identity = remote_head_identity(value);
    let cross_repository = value
        .get("isCrossRepository")
        .and_then(Value::as_bool)
        .unwrap_or_else(|| {
            head_identity
                .as_deref()
                .map(|identity| !identity.eq_ignore_ascii_case(&remote.name_with_owner()))
                .unwrap_or(true)
        });
    let same_repository = !cross_repository
        && head_identity
            .as_deref()
            .map(|identity| identity.eq_ignore_ascii_case(&remote.name_with_owner()))
            .unwrap_or(true);
    let branch = if same_repository {
        head_ref.clone()
    } else {
        let owner = value
            .get("headRepositoryOwner")
            .and_then(|owner| owner.get("login"))
            .and_then(Value::as_str)
            .or_else(|| {
                head_identity
                    .as_deref()
                    .and_then(|name| name.split('/').next())
            })
            .unwrap_or("fork");
        format!("{owner}:{head_ref}")
    };
    let worktree_path = if same_repository {
        repo.worktrees
            .iter()
            .find(|worktree| {
                worktree.branch.as_deref() == Some(head_ref.as_str())
                    && worktree.head_sha.eq_ignore_ascii_case(&head_sha)
            })
            .map(|worktree| worktree.path.clone())
    } else {
        None
    };
    let review_decision = json_string(value, "reviewDecision");
    let current_head_approval = has_current_head_approval(value, &head_sha);
    let github_approved = review_decision.eq_ignore_ascii_case("APPROVED");
    let approved = github_approved && current_head_approval;
    let remote_state = json_string(value, "state");
    let state = if value
        .get("mergedAt")
        .is_some_and(|merged| !merged.is_null())
        || remote_state.eq_ignore_ascii_case("MERGED")
    {
        "merged"
    } else if remote_state.eq_ignore_ascii_case("CLOSED") {
        "closed"
    } else if value
        .get("isDraft")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        "draft"
    } else {
        "open"
    }
    .to_string();
    let commits = value
        .get("commitCount")
        .and_then(Value::as_u64)
        .or_else(|| {
            value
                .get("commits")
                .and_then(Value::as_array)
                .map(|commits| commits.len() as u64)
        })
        .unwrap_or(0);
    let author = value
        .get("author")
        .and_then(|author| {
            author
                .get("login")
                .or_else(|| author.get("name"))
                .and_then(Value::as_str)
        })
        .unwrap_or("")
        .to_string();

    Ok((
        PrSummary {
            id: format!("github:{}#{number}", remote.name_with_owner()),
            source: "github".into(),
            root: repo.primary_root.clone(),
            title: required_json_string(value, "title")?,
            number: Some(number),
            url: Some(required_json_string(value, "url")?),
            state,
            branch,
            base: base_ref,
            head_sha,
            base_sha,
            author,
            updated_at: json_string(value, "updatedAt"),
            commit_count: commits,
            additions: json_u64(value, "additions"),
            deletions: json_u64(value, "deletions"),
            changed_files: json_u64(value, "changedFiles"),
            review_decision,
            approved,
            worktree_path,
        },
        github_approved && !current_head_approval,
    ))
}

fn has_current_head_approval(value: &Value, head_sha: &str) -> bool {
    ["reviews", "latestReviews"]
        .iter()
        .filter_map(|field| value.get(*field).and_then(Value::as_array))
        .flatten()
        .any(|review| {
            json_string(review, "state").eq_ignore_ascii_case("APPROVED")
                && review_commit_sha(review).is_some_and(|sha| sha.eq_ignore_ascii_case(head_sha))
        })
}

fn review_commit_sha(review: &Value) -> Option<&str> {
    review
        .get("commit")
        .and_then(|commit| {
            commit
                .as_str()
                .or_else(|| commit.get("oid").and_then(Value::as_str))
                .or_else(|| commit.get("sha").and_then(Value::as_str))
        })
        .or_else(|| review.get("commitOid").and_then(Value::as_str))
        .or_else(|| review.get("commit_id").and_then(Value::as_str))
}

fn remote_head_identity(value: &Value) -> Option<String> {
    let repository = value.get("headRepository")?;
    if let Some(name) = repository.get("nameWithOwner").and_then(Value::as_str) {
        return Some(name.to_string());
    }
    let name = repository.get("name").and_then(Value::as_str)?;
    let owner = value
        .get("headRepositoryOwner")
        .and_then(|owner| owner.get("login"))
        .and_then(Value::as_str)?;
    Some(format!("{owner}/{name}"))
}

fn parse_remote_commits(value: Option<&Value>) -> Vec<PrCommit> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|commit| {
            let sha = commit
                .get("oid")
                .or_else(|| commit.get("sha"))
                .and_then(Value::as_str)
                .filter(|sha| !sha.is_empty())?;
            let author = commit
                .get("authors")
                .and_then(Value::as_array)
                .and_then(|authors| authors.first())
                .and_then(|author| {
                    author
                        .get("login")
                        .or_else(|| author.get("name"))
                        .and_then(Value::as_str)
                })
                .or_else(|| commit.get("authorName").and_then(Value::as_str))
                .unwrap_or("")
                .to_string();
            Some(PrCommit {
                sha: sha.to_string(),
                title: commit
                    .get("messageHeadline")
                    .or_else(|| commit.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                author,
            })
        })
        .collect()
}

fn local_summary(
    repo: &Repository,
    base: &str,
    base_sha: &str,
    branch: &Branch,
    commit_count: u64,
) -> Result<PrSummary, String> {
    let merge_base = merge_base(&repo.primary_root, base_sha, &branch.sha)?;
    let stats = diff_stats(&repo.primary_root, &merge_base, &branch.sha)?;
    let worktree_path = repo
        .worktrees
        .iter()
        .find(|worktree| {
            worktree.branch.as_deref() == Some(branch.name.as_str())
                && worktree.head_sha.eq_ignore_ascii_case(&branch.sha)
        })
        .map(|worktree| worktree.path.clone());
    Ok(PrSummary {
        id: format!("local:{base}...{}", branch.name),
        source: "local".into(),
        root: repo.primary_root.clone(),
        title: branch.title.clone(),
        number: None,
        url: None,
        state: "local".into(),
        branch: branch.name.clone(),
        base: base.to_string(),
        head_sha: branch.sha.clone(),
        base_sha: base_sha.to_string(),
        author: branch.author.clone(),
        updated_at: branch.updated_at.clone(),
        commit_count,
        additions: stats.additions,
        deletions: stats.deletions,
        changed_files: stats.changed_files,
        review_decision: String::new(),
        approved: false,
        worktree_path,
    })
}

fn discover_repository(path: &str) -> Result<Repository, String> {
    if path.trim().is_empty() {
        return Err("Repository path is empty".into());
    }
    let requested = Path::new(path);
    if !requested.exists() {
        return Err("Path does not exist".into());
    }
    let current_root = git_text(path, &["rev-parse".into(), "--show-toplevel".into()])?;
    let current_root = current_root.trim();
    if current_root.is_empty() {
        return Err("Not a Git repository".into());
    }
    let worktree_raw = run_git(
        current_root,
        &[
            "worktree".into(),
            "list".into(),
            "--porcelain".into(),
            "-z".into(),
        ],
        COMMAND_OUTPUT_MAX,
    )?;
    let mut worktrees = parse_worktrees(&worktree_raw.stdout)?;
    let primary = worktrees
        .first()
        .map(|worktree| worktree.path.as_str())
        .unwrap_or(current_root);
    let primary_root = canonical_path(primary)?;
    for worktree in &mut worktrees {
        if let Ok(path) = canonical_path(&worktree.path) {
            worktree.path = path;
        }
    }
    let branch_raw = git_text(
        &primary_root,
        &[
            "for-each-ref".into(),
            "--sort=-committerdate".into(),
            "--format=%(refname:short)%00%(objectname)%00%(authorname)%00%(authordate:iso-strict)%00%(subject)%00".into(),
            "refs/heads/".into(),
        ],
    )?;
    Ok(Repository {
        primary_root,
        branches: parse_branches(branch_raw.as_bytes())?,
        worktrees,
    })
}

fn parse_worktrees(bytes: &[u8]) -> Result<Vec<Worktree>, String> {
    let mut result = Vec::new();
    let mut path: Option<String> = None;
    let mut head_sha = String::new();
    let mut branch = None;

    for raw_field in bytes
        .split(|byte| *byte == 0)
        .chain(std::iter::once(&[][..]))
    {
        if raw_field.is_empty() {
            if let Some(path) = path.take() {
                result.push(Worktree {
                    path,
                    head_sha: std::mem::take(&mut head_sha),
                    branch: branch.take(),
                });
            }
            continue;
        }
        let field = std::str::from_utf8(raw_field)
            .map_err(|_| "git returned a non-UTF-8 worktree path".to_string())?;
        if let Some(value) = field.strip_prefix("worktree ") {
            path = Some(value.to_string());
        } else if let Some(value) = field.strip_prefix("HEAD ") {
            head_sha = value.to_string();
        } else if let Some(value) = field.strip_prefix("branch refs/heads/") {
            branch = Some(value.to_string());
        }
    }
    Ok(result)
}

fn parse_branches(bytes: &[u8]) -> Result<Vec<Branch>, String> {
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    let mut branches = Vec::new();
    for chunk in fields.chunks(5) {
        if chunk.len() < 5 {
            break;
        }
        let name = clean_field(chunk[0])?;
        if name.is_empty() {
            continue;
        }
        branches.push(Branch {
            name,
            sha: clean_field(chunk[1])?,
            author: clean_field(chunk[2])?,
            updated_at: clean_field(chunk[3])?,
            title: clean_field(chunk[4])?,
        });
    }
    Ok(branches)
}

fn clean_field(bytes: &[u8]) -> Result<String, String> {
    std::str::from_utf8(bytes)
        .map(|field| field.trim_matches(['\n', '\r']).to_string())
        .map_err(|_| "git returned non-UTF-8 metadata".to_string())
}

fn default_base(repo: &Repository) -> String {
    // OctiqFlow development work targets develop even when the repository's
    // remote HEAD or primary checkout still points at main.
    if repo
        .branches
        .iter()
        .any(|candidate| candidate.name == "develop")
    {
        return "develop".to_string();
    }
    if let Ok(value) = git_text(
        &repo.primary_root,
        &[
            "symbolic-ref".into(),
            "--quiet".into(),
            "--short".into(),
            "refs/remotes/origin/HEAD".into(),
        ],
    ) {
        if let Some(branch) = value.trim().strip_prefix("origin/") {
            if repo
                .branches
                .iter()
                .any(|candidate| candidate.name == branch)
            {
                return branch.to_string();
            }
        }
    }
    let primary_branch = repo
        .worktrees
        .first()
        .and_then(|worktree| worktree.branch.as_deref());
    if let Some(primary_branch) = primary_branch {
        if repo
            .branches
            .iter()
            .any(|candidate| candidate.name == primary_branch)
        {
            return primary_branch.to_string();
        }
    }
    for conventional in ["main", "master"] {
        if repo
            .branches
            .iter()
            .any(|candidate| candidate.name == conventional)
        {
            return conventional.to_string();
        }
    }
    repo.branches
        .first()
        .map(|branch| branch.name.clone())
        .unwrap_or_default()
}

fn resolve_local_branch(repo: &Repository, branch: &str) -> Result<String, String> {
    repo.branches
        .iter()
        .find(|candidate| candidate.name == branch)
        .map(|candidate| candidate.sha.clone())
        .ok_or_else(|| format!("Local branch does not exist: {branch}"))
}

fn resolve_snapshot(root: &str, sha: &str, label: &str) -> Result<String, String> {
    if !(40..=64).contains(&sha.len()) || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{label} must be a full hexadecimal commit ID"));
    }
    let resolved = git_text(
        root,
        &[
            "rev-parse".into(),
            "--verify".into(),
            format!("{sha}^{{commit}}"),
        ],
    )?
    .trim()
    .to_string();
    if !resolved.eq_ignore_ascii_case(sha) {
        return Err(format!("{label} did not resolve to the requested commit"));
    }
    Ok(resolved)
}

fn merge_base(root: &str, base_sha: &str, head_sha: &str) -> Result<String, String> {
    let output = git_text(
        root,
        &["merge-base".into(), base_sha.into(), head_sha.into()],
    )?;
    let sha = output.trim();
    if sha.is_empty() {
        Err("The branches have no merge base".into())
    } else {
        Ok(sha.to_string())
    }
}

fn rev_count(root: &str, base_sha: &str, head_sha: &str) -> Result<u64, String> {
    let output = git_text(
        root,
        &[
            "rev-list".into(),
            "--count".into(),
            format!("{base_sha}..{head_sha}"),
        ],
    )?;
    output
        .trim()
        .parse()
        .map_err(|_| format!("git returned an invalid commit count: {}", output.trim()))
}

fn diff_stats(root: &str, base_sha: &str, head_sha: &str) -> Result<DiffStats, String> {
    let args = vec![
        "--literal-pathspecs".into(),
        "-c".into(),
        "diff.external=".into(),
        "diff".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--find-renames".into(),
        "--numstat".into(),
        "-z".into(),
        format!("{base_sha}..{head_sha}"),
    ];
    let output = run_git(root, &args, COMMAND_OUTPUT_MAX)?;
    parse_numstat_z(&output.stdout)
}

fn parse_numstat_z(bytes: &[u8]) -> Result<DiffStats, String> {
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    let mut stats = DiffStats::default();
    let mut index = 0;
    while index < fields.len() {
        let record = fields[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let mut columns = record.splitn(3, |byte| *byte == b'\t');
        let additions = columns.next().unwrap_or_default();
        let deletions = columns.next().unwrap_or_default();
        let inline_path = columns.next().unwrap_or_default();
        let path = if inline_path.is_empty() {
            // With -z a rename/copy stores an empty inline path followed by the
            // old and new path as separate NUL fields.
            if index + 1 >= fields.len() {
                return Err("git returned a truncated rename numstat".into());
            }
            index += 1; // old path
            let new_path = fields[index];
            index += 1;
            new_path
        } else {
            inline_path
        };
        let path = std::str::from_utf8(path)
            .map_err(|_| "git returned a non-UTF-8 changed-file path".to_string())?
            .to_string();
        stats.changed_files += 1;
        if additions == b"-" || deletions == b"-" {
            stats.binary.insert(path);
        } else {
            let additions = parse_ascii_u64(additions);
            let deletions = parse_ascii_u64(deletions);
            stats.additions += additions;
            stats.deletions += deletions;
            stats.counts.insert(path, (additions, deletions));
        }
    }
    Ok(stats)
}

fn diff_name_status(root: &str, base_sha: &str, head_sha: &str) -> Result<Vec<NameStatus>, String> {
    let args = vec![
        "--literal-pathspecs".into(),
        "-c".into(),
        "diff.external=".into(),
        "diff".into(),
        "--no-ext-diff".into(),
        "--no-textconv".into(),
        "--find-renames".into(),
        "--name-status".into(),
        "-z".into(),
        format!("{base_sha}..{head_sha}"),
    ];
    let output = run_git(root, &args, COMMAND_OUTPUT_MAX)?;
    parse_name_status_z(&output.stdout)
}

fn parse_name_status_z(bytes: &[u8]) -> Result<Vec<NameStatus>, String> {
    let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
    let mut result = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let code = fields[index];
        index += 1;
        if code.is_empty() {
            continue;
        }
        let kind = code[0] as char;
        let old_path = if matches!(kind, 'R' | 'C') {
            let old = fields
                .get(index)
                .ok_or_else(|| "git returned a truncated rename status".to_string())?;
            index += 1;
            Some(
                std::str::from_utf8(old)
                    .map_err(|_| "git returned a non-UTF-8 old file path".to_string())?
                    .to_string(),
            )
        } else {
            None
        };
        let path = fields
            .get(index)
            .ok_or_else(|| "git returned a truncated name status".to_string())?;
        index += 1;
        let status = match kind {
            'A' => "added",
            'D' => "deleted",
            'R' => "renamed",
            'C' => "copied",
            'T' => "type_changed",
            _ => "modified",
        };
        result.push(NameStatus {
            path: std::str::from_utf8(path)
                .map_err(|_| "git returned a non-UTF-8 changed-file path".to_string())?
                .to_string(),
            old_path,
            status: status.into(),
        });
    }
    Ok(result)
}

fn local_commits(
    root: &str,
    base_sha: &str,
    head_sha: &str,
    limit: usize,
) -> Result<(Vec<PrCommit>, bool), String> {
    let output = run_git(
        root,
        &[
            "log".into(),
            "--format=%H%x00%s%x00%an%x00".into(),
            "--no-decorate".into(),
            format!("--max-count={}", limit + 1),
            format!("{base_sha}..{head_sha}"),
        ],
        COMMAND_OUTPUT_MAX,
    )?;
    let fields: Vec<&[u8]> = output.stdout.split(|byte| *byte == 0).collect();
    let mut commits = Vec::new();
    for chunk in fields.chunks(3) {
        if chunk.len() < 3 {
            break;
        }
        let sha = clean_field(chunk[0])?;
        if sha.is_empty() {
            continue;
        }
        commits.push(PrCommit {
            sha,
            title: clean_field(chunk[1])?,
            author: clean_field(chunk[2])?,
        });
    }
    let truncated = commits.len() > limit;
    commits.truncate(limit);
    Ok((commits, truncated))
}

fn github_remote(root: &str) -> Result<RemoteIdentity, String> {
    let remotes = git_text(root, &["remote".into()])?;
    let mut names: Vec<&str> = remotes.lines().filter(|line| !line.is_empty()).collect();
    names.sort_by_key(|name| if *name == "origin" { 0 } else { 1 });
    let mut errors = Vec::new();
    for name in names {
        match git_text(root, &["remote".into(), "get-url".into(), name.to_string()]) {
            Ok(url) => match parse_github_remote(url.trim()) {
                Some(identity) => return Ok(identity),
                None => errors.push(format!("{name} is not a GitHub remote ({})", url.trim())),
            },
            Err(error) => errors.push(format!("{name}: {error}")),
        }
    }
    if errors.is_empty() {
        Err("This repository has no Git remote".into())
    } else {
        Err(format!("No GitHub remote was found: {}", errors.join("; ")))
    }
}

fn parse_github_remote(url: &str) -> Option<RemoteIdentity> {
    let url = url.trim().trim_end_matches('/');
    let (host, path) = if let Some(rest) = url.split_once("://") {
        let (_, rest) = rest;
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?.split(':').next()?;
        (host, path)
    } else {
        // SCP-like SSH remote: git@github.com:owner/repository.git
        let (authority, path) = url.split_once(':')?;
        (authority.rsplit('@').next()?, path)
    };
    let mut parts = path.trim_matches('/').split('/');
    let owner = parts.next()?;
    let repo = parts.next()?.trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return None;
    }
    if !host.eq_ignore_ascii_case("github.com") && !host.contains('.') {
        return None;
    }
    Some(RemoteIdentity {
        host: host.to_ascii_lowercase(),
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

fn validate_relative_git_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Err("File path is empty".into());
    }
    if path.as_bytes().contains(&0) {
        return Err("File path contains a NUL byte".into());
    }
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("File path must stay within the repository".into());
    }
    Ok(())
}

fn canonical_path(path: &str) -> Result<String, String> {
    std::fs::canonicalize(path)
        .map_err(|error| format!("Cannot canonicalize repository path: {error}"))?
        .to_str()
        .map(str::to_string)
        .ok_or_else(|| "Repository path is not valid UTF-8".to_string())
}

fn json_string(value: &Value, field: &str) -> String {
    value
        .get(field)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn required_json_string(value: &Value, field: &str) -> Result<String, String> {
    let value = json_string(value, field);
    if value.is_empty() {
        Err(format!("GitHub JSON is missing {field}"))
    } else {
        Ok(value)
    }
}

fn json_u64(value: &Value, field: &str) -> u64 {
    value.get(field).and_then(Value::as_u64).unwrap_or(0)
}

fn parse_ascii_u64(bytes: &[u8]) -> u64 {
    std::str::from_utf8(bytes)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn git_text(root: &str, args: &[String]) -> Result<String, String> {
    let captured = run_git(root, args, COMMAND_OUTPUT_MAX)?;
    decode_stdout(captured.stdout, "git")
}

fn run_git(root: &str, args: &[String], output_cap: usize) -> Result<Captured, String> {
    let captured = run_git_capture(root, args, output_cap)?;
    reject_truncated("git", captured)
}

fn run_git_capture(root: &str, args: &[String], output_cap: usize) -> Result<Captured, String> {
    let mut full_args = vec!["-C".to_string(), root.to_string()];
    full_args.extend_from_slice(args);
    let captured = run_bounded("git", None, &full_args, COMMAND_TIMEOUT, output_cap)?;
    checked_status("git", captured)
}

fn run_gh_text(root: &str, args: &[String]) -> Result<String, String> {
    let captured = run_bounded(
        "gh",
        Some(Path::new(root)),
        args,
        GH_COMMAND_TIMEOUT,
        COMMAND_OUTPUT_MAX,
    )?;
    let captured = checked_status("gh", captured)?;
    let captured = reject_truncated("gh", captured)?;
    decode_stdout(captured.stdout, "gh")
}

fn checked_status(program: &str, captured: Captured) -> Result<Captured, String> {
    if !captured.status.success() {
        let stderr = String::from_utf8_lossy(&captured.stderr);
        let detail = stderr.trim();
        let truncation = if captured.stderr_truncated {
            " (stderr truncated)"
        } else {
            ""
        };
        return Err(if detail.is_empty() {
            format!("{program} exited with {}{truncation}", captured.status)
        } else {
            format!("{program} failed: {detail}{truncation}")
        });
    }
    Ok(captured)
}

fn reject_truncated(program: &str, captured: Captured) -> Result<Captured, String> {
    if captured.stdout_truncated {
        return Err(format!(
            "{program} output exceeded its configured safety limit"
        ));
    }
    Ok(captured)
}

fn decode_stdout(bytes: Vec<u8>, program: &str) -> Result<String, String> {
    String::from_utf8(bytes).map_err(|_| format!("{program} produced non-UTF-8 output"))
}

fn run_bounded(
    program: &str,
    cwd: Option<&Path>,
    args: &[String],
    timeout: Duration,
    output_cap: usize,
) -> Result<Captured, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PAGER", "cat")
        .env("GH_PAGER", "cat")
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    crate::proc::no_console(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start {program}: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("Could not capture {program} stdout"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| format!("Could not capture {program} stderr"))?;
    let stdout_reader = thread::spawn(move || read_capped(stdout, output_cap));
    let stderr_reader = thread::spawn(move || read_capped(stderr, 128 * 1024));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "{program} timed out after {} seconds",
                    timeout.as_secs()
                ));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!("Could not wait for {program}: {error}"));
            }
        }
    };
    let (stdout, stdout_truncated) = stdout_reader
        .join()
        .map_err(|_| format!("{program} stdout reader panicked"))?
        .map_err(|error| format!("Could not read {program} stdout: {error}"))?;
    let (stderr, stderr_truncated) = stderr_reader
        .join()
        .map_err(|_| format!("{program} stderr reader panicked"))?
        .map_err(|error| format!("Could not read {program} stderr: {error}"))?;
    Ok(Captured {
        status,
        stdout,
        stderr,
        stdout_truncated,
        stderr_truncated,
    })
}

fn read_capped<R: Read>(mut reader: R, cap: usize) -> io::Result<(Vec<u8>, bool)> {
    let mut stored = Vec::with_capacity(cap.min(64 * 1024));
    let mut buffer = [0u8; 16 * 1024];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let remaining = cap.saturating_sub(stored.len());
        let keep = remaining.min(read);
        stored.extend_from_slice(&buffer[..keep]);
        if keep < read {
            truncated = true;
        }
    }
    Ok((stored, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_REPO: AtomicU64 = AtomicU64::new(0);

    struct TestRepo {
        root: PathBuf,
        linked: PathBuf,
    }

    impl Drop for TestRepo {
        fn drop(&mut self) {
            let _ = Command::new("git")
                .args([
                    "-C",
                    self.root.to_str().unwrap(),
                    "worktree",
                    "remove",
                    "--force",
                ])
                .arg(&self.linked)
                .status();
            let _ = std::fs::remove_dir_all(&self.linked);
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .expect("git should run in integration tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn commit_all(root: &Path, message: &str) {
        git(root, &["add", "--all"]);
        git(root, &["commit", "-q", "-m", message]);
    }

    fn test_repo(name: &str) -> TestRepo {
        let nonce = NEXT_TEST_REPO.fetch_add(1, Ordering::Relaxed);
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "octiq-pr-{name}-{}-{epoch}-{nonce}",
            std::process::id()
        ));
        let linked = root.with_extension("feature-worktree");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.name", "Octiq Test"]);
        git(&root, &["config", "user.email", "octiq@example.invalid"]);
        std::fs::write(root.join("base.txt"), "base\n").unwrap();
        commit_all(&root, "base commit");
        git(&root, &["branch", "feature/literal"]);
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                linked.to_str().unwrap(),
                "feature/literal",
            ],
        );
        TestRepo { root, linked }
    }

    fn remote_test_repo() -> Repository {
        Repository {
            primary_root: "/repo".into(),
            branches: vec![],
            worktrees: vec![],
        }
    }

    fn remote_test_identity() -> RemoteIdentity {
        RemoteIdentity {
            host: "github.com".into(),
            owner: "base".into(),
            repo: "repo".into(),
        }
    }

    fn remote_view_fixture(head_sha: &str, base_sha: &str) -> Value {
        serde_json::json!({
            "number": 42,
            "title": "Stable snapshot",
            "url": "https://github.com/base/repo/pull/42",
            "state": "OPEN",
            "isDraft": false,
            "headRefName": "feature/stable",
            "headRefOid": head_sha,
            "baseRefName": "develop",
            "baseRefOid": base_sha,
            "headRepository": {"name": "repo", "nameWithOwner": "base/repo"},
            "headRepositoryOwner": {"login": "base"},
            "isCrossRepository": false,
            "author": {"login": "alice"},
            "updatedAt": "2026-09-24T00:00:00Z",
            "body": "Body",
            "commits": [{
                "oid": head_sha,
                "messageHeadline": "Stable change",
                "authors": [{"login": "alice"}]
            }],
            "additions": 3,
            "deletions": 1,
            "changedFiles": 1,
            "reviewDecision": "APPROVED",
            "reviews": [{"state": "APPROVED", "commit": {"oid": head_sha}}]
        })
    }

    fn remote_metadata_fixture(head_sha: &str, base_sha: &str, commits: u64) -> Value {
        serde_json::json!({
            "number": 42,
            "html_url": "https://github.com/base/repo/pull/42",
            "head": {"sha": head_sha},
            "base": {"sha": base_sha, "repo": {"full_name": "base/repo"}},
            "commits": commits
        })
    }

    #[test]
    fn parses_common_github_remote_forms() {
        let expected = RemoteIdentity {
            host: "github.com".into(),
            owner: "Octiq".into(),
            repo: "Flow".into(),
        };
        assert_eq!(
            parse_github_remote("https://github.com/Octiq/Flow.git"),
            Some(expected.clone())
        );
        assert_eq!(
            parse_github_remote("git@github.com:Octiq/Flow.git"),
            Some(expected.clone())
        );
        assert_eq!(
            parse_github_remote("ssh://git@github.com/Octiq/Flow.git"),
            Some(expected)
        );
        assert_eq!(parse_github_remote("/tmp/local"), None);
    }

    #[test]
    fn worktree_parser_preserves_primary_and_branch_identity() {
        let parsed = parse_worktrees(
            b"worktree /repo\0HEAD aaaa\0branch refs/heads/main\0\0worktree /repo-wt\0HEAD bbbb\0branch refs/heads/feature/x\0\0",
        )
        .unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].path, "/repo");
        assert_eq!(parsed[1].branch.as_deref(), Some("feature/x"));
    }

    #[test]
    fn numstat_z_handles_literal_rename_and_binary_rows() {
        let stats =
            parse_numstat_z(b"2\t1\tplain name.txt\0-\t-\tbin.dat\0\x35\t0\t\0old.txt\0new.txt\0")
                .unwrap();
        assert_eq!(stats.changed_files, 3);
        assert_eq!((stats.additions, stats.deletions), (7, 1));
        assert!(stats.binary.contains("bin.dat"));
    }

    #[test]
    fn remote_fixture_requires_approval_on_current_head_and_keeps_fork_identity() {
        let fixture = serde_json::json!({
            "number": 42,
            "title": "Forked change",
            "url": "https://github.com/base/repo/pull/42",
            "state": "OPEN",
            "isDraft": false,
            "headRefName": "same-name",
            "headRefOid": "2222222222222222222222222222222222222222",
            "baseRefName": "main",
            "baseRefOid": "1111111111111111111111111111111111111111",
            "headRepository": {"name": "repo-fork", "nameWithOwner": "alice/repo-fork"},
            "headRepositoryOwner": {"login": "alice"},
            "isCrossRepository": true,
            "author": {"login": "alice"},
            "updatedAt": "2026-09-24T00:00:00Z",
            "commits": [{"oid": "2222222222222222222222222222222222222222"}],
            "additions": 3,
            "deletions": 1,
            "changedFiles": 1,
            "reviewDecision": "APPROVED",
            "reviews": [{"state": "APPROVED", "commit": {"oid": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]
        });
        let repo = Repository {
            primary_root: "/repo".into(),
            branches: vec![],
            worktrees: vec![Worktree {
                path: "/repo-wt".into(),
                head_sha: "2222222222222222222222222222222222222222".into(),
                branch: Some("same-name".into()),
            }],
        };
        let remote = RemoteIdentity {
            host: "github.com".into(),
            owner: "base".into(),
            repo: "repo".into(),
        };
        let (summary, missing_current_approval) =
            parse_remote_summary(&fixture, &repo, &remote).unwrap();
        assert_eq!(summary.branch, "alice:same-name");
        assert_eq!(summary.worktree_path, None);
        assert!(!summary.approved);
        assert!(missing_current_approval);

        let mut current = fixture;
        current["reviews"][0]["commit"]["oid"] =
            Value::String("2222222222222222222222222222222222222222".into());
        let (summary, missing_current_approval) =
            parse_remote_summary(&current, &repo, &remote).unwrap();
        assert!(summary.approved);
        assert!(!missing_current_approval);
    }

    #[test]
    fn remote_file_fixture_explains_missing_and_binary_patches() {
        let missing = parse_remote_file(&serde_json::json!({
            "filename": "assets/large.dat",
            "status": "modified",
            "additions": 0,
            "deletions": 0
        }))
        .unwrap();
        assert!(!missing.binary);
        assert!(missing.patch.is_none());
        assert!(missing
            .patch_unavailable
            .as_deref()
            .unwrap()
            .contains("binary or the patch may be truncated"));

        let binary = parse_remote_file(&serde_json::json!({
            "filename": "assets/image.bin",
            "status": "modified",
            "additions": 0,
            "deletions": 0,
            "patch": "Binary files a/assets/image.bin and b/assets/image.bin differ"
        }))
        .unwrap();
        assert!(binary.binary);
        assert!(binary.patch.is_none());
        assert_eq!(
            binary.patch_unavailable.as_deref(),
            Some("Binary file; no text patch is available.")
        );
    }

    #[test]
    fn github_detail_rejects_head_movement_during_file_paging() {
        let original_head = "2222222222222222222222222222222222222222";
        let moved_head = "3333333333333333333333333333333333333333";
        let base_sha = "1111111111111111111111111111111111111111";
        let mut responses = VecDeque::from([
            remote_view_fixture(original_head, base_sha).to_string(),
            serde_json::json!([{
                "filename": "src/lib.rs",
                "status": "modified",
                "additions": 3,
                "deletions": 1,
                "patch": "@@ -1 +1 @@\n-old\n+new"
            }])
            .to_string(),
            remote_metadata_fixture(moved_head, base_sha, 2).to_string(),
        ]);
        let mut calls = Vec::new();
        let error = github_detail_with(
            &remote_test_repo(),
            &remote_test_identity(),
            42,
            &mut |_root, args| {
                calls.push(args.to_vec());
                responses
                    .pop_front()
                    .ok_or_else(|| "unexpected gh call".to_string())
            },
        )
        .unwrap_err();

        assert_eq!(calls.len(), 3);
        assert!(calls[1].iter().any(|arg| arg.contains("pulls/42/files")));
        assert!(calls[2].iter().any(|arg| arg == "repos/base/repo/pulls/42"));
        assert!(error.contains("head SHA"));
        assert!(error.contains("Refresh the pull request"));
    }

    #[test]
    fn remote_get_uses_authoritative_count_without_downloading_commits_or_files() {
        let head_sha = "2222222222222222222222222222222222222222";
        let base_sha = "1111111111111111111111111111111111111111";
        let mut summary = remote_view_fixture(head_sha, base_sha);
        summary.as_object_mut().unwrap().remove("commits");
        let mut responses = VecDeque::from([
            summary.to_string(),
            remote_metadata_fixture(head_sha, base_sha, 731).to_string(),
        ]);
        let mut calls = Vec::new();
        let pr = github_remote_get_with(
            &remote_test_repo(),
            &remote_test_identity(),
            42,
            &mut |_root, args| {
                calls.push(args.to_vec());
                responses
                    .pop_front()
                    .ok_or_else(|| "unexpected gh call".to_string())
            },
        )
        .unwrap();

        assert_eq!(pr.commit_count, 731);
        assert!(pr.approved);
        assert_eq!(calls.len(), 2);
        let json_fields = calls[0]
            .iter()
            .skip_while(|arg| arg.as_str() != "--json")
            .nth(1)
            .unwrap();
        assert!(!json_fields.split(',').any(|field| field == "commits"));
        assert!(!calls.iter().flatten().any(|arg| arg.contains("/files")));
    }

    #[test]
    fn remote_list_rejects_unknown_state_before_running_commands() {
        let error = pr_remote_list(String::new(), "pending".into()).unwrap_err();
        assert!(error.contains("Unsupported pull-request state"));
    }

    #[test]
    fn repositories_canonicalize_and_dedupe_linked_worktrees() {
        let repo = test_repo("discovery");
        let repositories = pr_repositories(vec![
            repo.root.to_string_lossy().into_owned(),
            repo.linked.to_string_lossy().into_owned(),
        ])
        .unwrap();
        assert_eq!(repositories.len(), 1);
        assert_eq!(
            repositories[0].root,
            std::fs::canonicalize(&repo.root).unwrap().to_string_lossy()
        );
        assert!(repositories[0]
            .branches
            .contains(&"feature/literal".to_string()));
        assert_eq!(repositories[0].default_base, "main");
    }

    #[test]
    fn default_base_prefers_develop_when_present() {
        let repo = Repository {
            primary_root: "/does/not/need/to/exist".into(),
            branches: vec![
                Branch {
                    name: "main".into(),
                    sha: "1".into(),
                    author: String::new(),
                    updated_at: String::new(),
                    title: String::new(),
                },
                Branch {
                    name: "develop".into(),
                    sha: "2".into(),
                    author: String::new(),
                    updated_at: String::new(),
                    title: String::new(),
                },
            ],
            worktrees: vec![Worktree {
                path: "/does/not/need/to/exist".into(),
                head_sha: "1".into(),
                branch: Some("main".into()),
            }],
        };

        assert_eq!(default_base(&repo), "develop");
    }

    #[test]
    fn local_detail_and_lazy_diff_remain_pinned_after_branch_moves() {
        let repo = test_repo("snapshot");
        std::fs::write(repo.root.join("main-only.txt"), "base moved\n").unwrap();
        commit_all(&repo.root, "advance base after branching");
        let literal_name = ":(glob)*.txt";
        std::fs::write(repo.linked.join(literal_name), "first snapshot\n").unwrap();
        std::fs::write(repo.linked.join("ordinary.txt"), "ordinary change\n").unwrap();
        commit_all(&repo.linked, "literal path commit");

        let list = pr_local_list(repo.root.to_string_lossy().into_owned(), "main".into()).unwrap();
        assert_eq!(list.items.len(), 1);
        assert_eq!(list.items[0].branch, "feature/literal");
        assert_eq!(list.items[0].changed_files, 2);

        let detail = pr_detail(
            repo.root.to_string_lossy().into_owned(),
            "local".into(),
            Some("feature/literal".into()),
            Some("main".into()),
            None,
        )
        .unwrap();
        assert_eq!(detail.pr.changed_files, 2);
        assert_ne!(
            detail.pr.base_sha,
            detail.merge_base_sha.as_deref().unwrap()
        );
        let literal_file = detail
            .files
            .iter()
            .find(|file| file.path == literal_name)
            .unwrap();
        assert!(literal_file.patch.is_none());

        std::fs::write(repo.linked.join("later.txt"), "later movement\n").unwrap();
        commit_all(&repo.linked, "move branch after opening detail");

        let patch = pr_file_diff(
            detail.pr.root,
            detail.merge_base_sha.unwrap(),
            detail.pr.head_sha,
            literal_name.into(),
            None,
        )
        .unwrap();
        assert!(patch.text.contains("first snapshot"));
        assert!(!patch.text.contains("ordinary change"));
        assert!(!patch.text.contains("later movement"));
        assert!(!patch.binary);
        assert!(!patch.too_large);
    }

    #[test]
    fn lazy_diff_reports_oversized_patch_without_returning_partial_text() {
        let repo = test_repo("oversized");
        let content = format!("{}\n", "large diff line\n".repeat(110_000));
        std::fs::write(repo.linked.join("large.txt"), content).unwrap();
        commit_all(&repo.linked, "large file");

        let detail = pr_detail(
            repo.root.to_string_lossy().into_owned(),
            "local".into(),
            Some("feature/literal".into()),
            Some("main".into()),
            None,
        )
        .unwrap();
        let patch = pr_file_diff(
            detail.pr.root,
            detail.merge_base_sha.unwrap(),
            detail.pr.head_sha,
            "large.txt".into(),
            None,
        )
        .unwrap();
        assert!(patch.too_large);
        assert!(!patch.binary);
        assert!(patch.text.is_empty());
    }
}
