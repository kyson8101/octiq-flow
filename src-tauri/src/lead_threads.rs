//! Host-owned ongoing conversations for the person's leads. No worker allocation.
use crate::{chat_index::ChatMeta, team::TeamAgent, workspaces::Workspace};
use serde::Serialize;
use std::{path::Path, sync::Mutex};

static OPEN: Mutex<()> = Mutex::new(());
pub const CONDUCT: &str = "You are in the project's main checkout: do not edit source here; dispatch code changes to a worker.";

pub fn is_id(id: &str) -> bool {
    id.starts_with("lead-")
}
pub fn is_key(key: &str) -> bool {
    key.strip_prefix("chat:").is_some_and(is_id)
}
pub fn key(agent: &str) -> String {
    format!("chat:lead-{agent}")
}
pub fn require_disposable(id: &str) -> Result<(), String> {
    if is_id(id) {
        return Err("A lead's ongoing thread cannot be completed or moved to trash. Use /clear to clear its history.".into());
    }
    Ok(())
}

fn lead(path: &Path, id: &str) -> Result<TeamAgent, String> {
    let desk = crate::team::front_desk(path)?;
    crate::team::list(path, None, true)?
        .into_iter()
        .find(|a| {
            a.id == id && a.reports_to.is_none() && desk.as_ref().is_none_or(|d| d.id != a.id)
        })
        .ok_or_else(|| "That agent is not a lead who reports directly to the person.".into())
}

/// Scoped registration wins; global leads use the configured team home (General fallback).
pub(crate) fn location(
    path: &Path,
    agent: &TeamAgent,
    projects: &[Workspace],
) -> Result<(Workspace, String), String> {
    let names: Vec<_> = projects
        .iter()
        .map(|p| (p.id.clone(), p.name.clone()))
        .collect();
    let home = crate::team::home(path)?;
    let id = agent.project_id.as_deref().or_else(|| crate::team::home_project(home.as_deref(), &names).map(|(id,_)| id.as_str()))
        .ok_or("This all-projects lead needs a team home. Choose a home workspace in Settings, Agents.")?;
    let project = projects
        .iter()
        .find(|p| p.id == id)
        .ok_or("The lead's home project is no longer registered.")?
        .clone();
    let cwd = primary(&project.primary_path)?;
    Ok((project, cwd))
}

