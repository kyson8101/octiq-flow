use super::*;
use crate::paths::Canonical;
use crate::test_dir::TestDir;

struct Repo {
    _home: TestDir,
    root: String,
    work: String,
}
impl Repo {
    fn new() -> Self {
        let home = TestDir::new("lifespan");
        let canonical = home.canonical().unwrap();
        let root = canonical.join("repo");
        crate::profile::make_dir(&root).unwrap();
        let root = root.to_string_lossy().into_owned();
        git::text(&root, &["init", "-b", "develop"]).unwrap();
        git::text(&root, &["config", "user.name", "Test"]).unwrap();
        git::text(&root, &["config", "user.email", "test@example.invalid"]).unwrap();
        fs::write(Path::new(&root).join("tracked"), "original\n").unwrap();
        fs::write(
            Path::new(&root).join(".gitignore"),
            "target/\nnode_modules/\nsource/\ndist/\nout/\nrenders/\n",
        )
        .unwrap();
        git::text(&root, &["add", "."]).unwrap();
        git::text(&root, &["commit", "-m", "base"]).unwrap();
        let work = canonical.join(".worktrees/repo/octiq/test");
        crate::profile::make_dir(work.parent().unwrap()).unwrap();
        let work = work.to_string_lossy().into_owned();
        git::text(&root, &["worktree", "add", "-b", "octiq/test", &work]).unwrap();
        let work = crate::paths::canonicalize(&work)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        Self {
            _home: home,
            root,
            work,
        }
    }
    fn checkout(&self) -> Checkout {
        checkouts(&self.root)
            .unwrap()
            .into_iter()
            .find(|c| c.path == self.work)
            .unwrap()
    }
    fn allocation(&self) -> Allocation {
        Allocation {
            path: self.work.clone(),
            repo: self.root.clone(),
            branch: Some("octiq/test".into()),
            base: "develop".into(),
            last_activity: 0,
            active: None,
            chats: vec![],
            owner: Owner {
                kind: "task".into(),
                label: "test".into(),
                run_id: None,
                task_id: None,
                chat_key: None,
            },
            swept_at: None,
            reconcilable: true,
        }
    }
    fn observe(&self, at: i64, usage: &Usage) -> Observation {
        observe(
            &self.allocation(),
            &self.checkout(),
            &Settings::default(),
            &BTreeSet::new(),
            usage,
            &crate::agent_chat::ChatManager::default(),
            at,
            false,
        )
        .unwrap()
    }
    fn write(&self, path: &str, data: &str) {
        let p = Path::new(&self.work).join(path);
        crate::profile::make_dir(p.parent().unwrap()).unwrap();
        fs::write(p, data).unwrap();
    }
}
fn known() -> Usage {
    Usage {
        known: true,
        paths: vec![],
    }
}
fn old() -> i64 {
    now() + 30 * DAY
}
fn eligible() -> Decision<'static> {
    Decision {
        active: None,
        idle_ms: 14 * DAY,
        dirty: false,
        operation: false,
        named: true,
        held: true,
        validation: false,
        known: true,
        windows: false,
        reparse: false,
        managed: true,
        complete: true,
    }
}
#[test]
fn default_contract_and_no_derived_facts_on_disk() {
    let saved = serde_json::to_value(Saved::default()).unwrap();
    assert_eq!(
        saved["settings"],
        json!({"enabled":true,"buildAfterDays":3,"removeAfterDays":14})
    );
    assert!(saved.get("items").is_none());
}
#[test]
fn pure_decision_covers_every_hold() {
    let s = Settings::default();
    assert_eq!(decide(eligible(), &s).0, "finished");
    for reason in [
        "A process is using it.",
        "A lease holds it.",
        "An unsettled attempt holds it.",
        "An open gate holds it.",
        "A queued turn holds it.",
        "An unfinished task needs it.",
    ] {
        let mut d = eligible();
        d.active = Some(reason);
        assert_eq!(decide(d, &s), ("active", reason.into()));
    }
    let mut d = eligible();
    d.idle_ms = 14 * DAY - 1;
    assert_eq!(decide(d, &s).0, "idle");
    for change in 0..3 {
        let mut d = eligible();
        match change {
            0 => d.dirty = true,
            1 => d.operation = true,
            _ => {
                d.named = false;
                d.held = false
            }
        }
        assert_eq!(decide(d, &s).0, "abandoned");
    }
    for (case, word) in [
        (0, "unknown"),
        (1, "unknown"),
        (2, "reparse"),
        (3, "inspected"),
        (4, "named"),
        (5, "kept branch"),
        (6, "Ownership"),
    ] {
        let mut d = eligible();
        match case {
            0 => d.known = false,
            1 => d.windows = true,
            2 => {
                d.reparse = true;
                d.windows = true;
            }
            3 => d.complete = false,
            4 => d.named = false,
            5 => d.held = false,
            _ => d.managed = false,
        }
        let (_, why) = decide(d, &s);
        assert!(why.contains(word), "{case}: {why}");
    }
}
#[test]
fn real_git_clean_dirty_untracked_operation_detached_and_kept_branch() {
    let r = Repo::new();
    let o = r.observe(old(), &known());
    assert_eq!(o.item.state, "finished");
    assert!(o.removable);
    assert_eq!(o.item.unmerged_commits, Some(0));
    assert_eq!(o.item.pushed, None);
    r.write("tracked", "changed");
    r.write("new", "new");
    let o = r.observe(old(), &known());
    assert_eq!(o.item.state, "abandoned");
    assert_eq!((o.item.dirty_files, o.item.untracked_files), (1, 1));
    assert!(!o.removable);
    git::text(&r.work, &["add", "."]).unwrap();
    git::text(&r.work, &["commit", "-m", "new work"]).unwrap();
    let o = r.observe(old(), &known());
    assert_eq!(o.item.unmerged_commits, Some(1));
    assert!(
        o.removable,
        "a kept branch is enough; no push or merge is required"
    );
    let marker = git::text(
        &r.work,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "CHERRY_PICK_HEAD",
        ],
    )
    .unwrap();
    fs::write(&marker, &o.item.head).unwrap();
    assert_eq!(r.observe(old(), &known()).item.state, "abandoned");
    fs::remove_file(marker).unwrap();
    git::text(&r.work, &["checkout", "--detach"]).unwrap();
    let mut a = r.allocation();
    a.branch = None;
    a.owner.kind = "validation".into();
    let c = r.checkout();
    let o = observe(
        &a,
        &c,
        &Settings::default(),
        &BTreeSet::new(),
        &known(),
        &crate::agent_chat::ChatManager::default(),
        old(),
        false,
    )
    .unwrap();
    assert!(o.removable);
    git::text(&r.work, &["commit", "--allow-empty", "-m", "unreferenced"]).unwrap();
    let c = r.checkout();
    let o = observe(
        &a,
        &c,
        &Settings::default(),
        &BTreeSet::new(),
        &known(),
        &crate::agent_chat::ChatManager::default(),
        old(),
        false,
    )
    .unwrap();
    assert_eq!(o.item.state, "abandoned");
}
#[test]
fn process_unknown_windows_pins_and_owner_refuse_removal() {
    let r = Repo::new();
    let manager = crate::agent_chat::ChatManager::default();
    let mut pins = BTreeSet::new();
    pins.insert(key(&r.root, &r.work));
    let o = observe(
        &r.allocation(),
        &r.checkout(),
        &Settings::default(),
        &pins,
        &known(),
        &manager,
        old(),
        false,
    )
    .unwrap();
    assert!(o.item.pinned);
    assert!(o.item.remove_at.is_none());
    for (usage, windows) in [(Usage::default(), false), (known(), true)] {
        let o = observe(
            &r.allocation(),
            &r.checkout(),
            &Settings::default(),
            &BTreeSet::new(),
            &usage,
            &manager,
            old(),
            windows,
        )
        .unwrap();
        assert!(!o.removable);
        assert!(o.item.remove_at.is_none());
    }
    let usage = Usage {
        known: true,
        paths: vec![Path::new(&r.work).join("tracked")],
    };
    assert_eq!(r.observe(old(), &usage).item.state, "active");
    let primary = checkouts(&r.root).unwrap().remove(0);
    let a = allocation_for(&primary, &r.root, &[r.allocation()]);
    assert_eq!(a.owner.kind, "unknown");
    let o = observe(
        &a,
        &primary,
        &Settings::default(),
        &BTreeSet::new(),
        &known(),
        &manager,
        old(),
        false,
    )
    .unwrap();
    assert!(!o.removable);
}
#[test]
fn strip_allowlist_never_includes_ignored_source_or_arbitrary_outputs() {
    let r = Repo::new();
    for name in [
        "source",
        "dist",
        "out",
        "renders",
        "target",
        "node_modules",
        "nested/target",
    ] {
        r.write(&format!("{name}/valuable"), name);
    }
    r.write("Cargo.toml", "[package]");
    r.write("package.json", "{}");
    let mut tree = Tree::default();
    walk(&r.work, Path::new(&r.work), false, &mut tree).unwrap();
    assert_eq!(tree.builds.len(), 2);
    assert!(tree.builds.contains(&Path::new(&r.work).join("target")));
    assert!(tree
        .builds
        .contains(&Path::new(&r.work).join("node_modules")));
    for build in tree.builds {
        fs::remove_dir_all(build).unwrap();
    }
    for name in ["source", "dist", "out", "renders", "nested/target"] {
        assert!(Path::new(&r.work).join(name).join("valuable").exists());
    }
}
#[test]
fn build_manifest_and_git_ignore_and_tracked_file_are_all_required() {
    let r = Repo::new();
    r.write("target/file", "keep");
    assert!(!build_dir(&r.work, &Path::new(&r.work).join("target")));
    r.write("Cargo.toml", "[package]");
    assert!(build_dir(&r.work, &Path::new(&r.work).join("target")));
    git::text(&r.work, &["add", "-f", "target/file"]).unwrap();
    assert!(!build_dir(&r.work, &Path::new(&r.work).join("target")));
}
#[cfg(unix)]
#[test]
fn redirects_never_traverse_and_ancestors_are_checked() {
    let r = Repo::new();
    let external = TestDir::new("lifespan-external");
    fs::write(external.join("valuable"), "stay").unwrap();
    r.write("Cargo.toml", "[package]");
    std::os::unix::fs::symlink(&*external, Path::new(&r.work).join("target")).unwrap();
    assert!(real_dir(&Path::new(&r.work).join("target/child")).is_err());
    let mut tree = Tree::default();
    walk(&r.work, Path::new(&r.work), false, &mut tree).unwrap();
    assert!(tree.reparse);
    assert!(tree.builds.is_empty());
    assert_eq!(
        fs::read_to_string(external.join("valuable")).unwrap(),
        "stay"
    );
}
#[test]
fn status_hash_detects_content_and_index_changes_with_same_porcelain() {
    let r = Repo::new();
    r.write("tracked", "first");
    let a = r.observe(old(), &known());
    r.write("tracked", "second");
    let b = r.observe(old(), &known());
    assert_ne!(a.item.status_hash, b.item.status_hash);
    r.write("new", "one");
    let a = r.observe(old(), &known());
    r.write("new", "two");
    assert_ne!(
        a.item.status_hash,
        r.observe(old(), &known()).item.status_hash
    );
    git::text(&r.work, &["add", "tracked"]).unwrap();
    r.write("tracked", "working");
    let a = r.observe(old(), &known());
    r.write("tracked", "third staged");
    git::text(&r.work, &["add", "tracked"]).unwrap();
    r.write("tracked", "working");
    let b = r.observe(old(), &known());
    assert_ne!(a.item.status_hash, b.item.status_hash);
}
#[test]
fn archive_roundtrip_keeps_index_branch_files_and_skips_ignored() {
    let r = Repo::new();
    r.write("tracked", "staged");
    git::text(&r.work, &["add", "tracked"]).unwrap();
    r.write("tracked", "working");
    r.write("untracked", "new file");
    r.write("source/ignored", "not archived");
    let head = git::text(&r.work, &["rev-parse", "HEAD"]).unwrap();
    let index = git::git(&r.work, &["ls-files", "--stage", "-z"]).unwrap();
    let reference = "refs/octiq/archive/test-roundtrip";
    let tmp = r._home.join("temporary-index");
    let (tree, files) = git::archive(&r.work, &head, reference, &tmp).unwrap();
    assert_eq!(files, 3);
    assert_eq!(git::text(&r.work, &["rev-parse", "HEAD"]).unwrap(), head);
    assert_eq!(
        git::git(&r.work, &["ls-files", "--stage", "-z"]).unwrap(),
        index
    );
    assert_eq!(
        git::text(&r.root, &["rev-parse", &format!("{reference}^{{tree}}")]).unwrap(),
        tree
    );
    assert!(git::remove(&r.root, &r.work, false).is_err());
    git::remove(&r.root, &r.work, true).unwrap();
    assert!(gone(&r.work));
    assert_eq!(
        git::text(&r.root, &["rev-parse", "refs/heads/octiq/test"]).unwrap(),
        head
    );
    let target = r
        ._home
        .canonical()
        .unwrap()
        .join(".worktrees/repo/octiq/restored-test");
    git::restore(
        &r.root,
        &target.to_string_lossy(),
        "octiq/restored-test",
        reference,
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(target.join("tracked")).unwrap(),
        "working"
    );
    assert_eq!(
        fs::read_to_string(target.join("untracked")).unwrap(),
        "new file"
    );
    assert!(!target.join("source").exists());
    assert!(git::restore(
        &r.root,
        &target.to_string_lossy(),
        "octiq/another",
        reference
    )
    .is_err());
}
#[test]
fn failed_archive_and_dirty_removal_leave_folder_intact() {
    let r = Repo::new();
    r.write("dirty", "must stay");
    let head = git::text(&r.work, &["rev-parse", "HEAD"]).unwrap();
    assert!(git::archive(&r.work, &head, "refs/not valid", &r._home.join("index")).is_err());
    assert!(Path::new(&r.work).join("dirty").exists());
    assert!(git::remove(&r.root, &r.work, false).is_err());
}
#[test]
fn missing_profile_refuses_widening_but_pinning_and_off_are_owed() {
    let h = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&h.dir);
    crate::profile::available().unwrap();
    let store = Store::default();
    store.saved().unwrap();
    h.move_away();
    assert!(store
        .change(false, |s| {
            s.settings.build_after_days = 1;
            Ok(())
        })
        .is_err());
    store
        .change(true, |s| {
            s.settings.enabled = false;
            s.pins.insert("keep".into());
            Ok(())
        })
        .unwrap();
    assert!(!store.allowed("anything").unwrap());
    assert!(store.saved().unwrap().pins.contains("keep"));
    assert!(!h.profile().exists());
    assert!(store.inner.lock().unwrap().owed);
    let late = Store::default();
    late.change(true, |s| {
        s.settings.enabled = false;
        s.pins.insert("late".into());
        Ok(())
    })
    .unwrap();
    assert!(!h.profile().exists());
    h.move_back();
    let saved = late.saved().unwrap();
    assert!(!saved.settings.enabled);
    assert!(saved.pins.contains("late"));
    assert!(saved.archives.is_empty());
}
#[test]
fn missing_volume_does_not_qualify_as_removed_checkout() {
    let r = Repo::new();
    assert!(parents_present(&r.root, &r.work, false));
    let moved = r._home.join("repo-away");
    fs::rename(&r.root, &moved).unwrap();
    assert!(!parents_present(&r.root, &r.work, false));
    fs::rename(moved, &r.root).unwrap();
    let parent = r._home.join(".worktrees/repo");
    fs::rename(&parent, r._home.join("worktrees-away")).unwrap();
    assert!(!parents_present(&r.root, &r.work, false));
}
#[test]
fn interrupted_intent_is_durable_and_never_authorizes_blind_replay() {
    let h = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&h.dir);
    crate::profile::available().unwrap();
    let r = Repo::new();
    let store = Store::default();
    let item = r.observe(old(), &known()).item;
    record_intent(&store, &item, None, now()).unwrap();
    let restarted = Store::default();
    assert_eq!(restarted.saved().unwrap().intents.len(), 1);
    assert!(!gone(&r.work));
    git::remove(&r.root, &r.work, false).unwrap();
    assert!(gone(&r.work));
    assert!(parents_present(&r.root, &r.work, false));
    assert_eq!(restarted.saved().unwrap().intents[0].repo, r.root);
}
#[test]
fn only_socket_dispatch_exposes_lifespan() {
    let dispatch = include_str!("../dispatch.rs");
    let hook = include_str!("../web.rs");
    let mcp = include_str!("../../../scripts/mcp/octiq-ask.cjs");
    for cmd in [
        "worktree_lifespan_list",
        "worktree_lifespan_set",
        "worktree_lifespan_keep",
        "worktree_lifespan_archive",
        "worktree_lifespan_restore",
    ] {
        assert!(dispatch.contains(&format!("\"{cmd}\" =>")));
        assert!(!hook.contains(cmd));
        assert!(!mcp.contains(cmd));
    }
}

