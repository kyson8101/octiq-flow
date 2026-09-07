//! Founder-granted, read-only Secretary access and explicit project bindings.
use super::{model::*, runtime, secretary};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAccess {
    pub id: String,
    pub org_id: String,
    pub path: String,
}

fn root(path: &str) -> Result<PathBuf> {
    if !Path::new(path).is_absolute() {
        return Err("Choose an absolute project folder path on the server.".into());
    }
    let path = fs::canonicalize(path)
        .map_err(|_| "Choose an existing project folder on the server.".to_string())?;
    if !path.is_dir()
        || path.parent().is_none()
        || crate::paths::home_dir().is_some_and(|home| home.starts_with(&path))
    {
        return Err("Choose a specific project folder, not a filesystem or home folder.".into());
    }
    for part in path.components() {
        let part = part.as_os_str().to_string_lossy();
        if matches!(
            part.as_ref(),
            ".git" | ".ssh" | ".aws" | ".gnupg" | "node_modules" | "target"
        ) || part == ".env"
            || part.starts_with(".env.")
        {
            return Err("That folder is excluded from agent file access.".into());
        }
    }
    Ok(path)
}

fn overlaps(a: &Path, b: &str) -> bool {
    // Keep the stored boundary even if the other folder is temporarily offline.
    let b = fs::canonicalize(b).unwrap_or_else(|_| PathBuf::from(b));
    a.starts_with(&b) || b.starts_with(a)
}

pub fn binding(w: &World, org: &str, path: &str, project_id: Option<&str>) -> Result<String> {
    w.org(org)?;
    if path.is_empty() {
        return Ok(String::new());
    }
    let path = root(path)?;
    for project in &w.projects {
        if Some(project.id.as_str()) != project_id
            && !project.workspace_path.is_empty()
            && overlaps(&path, &project.workspace_path)
        {
            return Err("Project folders cannot overlap. Reuse the existing project or choose a separate folder.".into());
        }
    }
    if w.secretary_workspaces
        .iter()
        .any(|access| access.org_id != org && overlaps(&path, &access.path))
    {
        return Err("This folder overlaps another organization's authorized folder.".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

pub fn authorize(w: &mut World, args: &Value) -> Result<Value> {
    let org = text(args, "orgId", 80)?;
    w.org(&org)?;
    let path = root(&text(args, "path", 2000)?)?;
    if w.projects.iter().any(|p| {
        !p.workspace_path.is_empty()
            && overlaps(&path, &p.workspace_path)
            && (p.org_id != org
                || fs::canonicalize(&p.workspace_path).ok().as_deref() != Some(path.as_path()))
    }) || w
        .secretary_workspaces
        .iter()
        .any(|a| a.org_id != org && overlaps(&path, &a.path))
    {
        return Err("Choose a separate project folder, or the exact folder of a project in this organization.".into());
    }
    if let Some(access) = w
        .secretary_workspaces
        .iter()
        .find(|a| a.org_id == org && Path::new(&a.path) == path)
    {
        return Ok(json!({"id":access.id}));
    }
    if w.secretary_workspaces
        .iter()
        .filter(|a| a.org_id == org)
        .count()
        >= 8
    {
        return Err("Remove an unused folder before authorizing more than 8 folders.".into());
    }
    stop_inspection(w, &org)?;
    let access = WorkspaceAccess {
        id: id(),
        org_id: org,
        path: path.to_string_lossy().into_owned(),
    };
    let result = json!({"id":access.id});
    w.secretary_workspaces.push(access);
    Ok(result)
}

fn stop_inspection(w: &mut World, org: &str) -> Result<()> {
    let drafts: Vec<_> = w
        .secretary_drafts
        .iter()
        .filter(|d| d.org_id == org && matches!(d.status.as_str(), "queued" | "generating"))
        .map(|d| d.id.clone())
        .collect();
    for draft in drafts {
        secretary::cancel(w, &json!({"draftId":draft}))?;
    }
    for draft in w
        .secretary_drafts
        .iter_mut()
        .filter(|d| d.org_id == org && d.status == "ready")
    {
        draft.status = "stale".into();
        draft.error = Some("Folder access changed. Send a message to prepare a fresh blueprint with the current permissions.".into());
    }
    Ok(())
}

pub fn revoke(w: &mut World, args: &Value) -> Result<Value> {
    let org = text(args, "orgId", 80)?;
    let access_id = text(args, "workspaceId", 80)?;
    if !w
        .secretary_workspaces
        .iter()
        .any(|a| a.id == access_id && a.org_id == org)
    {
        return Err("Authorized folder not found in this organization.".into());
    }
    stop_inspection(w, &org)?;
    w.secretary_workspaces.retain(|a| a.id != access_id);
    Ok(json!({"id":access_id}))
}

pub fn inspect(w: &World, org: &str, action: &Value) -> Result<Value> {
    let access = w.secretary_workspaces.iter()
        .find(|a| a.org_id == org && action["workspaceId"] == a.id)
        .ok_or("Choose a currently authorized folder from authorizedFolders; ask the founder to allow folder access if none is listed.")?;
    if !matches!(action["action"].as_str(), Some("list_files" | "read_file")) {
        return Err("Secretary folder access is read-only. Writing files and running commands are not available.".into());
    }
    // Recheck the boundary for each read, not only when permission was granted.
    let current = root(&access.path)?;
    if current != Path::new(&access.path) {
        return Err(
            "The authorized folder changed. Remove it and authorize its new location.".into(),
        );
    }
    if w.projects.iter().any(|p| {
        p.org_id != org && !p.workspace_path.is_empty() && overlaps(&current, &p.workspace_path)
    }) {
        return Err("This folder now overlaps another organization.".into());
    }
    runtime::read_file_action(&access.path, action)
}

pub fn can_propose(w: &World, org: &str, path: &str) -> bool {
    w.secretary_workspaces
        .iter()
        .any(|a| a.org_id == org && a.path == path)
}
