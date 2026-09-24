//! Browser PR commands. GitHub observations are constructed here, never accepted
//! from a browser as evidence for completing a chat or updating a ticket.
use std::sync::Mutex;

use serde_json::Value;

use super::{arg, to_value, Services};
use crate::git::pull_requests as data;
use crate::pr_workflow as workflow;

// Keep overlapping refresh/save requests ordered through their remote read and
// persisted update. A slower, older response must not restore revoked approval.
static OBSERVATION_LOCK: Mutex<()> = Mutex::new(());

fn canonical_root(root: String) -> Result<String, String> {
    data::pr_repositories(vec![root])?
        .into_iter()
        .next()
        .map(|repository| repository.root)
        .ok_or_else(|| "This folder is not an available Git repository.".into())
}

fn observation(root: String, number: u64) -> Result<workflow::PrObservation, String> {
    if number == 0 {
        return Err("Choose a GitHub pull request.".into());
    }
    let pr = data::pr_remote_get(root, number)?;
    Ok(workflow::PrObservation {
        root: pr.root,
        number: pr.number.ok_or("The GitHub PR number is missing.")?,
        url: pr.url.ok_or("The GitHub PR URL is missing.")?,
        head_sha: pr.head_sha,
        base_sha: pr.base_sha,
        state: pr.state,
        approved: pr.approved,
    })
}

fn validate_linked_chat(svc: &Services, root: &str, chat_id: &str) -> Result<(), String> {
    svc.orchestrations
        .require_user_chat(&format!("chat:{chat_id}"))?;
    let chat = crate::chat_index::list()
        .into_iter()
        .find(|chat| chat.id == chat_id)
        .ok_or("The linked chat no longer exists.")?;
    let project = crate::workspaces::list_workspaces_impl(&svc.workspaces)?
        .into_iter()
        .find(|project| project.id == chat.project_id)
        .ok_or("The linked chat's project no longer exists.")?;
    let mut paths = project.paths;
    if !project.primary_path.trim().is_empty() {
        paths.push(project.primary_path);
    }
    if !data::pr_repositories(paths)?
        .iter()
        .any(|repository| repository.root == root)
    {
        return Err("Choose a chat from a project containing this repository.".into());
    }
    Ok(())
}