impl Repo {
    fn age(&self, days: i64) {
        let mut cmd = Command::new("git");
        cmd.args([
            "-C",
            &self.work,
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--amend",
            "--no-edit",
        ])
        .env("GIT_COMMITTER_DATE", "2001-01-01T00:00:00+0000");
        git::command(&mut cmd, Duration::from_secs(15)).unwrap();
        let modified = UNIX_EPOCH + Duration::from_millis((now() - days * DAY) as u64);
        fn age_dir(dir: &Path, modified: SystemTime) {
            for entry in fs::read_dir(dir).unwrap() {
                let e = entry.unwrap();
                if e.file_name() == ".git" {
                    continue;
                }
                let m = fs::symlink_metadata(e.path()).unwrap();
                if redirect(&m) {
                    continue;
                }
                if m.is_dir() {
                    age_dir(&e.path(), modified)
                } else {
                    fs::OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(e.path())
                        .unwrap()
                        .set_times(fs::FileTimes::new().set_modified(modified))
                        .unwrap();
                }
            }
            directory_handle(dir)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(modified))
                .unwrap();
        }
        age_dir(Path::new(&self.work), modified);
    }
    fn services(&self, days: i64) -> Services {
        let svc = Services::load();
        let project = crate::workspaces::add_workspace_impl(
            &svc.workspaces,
            "Lifespan test".into(),
            self.root.clone(),
        )
        .unwrap();
        crate::chat_index::upsert(serde_json::from_value(json!({"id":"lifespan-chat","projectId":project.id,"title":"test worktree","cwd":self.work,"updatedAt":now()-days*DAY,"createdAt":now()-days*DAY})).unwrap()).unwrap();
        svc
    }
}
fn checks() -> Checks {
    Checks {
        windows: false,
        usage: known,
        building: || false,
    }
}
#[test]
fn actual_sweep_strips_only_builds_then_removes_and_chat_recovers_same_path() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let r = Repo::new();
    r.write("Cargo.toml", "[package]\nname='test'\n");
    git::text(&r.work, &["add", "Cargo.toml"]).unwrap();
    git::text(&r.work, &["commit", "-m", "manifest"]).unwrap();
    r.write("target/cache", "generated");
    r.write("source/precious", "preserve on strip");
    r.write("dist/output", "preserve on strip");
    r.age(4);
    let svc = r.services(4);
    let store = Store::default();
    sweep_checked(&svc, &store, &checks()).unwrap();
    assert!(!Path::new(&r.work).join("target").exists());
    assert!(Path::new(&r.work).join("source/precious").exists());
    assert!(Path::new(&r.work).join("dist/output").exists());
    assert_eq!(store.saved().unwrap().history[0].stripped, 1);
    assert!(store.saved().unwrap().history[0].removed.is_empty());
    assert_eq!(
        store
            .inner
            .lock()
            .unwrap()
            .items
            .iter()
            .find(|i| i.path == r.work)
            .unwrap()
            .build_bytes,
        Some(0)
    );
    r.age(15);
    let mut meta = crate::chat_index::find("lifespan-chat").unwrap().unwrap();
    meta.updated_at = now() - 15 * DAY;
    crate::chat_index::upsert(meta).unwrap();
    let head = git::text(&r.work, &["rev-parse", "HEAD"]).unwrap();
    sweep_checked(&svc, &store, &checks()).unwrap();
    let report = &store.saved().unwrap().history[0];
    assert_eq!(
        report.removed.len(),
        1,
        "{:?}",
        serde_json::to_value(report).unwrap()
    );
    assert!(gone(&r.work));
    assert_eq!(
        crate::chat_task::remembered("lifespan-chat")
            .1
            .unwrap()
            .head,
        head
    );
    let held = crate::chat_recover::recover(
        &svc.chats,
        &svc.workspaces,
        "chat:lifespan-chat",
        &r.work,
        None,
    )
    .unwrap()
    .unwrap();
    assert_eq!(held.recovery.kind, crate::chat_recover::Kind::Rebuilt);
    assert_eq!(held.recovery.cwd, r.work);
    assert_eq!(held.recovery.head, head);
}
#[test]
fn actual_sweep_pins_busy_compiler_disabled_and_abandoned_all_keep_folder() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let r = Repo::new();
    r.age(15);
    let svc = r.services(15);
    let store = Store::default();
    store
        .change(false, |s| {
            s.pins.insert(key(&r.root, &r.work));
            Ok(())
        })
        .unwrap();
    sweep_checked(&svc, &store, &checks()).unwrap();
    assert!(Path::new(&r.work).exists());
    store
        .change(false, |s| {
            s.pins.clear();
            Ok(())
        })
        .unwrap();
    let busy = Checks {
        windows: false,
        usage: known,
        building: || true,
    };
    sweep_checked(&svc, &store, &busy).unwrap();
    assert!(Path::new(&r.work).exists());
    store
        .change(true, |s| {
            s.settings.enabled = false;
            Ok(())
        })
        .unwrap();
    sweep_checked(&svc, &store, &checks()).unwrap();
    assert!(Path::new(&r.work).exists());
    store
        .change(false, |s| {
            s.settings.enabled = true;
            Ok(())
        })
        .unwrap();
    r.write("dirty", "keep me");
    r.age(15);
    sweep_checked(&svc, &store, &checks()).unwrap();
    assert!(Path::new(&r.work).join("dirty").exists());
    assert_eq!(
        store
            .inner
            .lock()
            .unwrap()
            .items
            .iter()
            .find(|i| i.path == r.work)
            .unwrap()
            .state,
        "abandoned"
    );
    home.move_away();
    assert!(sweep_checked(&svc, &store, &checks()).is_err());
    assert!(!home.profile().exists());
    assert!(Path::new(&r.work).exists());
    home.move_back();
}
#[test]
fn actual_restart_reconciles_only_after_folder_disappeared_and_volume_returns() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let r = Repo::new();
    let svc = r.services(15);
    let first = Store::default();
    let item = r.observe(old(), &known()).item;
    record_intent(&first, &item, None, now()).unwrap();
    let restarted = Store::default();
    let mut report = Sweep::default();
    reconcile(&svc, &restarted, now(), &mut report).unwrap();
    assert!(report.removed.is_empty());
    assert_eq!(restarted.saved().unwrap().intents.len(), 1);
    git::remove(&r.root, &r.work, false).unwrap();
    let moved = r._home.join("volume-away");
    fs::rename(&r.root, &moved).unwrap();
    reconcile(&svc, &restarted, now(), &mut report).unwrap();
    assert!(report.removed.is_empty());
    assert_eq!(restarted.saved().unwrap().intents.len(), 1);
    fs::rename(moved, &r.root).unwrap();
    reconcile(&svc, &restarted, now(), &mut report).unwrap();
    assert_eq!(report.removed.len(), 1);
    assert_eq!(
        restarted.saved().unwrap().intents.len(),
        1,
        "intent survives until outcome is saved"
    );
    let after_crash = Store::default();
    assert_eq!(after_crash.saved().unwrap().intents.len(), 1);
    after_crash
        .change(false, |s| {
            s.intents
                .retain(|i| !report.removed.iter().any(|r| r.path == i.item.path));
            history(s, report.clone());
            Ok(())
        })
        .unwrap();
    assert!(after_crash.saved().unwrap().intents.is_empty());
    assert!(git::text(&r.root, &["rev-parse", "refs/heads/octiq/test"]).is_ok());
}

