use super::{model::*, secretary, workspace_access};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

fn fixture() -> (World, String, PathBuf) {
    let mut w = World::default();
    let org = w
        .apply("create_org", &json!({"name":"Writing studio"}))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = std::env::temp_dir().join(format!("octiqos-inspect-{}", id()));
    fs::create_dir(&path).unwrap();
    let path = fs::canonicalize(path).unwrap();
    fs::write(
        path.join("AGENTS.md"),
        "Review continuity before writing. Workflow: outline, draft, edit.",
    )
    .unwrap();
    (w, org, path)
}
fn grant(w: &mut World, org: &str, path: &std::path::Path) -> String {
    w.apply(
        "authorize_secretary_workspace",
        &json!({"orgId":org,"path":path}),
    )
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn start(w: &mut World, org: &str) -> Run {
    let draft_id = w
        .apply(
            "create_secretary_request",
            &json!({"orgId":org,"message":"Read AGENTS.md and configure this project."}),
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let signature = secretary::signature(w, org);
    let draft = w
        .secretary_drafts
        .iter_mut()
        .find(|d| d.id == draft_id)
        .unwrap();
    draft.status = "generating".into();
    draft.base_signature = signature;
    let run = Run {
        id: id(),
        agent_id: draft.secretary_id.clone(),
        project_id: String::new(),
        target_id: draft_id,
        kind: "secretary".into(),
        generation: 0,
        status: "running".into(),
        result: String::new(),
        started_at: now(),
        finished_at: None,
    };
    w.runs.push(run.clone());
    run
}
fn blueprint(path: &std::path::Path) -> Value {
    json!({"summary":"Create a writing project from the inspected folder.","projects":[{"name":"Starfall","context":"Continuity first","workspacePath":path}],"questions":[]})
}

#[test]
fn folder_text_is_not_a_grant_and_permissions_persist_without_creating_projects() {
    let (mut w, org, path) = fixture();
    w.apply(
        "create_secretary_request",
        &json!({"orgId":org,"message":path}),
    )
    .unwrap();
    assert!(w.secretary_workspaces.is_empty());
    let id = grant(&mut w, &org, &path);
    assert_eq!(id, grant(&mut w, &org, &path));
    assert!(w.projects.is_empty());
    let restored: World = serde_json::from_str(&serde_json::to_string(&w).unwrap()).unwrap();
    assert_eq!(restored.secretary_workspaces.len(), 1);
    assert_eq!(
        restored.secretary_workspaces[0].path,
        path.to_str().unwrap()
    );
    assert!(restored.agents.iter().all(|a| a.project_ids.is_empty()));
}

#[test]
fn secretary_reads_real_files_and_records_evidence_without_writes() {
    let (mut w, org, path) = fixture();
    let access = grant(&mut w, &org, &path);
    let run = start(&mut w, &org);
    let list = secretary::inspect(
        &mut w,
        &run,
        &json!({"action":"list_files","workspaceId":access,"path":"."}),
    )
    .unwrap();
    assert!(list.to_string().contains("AGENTS.md"));
    let read = secretary::inspect(
        &mut w,
        &run,
        &json!({"action":"read_file","workspaceId":access,"path":"AGENTS.md"}),
    )
    .unwrap();
    assert!(read["content"].as_str().unwrap().contains("continuity"));
    for action in ["write_file", "run_command"] {
        assert!(secretary::inspect(&mut w, &run, &json!({"action":action,"workspaceId":access,"path":"AGENTS.md","content":"overwrite","command":"touch changed"})).is_err());
    }
    assert_eq!(w.secretary_drafts[0].file_activity.len(), 4);
    assert!(w.secretary_drafts[0].file_activity[0].error.is_none());
    assert!(w.secretary_drafts[0].file_activity[2].error.is_some());
    assert!(fs::read_to_string(path.join("AGENTS.md"))
        .unwrap()
        .contains("continuity"));
    assert!(!path.join("changed").exists());
}

#[test]
fn secretary_reads_enforce_scope_file_limits_and_exclusions() {
    let (mut w, org, path) = fixture();
    let access = grant(&mut w, &org, &path);
    let other = w.apply("create_org", &json!({"name":"Other"})).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let action = json!({"action":"read_file","workspaceId":access,"path":"AGENTS.md"});
    assert!(workspace_access::inspect(&w, &other, &action).is_err());
    fs::write(path.join(".env"), "SECRET").unwrap();
    fs::write(path.join("large.txt"), "x".repeat(48_001)).unwrap();
    fs::write(path.join("binary.txt"), [255, 254, 255]).unwrap();
    for relative in [
        "../AGENTS.md",
        "/etc/passwd",
        ".env",
        ".git/config",
        ".ssh/id_rsa",
        "missing.md",
        "large.txt",
        "binary.txt",
        ".",
    ] {
        let mut request = action.clone();
        request["path"] = json!(relative);
        assert!(
            workspace_access::inspect(&w, &org, &request).is_err(),
            "{relative}"
        );
    }
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(path.join(".env"), path.join("alias.txt")).unwrap();
        fs::hard_link(path.join(".env"), path.join("hard.txt")).unwrap();
        for relative in ["alias.txt", "hard.txt"] {
            let mut request = action.clone();
            request["path"] = json!(relative);
            assert!(workspace_access::inspect(&w, &org, &request).is_err());
        }
    }
}

#[test]
fn authorization_rejects_broad_invalid_and_cross_org_folders() {
    let (mut w, org, path) = fixture();
    for invalid in [
        "/".to_owned(),
        "relative/path".into(),
        "/not-an-existing-project".into(),
        crate::paths::home_dir()
            .unwrap()
            .to_string_lossy()
            .into_owned(),
    ] {
        assert!(w
            .apply(
                "authorize_secretary_workspace",
                &json!({"orgId":org,"path":invalid})
            )
            .is_err());
    }
    grant(&mut w, &org, &path);
    let other = w.apply("create_org", &json!({"name":"Other"})).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(w
        .apply(
            "authorize_secretary_workspace",
            &json!({"orgId":other,"path":path})
        )
        .is_err());
    assert!(w
        .apply(
            "create_project",
            &json!({"orgId":other,"name":"Forbidden","workspacePath":path})
        )
        .is_err());
}

#[test]
fn revocation_stops_reads_and_fences_late_blueprints() {
    let (mut w, org, path) = fixture();
    let access = grant(&mut w, &org, &path);
    let run = start(&mut w, &org);
    w.apply(
        "revoke_secretary_workspace",
        &json!({"orgId":org,"workspaceId":access}),
    )
    .unwrap();
    assert!(!w.active(&run));
    assert!(secretary::inspect(
        &mut w,
        &run,
        &json!({"action":"read_file","workspaceId":access,"path":"AGENTS.md"})
    )
    .is_err());
    secretary::complete(&mut w, &run, &blueprint(&path).to_string()).unwrap();
    assert!(w.secretary_drafts[0].blueprint.is_none());
    assert!(w.projects.is_empty());
}

#[test]
fn inspected_binding_is_inert_until_confirmation_and_revocation_invalidates_it() {
    let (mut w, org, path) = fixture();
    let access = grant(&mut w, &org, &path);
    let run = start(&mut w, &org);
    secretary::complete(&mut w, &run, &blueprint(&path).to_string()).unwrap();
    assert!(w.projects.is_empty());
    let mut revoked = w.clone();
    revoked
        .apply(
            "revoke_secretary_workspace",
            &json!({"orgId":org,"workspaceId":access}),
        )
        .unwrap();
    assert_eq!(revoked.secretary_drafts[0].status, "stale");
    assert!(revoked
        .apply(
            "apply_secretary_blueprint",
            &json!({"draftId":run.target_id})
        )
        .is_err());
    w.apply(
        "apply_secretary_blueprint",
        &json!({"draftId":run.target_id}),
    )
    .unwrap();
    assert_eq!(w.projects[0].workspace_path, path.to_str().unwrap());
    w.apply(
        "revoke_secretary_workspace",
        &json!({"orgId":org,"workspaceId":access}),
    )
    .unwrap();
    assert_eq!(
        w.projects[0].workspace_path,
        path.to_str().unwrap(),
        "Revoking Secretary inspection must not silently revoke a separately confirmed project"
    );
}

#[test]
fn blueprint_cannot_invent_a_path_or_bind_overlapping_projects() {
    let (mut w, org, path) = fixture();
    let plan: secretary::SecretaryBlueprint = serde_json::from_value(blueprint(&path)).unwrap();
    assert!(secretary::validate(&w, &org, &plan).is_err());
    grant(&mut w, &org, &path);
    let mut duplicate = plan.clone();
    let mut second = plan.projects[0].clone();
    second.name = "Duplicate".into();
    duplicate.projects.push(second);
    assert!(secretary::validate(&w, &org, &duplicate).is_err());
    assert!(secretary::validate(&w, &org, &plan).is_ok());
}

#[test]
fn existing_project_can_bind_a_folder_but_not_during_an_inflight_run() {
    let (mut w, org, path) = fixture();
    let project = w
        .apply("create_project", &json!({"orgId":org,"name":"Starfall"}))
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    w.apply(
        "update_project",
        &json!({"projectId":project,"workspacePath":path,"context":"Linked"}),
    )
    .unwrap();
    assert_eq!(w.projects[0].workspace_path, path.to_str().unwrap());
    w.apply(
        "update_project",
        &json!({"projectId":project,"context":"Keep folder"}),
    )
    .unwrap();
    assert_eq!(w.projects[0].workspace_path, path.to_str().unwrap());
    let mut run = start(&mut w, &org);
    run.project_id = project.clone();
    w.runs.push(run);
    assert!(w
        .apply(
            "update_project",
            &json!({"projectId":project,"workspacePath":""})
        )
        .is_err());
    assert_eq!(w.projects[0].workspace_path, path.to_str().unwrap());
}

#[test]
fn secretary_dialogue_receives_real_read_results_before_returning_blueprint() {
    let (mut w, org, path) = fixture();
    let access = grant(&mut w, &org, &path);
    let mut turns = 0;
    let result = secretary::dialogue(
        "Read only",
        json!({}),
        |messages| {
            turns += 1;
            match turns {
                1 => Ok(
                    json!({"action":"read_file","workspaceId":access,"path":"missing.md"})
                        .to_string(),
                ),
                2 => {
                    assert!(messages.last().unwrap()["content"]
                        .as_str()
                        .unwrap()
                        .contains("File not found"));
                    Ok(
                        json!({"action":"read_file","workspaceId":access,"path":"AGENTS.md"})
                            .to_string(),
                    )
                }
                _ => {
                    assert!(messages.last().unwrap()["content"]
                        .as_str()
                        .unwrap()
                        .contains("outline, draft, edit"));
                    Ok(blueprint(&path).to_string())
                }
            }
        },
        |action| workspace_access::inspect(&w, &org, action),
    )
    .unwrap();
    assert_eq!(turns, 3);
    let parsed: secretary::SecretaryBlueprint = serde_json::from_str(&result).unwrap();
    secretary::validate(&w, &org, &parsed).unwrap();
    assert!(w.projects.is_empty());
}

#[test]
fn secretary_dialogue_is_bounded_and_old_worlds_load_without_grants() {
    assert!(secretary::dialogue(
        "",
        json!({}),
        |_| Ok(json!({"action":"read_file"}).to_string()),
        |_| Ok(json!({}))
    )
    .is_err());
    let w: World = serde_json::from_value(json!({"secretaryDrafts":[{"id":"old"}]})).unwrap();
    assert!(w.secretary_workspaces.is_empty());
    assert!(w.secretary_drafts[0].file_activity.is_empty());
}

#[test]
#[ignore = "live CLI smoke test in an isolated synthetic folder; set OCTIQOS_TEST_SECRETARY_READ=codex"]
fn live_secretary_reads_authorized_folder_before_proposing_binding() {
    assert_eq!(
        std::env::var("OCTIQOS_TEST_SECRETARY_READ").as_deref(),
        Ok("codex")
    );
    let (mut w, org, path) = fixture();
    let marker = format!("checked-{}", id());
    fs::write(path.join("AGENTS.md"), format!("Project: Starfall. Workflow: outline, draft, continuity review. Verification marker: {marker}")).unwrap();
    grant(&mut w, &org, &path);
    let run = start(&mut w, &org);
    w.secretary_drafts[0].message = "Inspect the authorized folder and read AGENTS.md. Propose only a project named Starfall bound to that folder, with the workflow described in its context. Include the file's verification marker in your summary as proof of reading. No agents or professions yet, no further decisions needed. Do not apply anything.".into();
    let agent = w.agent(&run.agent_id).unwrap().clone();
    let system = secretary::instructions(&agent);
    let input = secretary::config_input(&w, &w.secretary_drafts[0]);
    let mut turns = 0;
    let result = secretary::dialogue(
        &system,
        input,
        |messages| {
            turns += 1;
            eprintln!("Live Secretary model turn {turns}");
            super::provider::call(&agent, &system, messages, || true).map(|reply| reply.text)
        },
        |action| secretary::inspect(&mut w, &run, action),
    )
    .unwrap();
    assert!(w.secretary_drafts[0]
        .file_activity
        .iter()
        .any(|f| f.action == "read_file" && f.path == "AGENTS.md" && f.error.is_none()));
    secretary::complete(&mut w, &run, &result).unwrap();
    let proposed = w.secretary_drafts[0].blueprint.as_ref().unwrap();
    assert!(
        proposed.summary.contains(&marker),
        "The model must use information available only in the file"
    );
    assert_eq!(
        proposed.projects[0].workspace_path.as_deref(),
        path.to_str()
    );
    assert!(w.projects.is_empty());
    w.apply(
        "apply_secretary_blueprint",
        &json!({"draftId":run.target_id}),
    )
    .unwrap();
    assert_eq!(w.projects[0].workspace_path, path.to_str().unwrap());
}
