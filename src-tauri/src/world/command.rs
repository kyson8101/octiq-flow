//! Commands run against a filtered snapshot in a networkless, credential-free container.
use super::{model::*, process, read, runtime::project_path, update};
use serde_json::{json, Value};
use std::{fs, path::Path, time::Duration};

pub fn image_name(name: &str) -> Result<String> {
    if name.is_empty()
        || name.len() > 200
        || name.starts_with('-')
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-:@".contains(&b))
    {
        return Err("Use a valid preinstalled container image name.".into());
    }
    Ok(name.into())
}
pub fn copy_project(root: &str, dest: &Path) -> Result<()> {
    fn walk(
        root: &str,
        relative: &Path,
        dest: &Path,
        count: &mut u64,
        bytes: &mut u64,
    ) -> Result<()> {
        let source = project_path(root, &relative.to_string_lossy(), false)?;
        for entry in fs::read_dir(source)
            .map_err(|_| "Could not snapshot project folder.")?
            .flatten()
        {
            let rel = relative.join(entry.file_name());
            if [".agents", ".codex", ".claude", ".cache", "dist"]
                .contains(&entry.file_name().to_string_lossy().as_ref())
            {
                continue;
            }
            let Ok(path) = project_path(root, &rel.to_string_lossy(), false) else {
                continue;
            };
            let meta =
                fs::symlink_metadata(&path).map_err(|_| "Project changed during snapshot.")?;
            if meta.is_dir() {
                fs::create_dir_all(dest.join(&rel))
                    .map_err(|_| "Could not create snapshot directory.")?;
                walk(root, &rel, dest, count, bytes)?;
            } else if meta.is_file() {
                *count += 1;
                *bytes += meta.len();
                if *count > 10000 || *bytes > 100_000_000 {
                    return Err("Project snapshot exceeds 10,000 files or 100 MB. Use a focused project folder.".into());
                }
                fs::copy(path, dest.join(rel)).map_err(|_| "Could not snapshot project file.")?;
            }
        }
        Ok(())
    }
    walk(root, Path::new("."), dest, &mut 0, &mut 0)
}
pub fn validate(w: &World, run: &Run, value: &Value) -> Result<(Project, String)> {
    if !w.active(run) || run.kind != "task" {
        return Err("Only an active execution task can run commands.".into());
    }
    let a = w.agent(&run.agent_id)?;
    if a.kind != "worker"
        || w.professions
            .iter()
            .find(|p| p.id == a.profession_id)
            .is_none_or(|p| p.kind == "pm")
    {
        return Err("This member cannot execute commands.".into());
    }
    let command = value["command"]
        .as_str()
        .filter(|c| !c.trim().is_empty() && c.len() <= 8000)
        .ok_or("A command of at most 8,000 characters is required.")?;
    let project = w.project(&run.project_id)?.clone();
    image_name(&project.runner_image)?;
    Ok((project, command.into()))
}
pub fn run(run: &Run, value: &Value) -> Result<Value> {
    let (project, script) = validate(&read()?, run, value)?;
    let docker = process::binary("docker").ok_or("Docker is required for isolated commands.")?;
    let dir = process::empty_workspace()?;
    let _cleanup = process::Cleanup(dir.clone());
    copy_project(&project.workspace_path, &dir)?;
    let archive = std::process::Command::new("/usr/bin/tar")
        .args(["-cf", "-", "-C"])
        .arg(&dir)
        .arg(".")
        .env("COPYFILE_DISABLE", "1")
        .output()
        .map_err(|_| "Could not package project snapshot.")?;
    if !archive.status.success() {
        return Err("Could not package project snapshot.".into());
    }
    let name = format!("octiqos-command-{}", id());
    let mut cmd = process::command(&docker, &dir);
    cmd.args([
        "run",
        "--rm",
        "-i",
        "--pull=never",
        "--name",
        &name,
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=128",
        "--memory=1g",
        "--cpus=2",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=128m",
        "--tmpfs",
        "/workspace:rw,nosuid,nodev,size=256m",
        "--workdir",
        "/workspace",
        "--env",
        "HOME=/tmp",
        "--entrypoint",
        "/bin/sh",
        &project.runner_image,
        "-c",
        "tar -xf - && exec /bin/sh -c \"$1\"",
        "octiqos-command",
        &script,
    ]);
    update(|w| {
        if !w.active(run) {
            return Err("Task was interrupted before the command started.".into());
        }
        w.tasks
            .iter_mut()
            .find(|t| t.id == run.target_id)
            .ok_or("Task not found.")?
            .messages
            .push(Message::new(
                "system",
                &format!("Starting command (run {}): {}", run.id, script),
            ));
        Ok(())
    })?;
    let output = process::run(cmd, archive.stdout, Duration::from_secs(120), || {
        if read().is_ok_and(|w| w.active(run)) {
            true
        } else {
            stop_container(&docker, &name);
            false
        }
    });
    // Also stop a container after a local timeout/client exit. Only our unique name is targeted.
    stop_container(&docker, &name);
    let output = output?;
    let result = json!({"command":script,"exitCode":output.code,"interrupted":output.interrupted,"stdout":output.stdout.chars().take(24000).collect::<String>(),"stderr":output.stderr.chars().take(8000).collect::<String>(),"workspace":"Isolated project snapshot; command file changes are not applied to the host."});
    update(|w| {
        // Preserve actual evidence even when interrupted; never advance an obsolete generation.
        if let Some(t) = w.tasks.iter_mut().find(|t| t.id == run.target_id) {
            t.messages.push(Message::new(
                "system",
                &format!("Command result (run {}): {}", run.id, result),
            ));
        }
        Ok(())
    })?;
    Ok(result)
}

fn stop_container(docker: &Path, name: &str) {
    let mut cmd = std::process::Command::new(docker);
    cmd.args(["kill", name]);
    let _ = process::run(cmd, String::new(), Duration::from_secs(10), || true);
}