#[test]
fn archive_api_rejects_stale_preview_and_roundtrips_its_record_and_new_branch() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let r = Repo::new();
    r.write("tracked", "uncommitted");
    r.write("new", "new content");
    r.age(15);
    let svc = r.services(15);
    let state = Store::default();
    let preview = r.observe(now(), &known()).item;
    state.inner.lock().unwrap().items = vec![preview.clone()];
    let error = archive_checked(
        &svc,
        &state,
        &checks(),
        &preview.key,
        "stale head",
        &preview.status_hash,
    )
    .unwrap_err();
    assert!(error.contains("HEAD changed"));
    assert!(Path::new(&r.work).exists());
    let error = archive_checked(
        &svc,
        &state,
        &checks(),
        &preview.key,
        &preview.head,
        "stale status",
    )
    .unwrap_err();
    assert!(error.contains("staging changed"));
    assert!(Path::new(&r.work).exists());
    state
        .change(true, |s| {
            s.pins.insert(preview.key.clone());
            Ok(())
        })
        .unwrap();
    assert!(archive_checked(
        &svc,
        &state,
        &checks(),
        &preview.key,
        &preview.head,
        &preview.status_hash
    )
    .unwrap_err()
    .contains("pinned"));
    state
        .change(false, |s| {
            s.pins.clear();
            Ok(())
        })
        .unwrap();
    let a = archive_checked(
        &svc,
        &state,
        &checks(),
        &preview.key,
        &preview.head,
        &preview.status_hash,
    )
    .unwrap();
    assert!(gone(&r.work));
    assert_eq!(state.saved().unwrap().archives.len(), 1);
    assert!(state.saved().unwrap().intents.is_empty());
    let result = restore_from(&svc, &state, &a.key).unwrap();
    let path = result["path"].as_str().unwrap();
    assert_eq!(
        fs::read_to_string(Path::new(path).join("tracked")).unwrap(),
        "uncommitted"
    );
    assert_eq!(
        fs::read_to_string(Path::new(path).join("new")).unwrap(),
        "new content"
    );
    assert_eq!(result["branch"], format!("octiq/restored-{}", a.key));
    assert!(state.saved().unwrap().archives[0].restored_at.is_some());
    assert!(git::text(&r.root, &["rev-parse", &a.reference]).is_ok());
}

#[test]
fn agent_history_and_profile_ancestors_are_out_of_scope() {
    let home = Path::new("/person");
    let profile = Path::new("/profile/active");
    for path in [
        "/person/.codex/.worktrees/repo/octiq/one",
        "/person/.claude/projects/worktree-session",
        "/person/.gemini/tmp/one",
        "/profile",
        "/profile/active",
    ] {
        assert!(protected(Path::new(path), profile, Some(home)));
    }
    assert!(!protected(
        Path::new("/profile/active/worktrees/one"),
        profile,
        Some(home)
    ));
    assert!(!protected(
        Path::new("/person/code/.worktrees/repo/octiq/one"),
        profile,
        Some(home)
    ));
}