pub(super) fn dispatch(svc: &Services, cmd: &str, args: Value) -> Result<Value, String> {
    match cmd {
        "pr_repositories" => to_value(data::pr_repositories(arg(&args, "paths")?)),
        "pr_local_list" => to_value(data::pr_local_list(
            arg(&args, "root")?,
            arg(&args, "base")?,
        )),
        "pr_remote_list" => to_value(data::pr_remote_list(
            arg(&args, "root")?,
            arg(&args, "state")?,
        )),
        "pr_detail" => to_value(data::pr_detail(
            arg(&args, "root")?,
            arg(&args, "source")?,
            arg(&args, "branch")?,
            arg(&args, "base")?,
            arg(&args, "number")?,
        )),
        "pr_file_diff" => to_value(data::pr_file_diff(
            arg(&args, "root")?,
            arg(&args, "baseSha")?,
            arg(&args, "headSha")?,
            arg(&args, "file")?,
            arg(&args, "oldPath")?,
        )),
        "pr_workflow_get" => to_value(workflow::get(
            canonical_root(arg(&args, "root")?)?,
            arg(&args, "number")?,
        )),
        "pr_workflow_save" => {
            let _guard = OBSERVATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let observed = observation(arg(&args, "root")?, arg(&args, "number")?)?;
            let chat_id: Option<String> = arg(&args, "chatId")?;
            if let Some(id) = &chat_id {
                validate_linked_chat(svc, &observed.root, id)?;
            }
            to_value(workflow::save(
                observed,
                arg(&args, "expectedHeadSha")?,
                chat_id,
                arg(&args, "ticket")?,
                arg(&args, "completeOn")?,
            ))
        }
        "pr_completion_refresh" => {
            let _guard = OBSERVATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            to_value(workflow::refresh(observation(
                arg(&args, "root")?,
                arg(&args, "number")?,
            )?))
        }
        "pr_ticket_prepare" => {
            let _guard = OBSERVATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            to_value(workflow::prepare_ticket(
                observation(arg(&args, "root")?, arg(&args, "number")?)?,
                arg(&args, "expectedHeadSha")?,
            ))
        }
        "pr_ticket_attach" => {
            let _guard = OBSERVATION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let action_id: String = arg(&args, "actionId")?;
            let chat_id: String = arg(&args, "chatId")?;
            let current = workflow::workflow_for_action(action_id.clone())?;
            validate_linked_chat(svc, &current.root, &chat_id)?;
            // Preparing and claiming a chat are separate requests. Revalidate
            // before launch if the PR moved or approval was revoked between them.
            workflow::refresh(observation(current.root, current.number)?)?;
            to_value(workflow::attach_ticket(action_id, chat_id))
        }
        "pr_ticket_confirm" => {
            let action_id: String = arg(&args, "actionId")?;
            let confirmed: bool = arg(&args, "confirmed")?;
            // Failure recording must work offline. Success checks that the
            // action still belongs to an eligible, current GitHub snapshot.
            let _guard =
                confirmed.then(|| OBSERVATION_LOCK.lock().unwrap_or_else(|e| e.into_inner()));
            if confirmed {
                let current = workflow::workflow_for_action(action_id.clone())?;
                workflow::refresh(observation(current.root, current.number)?)?;
            }
            to_value(workflow::confirm_ticket(
                action_id,
                confirmed,
                arg(&args, "message")?,
            ))
        }
        _ => Err(format!("Unknown pull request command: {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, path::PathBuf, process::Command};

    struct Repository(PathBuf);

    impl Repository {
        fn new() -> Self {
            let root =
                std::env::temp_dir().join(format!("octiq-pr-routing-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let repo = Self(root);
            repo.git(&["init", "-q", "-b", "develop"]);
            repo.git(&["config", "user.name", "PR test"]);
            repo.git(&["config", "user.email", "pr-test@example.invalid"]);
            fs::write(repo.0.join("change.txt"), "base\n").unwrap();
            repo.commit("initial");
            repo
        }

        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .current_dir(&self.0)
                .args([
                    "-c",
                    "commit.gpgsign=false",
                    "-c",
                    "core.hooksPath=/dev/null",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().into()
        }

        fn commit(&self, message: &str) {
            self.git(&["add", "."]);
            self.git(&["commit", "-qm", message]);
        }
    }

    impl Drop for Repository {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn browser_pr_commands_preserve_the_selected_commit_snapshot() {
        let repo = Repository::new();
        repo.git(&["checkout", "-qb", "feature/pr-preview"]);
        fs::write(repo.0.join("change.txt"), "base\nselected change\n").unwrap();
        repo.commit("Preview this change");
        let svc = Services::load();
        let root = repo.0.to_string_lossy().into_owned();
        let repositories =
            super::super::dispatch(&svc, "pr_repositories", json!({"paths": [root, root]}))
                .unwrap();
        assert_eq!(repositories.as_array().unwrap().len(), 1);
        let list = super::super::dispatch(
            &svc,
            "pr_local_list",
            json!({"root": root, "base": "develop"}),
        )
        .unwrap();
        assert!(list["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["branch"] == "feature/pr-preview"));
        let detail = super::super::dispatch(
            &svc, "pr_detail", json!({"root": root, "source": "local", "branch": "feature/pr-preview", "base": "develop"}),
        ).unwrap();
        assert_eq!(detail["files"][0]["path"], "change.txt");
        assert_eq!(detail["pr"]["source"], "local");

        // Both the branch tip and the working copy change after selecting the
        // PR. The lazy file preview must continue to show the selected commit.
        fs::write(
            repo.0.join("change.txt"),
            "base\nselected change\nlater commit\n",
        )
        .unwrap();
        repo.commit("Later work");
        fs::write(repo.0.join("change.txt"), "uncommitted work\n").unwrap();
        let patch = super::super::dispatch(
            &svc, "pr_file_diff", json!({"root": root, "baseSha": detail["mergeBaseSha"], "headSha": detail["pr"]["headSha"], "file": "change.txt", "oldPath": null}),
        ).unwrap();
        let text = patch["text"].as_str().unwrap();
        assert!(text.contains("+selected change"), "{text}");
        assert!(!text.contains("later commit"), "{text}");
        assert!(!text.contains("uncommitted work"), "{text}");
        assert_eq!(
            repo.git(&["branch", "--show-current"]),
            "feature/pr-preview"
        );
        assert_eq!(
            fs::read_to_string(repo.0.join("change.txt")).unwrap(),
            "uncommitted work\n"
        );
    }
}