pub(crate) fn primary(path: &str) -> Result<String, String> {
    // Missing folders remain visible in the directory; start refuses in words.
    if !Path::new(path).is_dir() {
        return Ok(path.into());
    }
    match crate::git::run_git(path, &["rev-parse", "--show-toplevel"]) {
        Some(root) => crate::git_ops::primary_checkout_root(root.trim())
            .map(|p| p.to_string_lossy().into_owned()),
        None => Ok(path.into()),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Thread {
    agent_id: String,
    name: String,
    chat_key: String,
    cwd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    exists: bool,
}
pub fn list(path: &Path, projects: &[Workspace]) -> Result<Vec<Thread>, String> {
    crate::profile::available()?;
    let desk = crate::team::front_desk(path)?;
    let roster = crate::team::list(path, None, true)?;
    let rows = crate::chat_index::list_checked()?;
    roster
        .into_iter()
        .filter(|a| a.reports_to.is_none() && desk.as_ref().is_none_or(|d| d.id != a.id))
        .map(|a| {
            let (project, cwd) = location(path, &a, projects)?;
            let exists = rows
                .iter()
                .any(|r| r.id == format!("lead-{}", a.id) && r.lead_of.as_deref() == Some(&a.id));
            Ok(Thread {
                chat_key: key(&a.id),
                agent_id: a.id,
                name: a.name,
                cwd,
                project: Some(project.id),
                exists,
            })
        })
        .collect()
}

pub fn open(path: &Path, projects: &[Workspace], id: &str) -> Result<ChatMeta, String> {
    crate::profile::available()?;
    if crate::scheduling::load()?.orientation != crate::scheduling::Orientation::Agents {
        return Err("Lead threads are available in Agents orientation. Select Agents in Settings, Orientation.".into());
    }
    open_checked(path, projects, id)
}

fn open_checked(path: &Path, projects: &[Workspace], id: &str) -> Result<ChatMeta, String> {
    crate::profile::available()?;
    let _guard = OPEN.lock().map_err(|e| e.to_string())?;
    let agent = lead(path, id)?;
    let (project, cwd) = location(path, &agent, projects)?;
    let now = crate::auto_resume::unix_now() as i64 * 1000;
    let meta: ChatMeta = serde_json::from_value(serde_json::json!({
        "id":format!("lead-{id}"),"leadOf":id,"projectId":project.id,"title":agent.name,
        "cwd":cwd,"modelId":crate::orchestration::model_id(agent.agent,Some(&agent.model)),
        "access":crate::orchestration::access_id(agent.access),"effort":agent.effort,
        "createdAt":now,"updatedAt":now
    }))
    .map_err(|e| e.to_string())?;
    let saved = crate::chat_index::ensure_lead(meta)?;
    // Idempotent opens must not erase an already delivered roster receipt.
    if crate::team::lead_for_chat(path, &key(id))?.is_none() {
        crate::team::record_lead(path, &key(id), &agent, &project.id, false)?;
    }
    crate::agent_chat::announce_index_change(&saved.id, false);
    Ok(saved)
}

/// Recover the existing thread's runtime, including a provider failover.
/// A native session id must never be passed back to a different provider.
pub(crate) fn saved_settings(
    meta: &ChatMeta,
) -> Result<crate::provider_failover::Settings, String> {
    use crate::agent_chat::ChatAgent;
    let (provider, model) = meta
        .model_id
        .as_deref()
        .and_then(|id| id.split_once(':'))
        .ok_or(
        "The lead thread has no saved model settings. Open it in Chat before routing more work.",
    )?;
    let agent: ChatAgent = serde_json::from_value(serde_json::json!(provider))
        .map_err(|_| "The lead thread's saved provider is not supported.")?;
    let model =
        if model == "default" {
            None
        } else if let Some(encoded) = model.strip_prefix("model:") {
            let query = format!("model={encoded}");
            Some(
                url::form_urlencoded::parse(query.as_bytes())
                    .next()
                    .ok_or("The lead thread's saved model could not be read.")?
                    .1
                    .into_owned(),
            )
        } else {
            Some(match (agent, model) {
                (ChatAgent::Claude, "opus" | "sonnet" | "haiku" | "fable") => model.to_owned(),
                (ChatAgent::Claude, pinned)
                    if pinned.starts_with("opus-")
                        || pinned.starts_with("sonnet-")
                        || pinned.starts_with("haiku-") =>
                {
                    format!("claude-{pinned}")
                }
                (ChatAgent::Codex | ChatAgent::Pi, "astra") => "gpt-6-astra".into(),
                (ChatAgent::Codex | ChatAgent::Pi, "sol") => "gpt-5.6-sol".into(),
                (ChatAgent::Codex | ChatAgent::Pi, "terra") => "gpt-5.6-terra".into(),
                (ChatAgent::Codex | ChatAgent::Pi, "luna") => "gpt-5.6-luna".into(),
                (ChatAgent::Antigravity, preset) if preset.starts_with("gemini-3-8-") => {
                    preset.replacen("gemini-3-8-", "gemini-3.8-", 1)
                }
                (ChatAgent::Antigravity, preset) if preset.starts_with("gemini-3-1-") => {
                    preset.replacen("gemini-3-1-", "gemini-3.1-", 1)
                }
                (
                    ChatAgent::Antigravity,
                    "claude-sonnet-4-6" | "claude-opus-4-6-thinking" | "gpt-oss-120b-medium",
                ) => model.into(),
                _ => return Err(
                    "The lead thread's saved model could not be resolved. Resume it in Chat first."
                        .into(),
                ),
            })
        };
    let access = serde_json::from_value(serde_json::json!(meta
        .access
        .as_deref()
        .ok_or("The lead thread has no saved access level.")?))
    .map_err(|_| "The lead thread's saved access level is not supported.")?;
    Ok(crate::provider_failover::Settings {
        agent,
        model,
        access,
        effort: meta.effort.clone(),
    })
}

/// Only a host-persisted reserved row may be started, at its saved home.
pub fn validate_start(key: &str, cwd: &str) -> Result<(), String> {
    if !is_key(key) {
        return Ok(());
    }
    crate::profile::available()?;
    let id = key.trim_start_matches("chat:");
    let row = crate::chat_index::find(id)?
        .filter(|r| r.lead_of.as_ref().is_some_and(|a| self::key(a) == key))
        .ok_or("Lead thread ids are reserved for the host. Open the lead thread first.")?;
    if row.cwd.as_deref() != Some(cwd) {
        return Err("A lead thread runs only in its project's main checkout.".into());
    }
    if !Path::new(cwd).is_dir() {
        return Err(format!("The lead thread's main checkout is missing: {cwd}. Restore that folder before starting the thread; OctiqFlow will not rebuild or move it."));
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    chat_key: String,
    title: String,
    updated_at: i64,
    done: bool,
}
pub fn history(
    path: &Path,
    ledger: &crate::orchestration::OrchestrationStore,
    id: &str,
) -> Result<Vec<History>, String> {
    crate::profile::available()?;
    lead(path, id)?;
    let keys: std::collections::HashSet<_> = crate::team::leads(path)?
        .into_iter()
        .filter(|r| r.lead_id == id)
        .map(|r| r.chat_key)
        .collect();
    let mut rows = crate::chat_index::list_checked()?;
    rows.sort_by_key(|r| std::cmp::Reverse(r.updated_at));
    rows.into_iter()
        .filter(|r| !is_id(&r.id) && keys.contains(&format!("chat:{}", r.id)))
        .filter_map(|r| {
            let chat_key = format!("chat:{}", r.id);
            match ledger.is_worker_chat(&chat_key) {
                Ok(true) => None,
                Err(e) => Some(Err(e)),
                Ok(false) => Some(Ok(History {
                    done: r.is_done(),
                    chat_key,
                    title: r.title,
                    updated_at: r.updated_at,
                })),
            }
        })
        .collect()
}

pub(crate) fn routing_target(
    path: &Path,
    projects: &[Workspace],
    id: &str,
) -> Result<Option<(Workspace, String)>, String> {
    if crate::scheduling::load()?.orientation != crate::scheduling::Orientation::Agents {
        return Ok(None);
    }
    let desk = crate::team::front_desk(path)?;
    let roster = crate::team::list(path, None, true)?;
    let Some(agent) = roster.into_iter().find(|a| {
        a.id == id && a.reports_to.is_none() && desk.as_ref().is_none_or(|d| d.id != a.id)
    }) else {
        return Ok(None);
    };
    location(path, &agent, projects).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TestDir;
    use serde_json::json;

    fn agent(path: &Path, id: &str, reports: Option<&str>, project: Option<&str>) -> TeamAgent {
        let a:TeamAgent=serde_json::from_value(json!({"id":id,"name":id,"role":"coordinates","agent":"claude","model":"sonnet","effort":"high","access":"full","projectId":project,"reportsTo":reports,"createdAt":1,"updatedAt":1})).unwrap();
        let mut stored: serde_json::Value = std::fs::read(path)
            .ok()
            .map(|b| serde_json::from_slice(&b).unwrap())
            .unwrap_or(json!({"agents":[],"home":"p"}));
        stored["agents"].as_array_mut().unwrap().push(json!(a));
        crate::profile::make_dir(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&stored).unwrap()).unwrap();
        a
    }
    fn project(path: &Path) -> Workspace {
        serde_json::from_value(
            json!({"id":"p","name":"Project","primary_path":path.to_string_lossy()}),
        )
        .unwrap()
    }
    fn mode() {
        crate::scheduling::save(crate::scheduling::Settings {
            orientation: crate::scheduling::Orientation::Agents,
            host_cap: None,
        })
        .unwrap();
    }
    fn row(id: &str) -> ChatMeta {
        serde_json::from_value(json!({"id":id,"projectId":"p","title":id})).unwrap()
    }

    #[test]
    fn leads_only_roster_order_lazy_idempotent_and_own_access() {
        let home = TestDir::new("lead-threads");
        let _pin = crate::profile::started_in(&home);
        let path = home.join("team.json");
        let a = agent(&path, "lead-a", None, Some("p"));
        agent(&path, "report", Some(&a.id), Some("p"));
        agent(&path, "global", None, None);
        agent(&path, "desk", None, None);
        crate::team::set_front_desk(&path, Some("desk")).unwrap();
        let projects = vec![project(&home)];
        mode();
        let before = list(&path, &projects).unwrap();
        assert_eq!(
            before
                .iter()
                .map(|r| r.agent_id.as_str())
                .collect::<Vec<_>>(),
            vec!["lead-a", "global"]
        );
        assert!(before.iter().all(|r| !r.exists));
        assert!(crate::chat_index::list().is_empty());
        let opened = open(&path, &projects, &a.id).unwrap();
        assert_eq!(opened.lead_of.as_deref(), Some("lead-a"));
        assert_eq!(opened.access.as_deref(), Some("full"));
        assert_eq!(opened.effort.as_deref(), Some("high"));
        crate::chat_index::lead_session(&opened.id, "native-session").unwrap();
        let again = open(&path, &projects, &a.id).unwrap();
        assert_eq!(opened.id, again.id);
        assert_eq!(again.session_id.as_deref(), Some("native-session"));
        assert_eq!(crate::chat_index::list().len(), 1);
        assert!(list(&path, &projects).unwrap()[0].exists);
        assert!(open(&path, &projects, "report")
            .unwrap_err()
            .contains("not a lead"));
        assert!(open(&path, &projects, "desk")
            .unwrap_err()
            .contains("not a lead"));
        let brief = crate::team::refresh_turn_brief(
            &path,
            &key(&a.id),
            "hello".into(),
            &[("p".into(), "Project".into())],
        )
        .unwrap();
        assert!(brief.contains("registered agent"));
    }

    #[test]
    fn saved_runtime_preserves_provider_model_and_access_after_failover() {
        use crate::agent_chat::{Access, ChatAgent};
        for (agent, model) in [
            (ChatAgent::Claude, "sonnet"),
            (ChatAgent::Codex, "gpt-6.1-sol"),
            (ChatAgent::Pi, "gpt-5.6-terra"),
            (ChatAgent::Antigravity, "gemini-3.8-flash-high"),
        ] {
            let mut meta = row("lead-runtime");
            meta.model_id = Some(crate::orchestration::model_id(agent, Some(model)));
            meta.access = Some("full".into());
            meta.effort = Some("high".into());
            let got = saved_settings(&meta).unwrap();
            assert_eq!(got.agent, agent);
            assert_eq!(got.model.as_deref(), Some(model));
            assert_eq!(got.access, Access::Full);
        }
    }

    #[test]
    fn two_simultaneous_open_bodies_make_one_durable_entry() {
        // Both threads use the test binary's scratch profile, not machine state.
        // Pass the already-checked Agents mode to the same open body.
        let dir = TestDir::new("lead-concurrent");
        let path = dir.join("team.json");
        let id = format!("concurrent-{}", uuid::Uuid::new_v4());
        agent(&path, &id, None, Some("p"));
        let projects = vec![project(&dir)];
        let barrier = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            let one = scope.spawn(|| {
                barrier.wait();
                open_checked(&path, &projects, &id).unwrap()
            });
            let two = scope.spawn(|| {
                barrier.wait();
                open_checked(&path, &projects, &id).unwrap()
            });
            assert_eq!(one.join().unwrap().id, two.join().unwrap().id);
        });
        assert_eq!(
            crate::chat_index::list()
                .iter()
                .filter(|r| r.lead_of.as_deref() == Some(&id))
                .count(),
            1
        );
    }

    #[test]
    fn reserved_identity_lifecycle_missing_folder_and_away_profile() {
        let home = TestDir::new("lead-guards");
        let _pin = crate::profile::started_in(&home);
        let path = home.join("team.json");
        let a = agent(&path, "chief", None, Some("p"));
        mode();
        let projects = vec![project(&home)];
        let mut forged = row("lead-forged");
        forged.lead_of = Some(a.id.clone());
        assert!(crate::chat_index::upsert(forged).is_err());
        let mut ordinary = row("ordinary");
        ordinary.lead_of = Some(a.id.clone());
        crate::chat_index::upsert(ordinary).unwrap();
        assert!(crate::chat_index::find("ordinary")
            .unwrap()
            .unwrap()
            .lead_of
            .is_none());
        assert!(validate_start("chat:lead-forged", home.to_str().unwrap())
            .unwrap_err()
            .contains("reserved"));
        let mut trashed = row("forged-trash");
        trashed.lead_of = Some(a.id.clone());
        crate::chat_index::trash("forged-trash", None, Some(trashed)).unwrap();
        assert!(crate::chat_index::deleted()
            .iter()
            .find(|r| r.id == "forged-trash")
            .unwrap()
            .lead_of
            .is_none());
        let opened = open(&path, &projects, &a.id).unwrap();
        let mut forged = opened.clone();
        forged.lead_of = None;
        forged.cwd = Some("somewhere-else".into());
        crate::chat_index::upsert(forged).unwrap();
        let saved = crate::chat_index::find(&opened.id).unwrap().unwrap();
        assert_eq!(saved.cwd, opened.cwd);
        assert_eq!(saved.lead_of, opened.lead_of);
        assert!(crate::chat_index::trash(&opened.id, None, None)
            .unwrap_err()
            .contains("ongoing thread"));
        assert!(crate::chat_index::set_done(&opened.id, Some(2)).is_err());
        let manager = std::sync::Arc::new(crate::agent_chat::ChatManager::default());
        assert!(
            crate::agent_chat::chat_complete_impl(&manager, &key(&a.id), "done")
                .unwrap_err()
                .contains("ongoing thread")
        );
        let missing = home.join("missing").to_string_lossy().into_owned();
        let mut absent = row("lead-absent");
        absent.lead_of = Some("absent".into());
        absent.cwd = Some(missing.clone());
        crate::chat_index::ensure_lead(absent).unwrap();
        assert!(validate_start("chat:lead-absent", &missing)
            .unwrap_err()
            .contains("will not rebuild"));
        assert!(crate::chat_recover::recover_from(
            &manager,
            "chat:lead-absent",
            &missing,
            || panic!("must never recover a lead thread")
        )
        .is_err());
        assert!(!Path::new(&missing).exists());
        let pinned = crate::profile::profile_dir();
        let moved = pinned.with_extension("away");
        std::fs::rename(&pinned, &moved).unwrap();
        assert!(open(&path, &projects, &a.id)
            .unwrap_err()
            .contains("not available"));
        assert!(list(&path, &projects).is_err());
        assert!(!pinned.exists());
        std::fs::rename(moved, pinned).unwrap();
    }

    #[test]
    fn primary_checkout_no_worktree_or_branch_is_created() {
        let home = TestDir::new("lead-primary");
        let _pin = crate::profile::started_in(&home);
        mode();
        let repo = home.join("repo");
        crate::profile::make_dir(&repo).unwrap();
        let git = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        git(&["init", "-b", "main"]);
        git(&[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "-m",
            "init",
        ]);
        let linked = home.join("linked");
        git(&[
            "worktree",
            "add",
            "-b",
            "existing",
            linked.to_str().unwrap(),
        ]);
        let before =
            crate::git::run_git(repo.to_str().unwrap(), &["worktree", "list", "--porcelain"])
                .unwrap();
        let branches = crate::git::run_git(repo.to_str().unwrap(), &["branch", "--list"]).unwrap();
        let path = home.join("team.json");
        agent(&path, "chief", None, Some("p"));
        let opened = open(&path, &[project(&linked)], "chief").unwrap();
        assert_eq!(
            Path::new(opened.cwd.as_deref().unwrap())
                .canonicalize()
                .unwrap(),
            repo.canonicalize().unwrap()
        );
        assert!(crate::git_ops::git_prepare_chat_workspace(
            linked.to_string_lossy().into_owned(),
            "main".into(),
            true,
            "work".into(),
            opened.id
        )
        .unwrap_err()
        .contains("without preparing"));
        assert_eq!(
            before,
            crate::git::run_git(repo.to_str().unwrap(), &["worktree", "list", "--porcelain"])
                .unwrap()
        );
        assert_eq!(
            branches,
            crate::git::run_git(repo.to_str().unwrap(), &["branch", "--list"]).unwrap()
        );
    }

    #[test]
    fn history_excludes_thread_and_workers_and_sorts_newest_first() {
        let home = TestDir::new("lead-history");
        let _pin = crate::profile::started_in(&home);
        mode();
        let path = home.join("team.json");
        let a = agent(&path, "chief", None, Some("p"));
        let projects = vec![project(&home)];
        open(&path, &projects, &a.id).unwrap();
        for (id, at) in [("older", 2), ("newer", 5), ("orch-worker", 9)] {
            let mut r = row(id);
            r.updated_at = at;
            crate::chat_index::upsert(r).unwrap();
            crate::team::record_lead(&path, &format!("chat:{id}"), &a, "p", false).unwrap();
        }
        crate::chat_index::set_done("newer", Some(6)).unwrap();
        let ledger = crate::orchestration::OrchestrationStore::load(home.join("ledger.json"));
        let run = ledger
            .create_run(
                key(&a.id),
                "Coordinate".into(),
                "p".into(),
                home.to_string_lossy().into_owned(),
                None,
            )
            .unwrap();
        assert_eq!(run.coordinator_chat_key, key(&a.id));
        let got = history(&path, &ledger, &a.id).unwrap();
        assert_eq!(
            got.iter().map(|r| r.chat_key.as_str()).collect::<Vec<_>>(),
            vec!["chat:newer", "chat:older"]
        );
        assert!(got[0].done);
    }
}
