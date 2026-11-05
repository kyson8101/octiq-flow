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
        // Control raw checkout bytes across system/global Git defaults. The
        // dedicated autocrlf acceptance test explicitly turns conversion on.
        git::text(&root, &["config", "core.autocrlf", "false"]).unwrap();
        git::text(&root, &["config", "core.eol", "lf"]).unwrap();
        fs::write(Path::new(&root).join("tracked"), "original\n").unwrap();
        fs::write(
            Path::new(&root).join(".gitignore"),
            "target/\nnode_modules/\nsource/\nworks/\nanime/\ndist/\n.astro/\n*.tsbuildinfo\npnpm-workspace.yaml\n.DS_Store\n*.log\nout/\nrenders/\n",
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
    fn recheckout(&self) {
        let names = git::git(&self.work, &["ls-files", "-z"]).unwrap();
        for name in names.split(|b| *b == 0).filter(|b| !b.is_empty()) {
            fs::remove_file(Path::new(&self.work).join(std::str::from_utf8(name).unwrap()))
                .unwrap();
        }
        git::text(&self.work, &["checkout-index", "-a"]).unwrap();
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
            ignored::inventory,
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
        ignored::inventory,
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
        ignored::inventory,
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
        ignored::inventory,
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
            ignored::inventory,
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
        ignored::inventory,
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
    // A trailing-slash ignore rule matches directories, not symlinks.
    r.write(".gitignore", "target\n");
    std::os::unix::fs::symlink(&*external, Path::new(&r.work).join("target")).unwrap();
    assert!(real_dir(&Path::new(&r.work).join("target/child")).is_err());
    let mut tree = Tree::default();
    walk(&r.work, Path::new(&r.work), false, &mut tree).unwrap();
    assert!(tree.reparse);
    assert!(tree.builds.is_empty());
    let ignored = ignored::inventory(&r.work).unwrap();
    assert_eq!(ignored.files, 1, "the link is counted, never its target");
    assert_eq!(
        ignored.bytes,
        fs::symlink_metadata(Path::new(&r.work).join("target"))
            .unwrap()
            .len()
    );
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
        inventory: ignored::inventory,
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
    // The first pass must not authorize dropping ignored originals later.
    fs::remove_dir_all(Path::new(&r.work).join("source")).unwrap();
    fs::remove_dir_all(Path::new(&r.work).join("dist")).unwrap();
    r.age(15);
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
        inventory: ignored::inventory,
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

#[test]
fn archive_refuses_embedded_gitlinks_instead_of_losing_their_working_files() {
    let r = Repo::new();
    let nested = Path::new(&r.work).join("embedded");
    crate::profile::make_dir(&nested).unwrap();
    let nested = nested.to_string_lossy().into_owned();
    git::text(&nested, &["init", "-b", "main"]).unwrap();
    git::text(&nested, &["config", "user.name", "Test"]).unwrap();
    git::text(&nested, &["config", "user.email", "test@example.invalid"]).unwrap();
    fs::write(Path::new(&nested).join("file"), "original").unwrap();
    git::text(&nested, &["add", "."]).unwrap();
    git::text(&nested, &["commit", "-m", "nested"]).unwrap();
    fs::write(Path::new(&nested).join("file"), "uncommitted valuable work").unwrap();
    let head = git::text(&r.work, &["rev-parse", "HEAD"]).unwrap();
    let index = git::git(&r.work, &["ls-files", "--stage", "-z"]).unwrap();
    let error = git::archive(
        &r.work,
        &head,
        "refs/octiq/archive/unsafe-gitlink",
        &r._home.join("index"),
    )
    .unwrap_err();
    assert!(error.contains("embedded repositories"));
    assert_eq!(
        fs::read_to_string(Path::new(&nested).join("file")).unwrap(),
        "uncommitted valuable work"
    );
    assert_eq!(
        git::git(&r.work, &["ls-files", "--stage", "-z"]).unwrap(),
        index
    );
    assert!(git::text(
        &r.root,
        &["rev-parse", "--verify", "refs/octiq/archive/unsafe-gitlink"]
    )
    .is_err());
}

#[test]
fn ignored_originals_override_every_rebuildable_name_and_survive_sweep() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("works/ep1/final.mp4", "only copy");
    r.write("works/ep1/package.json", "{}");
    r.write("works/ep1/dist/final.log", "render");
    r.write("anime/source/.DS_Store", "original");
    r.write("source/target/cache", "original cache name");
    assert!(
        git::git(&r.work, &["status", "--porcelain", "--untracked-files=all"])
            .unwrap()
            .is_empty()
    );
    r.age(15);
    let svc = r.services(15);
    let store = Store::default();
    sweep_checked(&svc, &store, &checks()).unwrap();
    let items = &store.inner.lock().unwrap().items;
    let item = items.iter().find(|i| i.path == r.work).unwrap();
    assert_eq!(item.state, "abandoned");
    assert_eq!(item.ignored_files, Some(5));
    assert_eq!(item.ignored_bytes, Some(9 + 2 + 6 + 8 + 19));
    assert!(item.why.contains("5 at-stake ignored files"));
    assert!(item.remove_at.is_none());
    assert_eq!(
        fs::read_to_string(Path::new(&r.work).join("works/ep1/final.mp4")).unwrap(),
        "only copy"
    );
}

#[test]
fn allowlisted_ignored_outputs_stay_finished_and_are_removed() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("Cargo.toml", "[package]");
    r.write("web/package.json", "{}");
    git::text(&r.work, &["add", "Cargo.toml", "web/package.json"]).unwrap();
    git::text(&r.work, &["commit", "-m", "manifests"]).unwrap();
    for path in [
        "target/cache",
        "web/node_modules/cache",
        "web/dist/index.html",
        "web/.astro/cache",
        "web/tsconfig.tsbuildinfo",
        "web/pnpm-workspace.yaml",
        ".DS_Store",
        "build.log",
    ] {
        r.write(
            path,
            if path.ends_with("pnpm-workspace.yaml") {
                "allowBuilds:\n  esbuild: true\n"
            } else {
                "rebuildable"
            },
        );
    }
    r.age(15);
    let o = r.observe(now(), &known());
    assert_eq!(o.item.state, "finished");
    assert_eq!(
        (o.item.ignored_files, o.item.ignored_bytes),
        (Some(0), Some(0))
    );
    assert!(o.removable);
    let svc = r.services(15);
    let store = Store::default();
    sweep_checked(&svc, &store, &checks()).unwrap();
    assert!(gone(&r.work));
}

#[test]
fn generated_names_need_sibling_manifests_and_inventory_has_real_bounds() {
    let r = Repo::new();
    for path in [
        "target/cache",
        "node_modules/cache",
        "dist/output",
        ".astro/cache",
        "tsconfig.tsbuildinfo",
        "pnpm-workspace.yaml",
    ] {
        r.write(path, "precious");
    }
    assert_eq!(ignored::inventory(&r.work).unwrap().files, 6);
    assert!(ignored::bounded(&r.work, Duration::ZERO, 100).is_err());
    assert!(ignored::bounded(&r.work, Duration::from_secs(15), 1).is_err());
}

#[test]
fn failed_ignored_inventory_keeps_folder_and_refuses_archive_in_words() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("source/original", "precious");
    r.age(15);
    let svc = r.services(15);
    let state = Store::default();
    let failed = Checks {
        inventory: |root| ignored::bounded(root, Duration::ZERO, 0),
        ..checks()
    };
    sweep_checked(&svc, &state, &failed).unwrap();
    let preview = state
        .inner
        .lock()
        .unwrap()
        .items
        .iter()
        .find(|i| i.path == r.work)
        .unwrap()
        .clone();
    assert_eq!(preview.state, "abandoned");
    assert_eq!((preview.ignored_files, preview.ignored_bytes), (None, None));
    assert!(preview.why.contains("inventory is unavailable"));
    let error = archive_checked(
        &svc,
        &state,
        &failed,
        &preview.key,
        &preview.head,
        &preview.status_hash,
    )
    .unwrap_err();
    assert!(
        error.contains("Ignored-file inventory is unavailable"),
        "{error}"
    );
    assert!(Path::new(&r.work).join("source/original").exists());
}

#[test]
fn ignored_file_arriving_after_scan_stops_the_final_removal_check() {
    use std::cell::Cell;
    thread_local! {
        static CALLS: Cell<usize> = const { Cell::new(0) };
    }
    fn inventory(root: &str) -> Result<ignored::Inventory, String> {
        let observed = ignored::inventory(root)?;
        CALLS.with(|n| {
            n.set(n.get() + 1);
            if n.get() == 2 {
                let folder = Path::new(root).join("works/ep1");
                crate::profile::make_dir(&folder).unwrap();
                let file = folder.join("late.mp4");
                fs::write(&file, "arrived after scan").unwrap();
                // Keep mtimes old to prove the ignored inventory itself
                // blocks removal, independently of ordinary activity.
                let time = UNIX_EPOCH + Duration::from_millis((now() - 30 * DAY) as u64);
                fs::OpenOptions::new()
                    .write(true)
                    .open(file)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(time))
                    .unwrap();
                for dir in [folder, Path::new(root).join("works"), PathBuf::from(root)] {
                    directory_handle(&dir)
                        .unwrap()
                        .set_times(fs::FileTimes::new().set_modified(time))
                        .unwrap();
                }
            }
        });
        Ok(observed)
    }
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.age(15);
    let svc = r.services(15);
    let state = Store::default();
    let preview = r.observe(now(), &known()).item;
    state.inner.lock().unwrap().items = vec![preview.clone()];
    CALLS.with(|n| n.set(0));
    let error = operate(
        &svc,
        &state,
        &preview,
        now(),
        false,
        &Checks {
            inventory,
            ..checks()
        },
    )
    .err()
    .expect("late ignored file must stop removal");
    assert!(
        error.contains("at-stake ignored files arrived before removal"),
        "{error}"
    );
    let o = r.observe(now(), &known());
    assert_eq!(o.item.state, "abandoned");
    assert_eq!(o.item.ignored_files, Some(1));
    assert!(Path::new(&r.work).join("works/ep1/late.mp4").exists());
}

#[test]
fn ignored_change_invalidates_archive_preview_and_confirmed_archive_excludes_it() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("works/final.mp4", "original");
    r.age(15);
    let svc = r.services(15);
    let state = Store::default();
    let preview = r.observe(now(), &known()).item;
    state.inner.lock().unwrap().items = vec![preview.clone()];
    r.write("works/final.mp4", "changed!");
    let error = archive_checked(
        &svc,
        &state,
        &checks(),
        &preview.key,
        &preview.head,
        &preview.status_hash,
    )
    .unwrap_err();
    assert!(error.contains("staging changed"));
    assert!(Path::new(&r.work).join("works/final.mp4").exists());
    r.age(15);
    let fresh = r.observe(now(), &known()).item;
    assert_ne!(preview.status_hash, fresh.status_hash);
    assert_eq!(fresh.ignored_files, Some(1));
    state.inner.lock().unwrap().items = vec![fresh.clone()];
    let archive = archive_checked(
        &svc,
        &state,
        &checks(),
        &fresh.key,
        &fresh.head,
        &fresh.status_hash,
    )
    .unwrap();
    assert!(gone(&r.work));
    assert!(git::git(
        &r.root,
        &[
            "cat-file",
            "-e",
            &format!("{}:works/final.mp4", archive.reference)
        ]
    )
    .is_err());
}

#[test]
fn detached_validation_obeys_ignored_original_guard() {
    let r = Repo::new();
    git::text(&r.work, &["checkout", "--detach"]).unwrap();
    r.write("works/dist/package.json", "{}");
    r.write("works/dist/final.mp4", "original");
    let mut a = r.allocation();
    a.owner.kind = "validation".into();
    a.branch = None;
    let o = observe(
        &a,
        &r.checkout(),
        &Settings::default(),
        &BTreeSet::new(),
        &known(),
        &crate::agent_chat::ChatManager::default(),
        old(),
        false,
        ignored::inventory,
    )
    .unwrap();
    assert_eq!(o.item.state, "abandoned");
    assert!(!o.removable);
    assert!(require_no_at_stake_ignored(&r.work)
        .unwrap_err()
        .contains("2 at-stake ignored files"));
    assert!(Path::new(&r.work).join("works/dist/final.mp4").exists());
}

#[test]
fn h1_strip_uses_inventory_originals_override_even_under_manifest_target() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("source/Cargo.toml", "[package]");
    r.write("source/target/ONLY-ORIGINAL.bin", "only original");
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    sweep_checked(&svc, &state, &checks()).unwrap();
    assert_eq!(ignored::inventory(&r.work).unwrap().files, 2);
    assert_eq!(
        fs::read_to_string(Path::new(&r.work).join("source/target/ONLY-ORIGINAL.bin")).unwrap(),
        "only original"
    );
    assert_eq!(state.saved().unwrap().history[0].stripped, 0);
}

#[test]
fn h2_nested_git_and_bare_repositories_survive_strip_and_finished_removal() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("package.json", "{}");
    git::text(&r.work, &["add", "package.json"]).unwrap();
    git::text(&r.work, &["commit", "-m", "manifest"]).unwrap();
    r.write("node_modules/local-tool/original", "unpublished");
    let nested = Path::new(&r.work).join("node_modules/local-tool");
    let nested = nested.to_str().unwrap();
    git::text(nested, &["init", "-b", "main"]).unwrap();
    git::text(
        nested,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "add",
            ".",
        ],
    )
    .unwrap();
    git::text(
        nested,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "-m",
            "unpublished",
        ],
    )
    .unwrap();
    let commit = git::text(nested, &["rev-parse", "HEAD"]).unwrap();
    r.write("node_modules/linked/.GiT", "gitdir: elsewhere");
    r.write("node_modules/bare/HEAD", "ref: refs/heads/main");
    crate::profile::make_dir(&Path::new(&r.work).join("node_modules/bare/objects")).unwrap();
    crate::profile::make_dir(&Path::new(&r.work).join("node_modules/bare/refs")).unwrap();
    assert_eq!(ignored::inventory(&r.work).unwrap().files, 3);
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    sweep_checked(&svc, &state, &checks()).unwrap();
    assert_eq!(git::text(nested, &["rev-parse", "HEAD"]).unwrap(), commit);
    assert!(Path::new(&r.work).join("node_modules/linked/.GiT").exists());
    assert!(Path::new(&r.work).join("node_modules/bare/HEAD").exists());
    let report = &state.saved().unwrap().history[0];
    assert_eq!(report.stripped, 0);
    assert!(report.removed.is_empty());
}

#[test]
fn h4_only_pnpm_allowbuilds_placeholder_is_rebuildable() {
    let r = Repo::new();
    r.write("web/package.json", "{}");
    for text in [
        "packages:\n  - packages/*\n",
        "onlyBuiltDependencies:\n  - esbuild\n",
        "# generated\nallowBuilds:\n  esbuild: true\n",
        "allowBuilds:\n   esbuild: true\n",
        "allowBuilds:\n  esbuild: true # comment\n",
        "allowBuilds:\nallowBuilds:\n",
        "allowBuilds:\n  esbuild: maybe\n",
    ] {
        r.write("web/pnpm-workspace.yaml", text);
        assert_eq!(ignored::inventory(&r.work).unwrap().files, 1, "{text}");
    }
    r.write("web/pnpm-workspace.yaml", &"x".repeat(4097));
    assert_eq!(ignored::inventory(&r.work).unwrap().files, 1);
    fs::write(
        Path::new(&r.work).join("web/pnpm-workspace.yaml"),
        [0xff, 0xfe],
    )
    .unwrap();
    assert_eq!(ignored::inventory(&r.work).unwrap().files, 1);
    r.write(
        "web/pnpm-workspace.yaml",
        "allowBuilds:\n  esbuild: true\n\n  @scope/tool: false\n",
    );
    assert_eq!(ignored::inventory(&r.work).unwrap().files, 0);
    fs::remove_file(Path::new(&r.work).join("web/package.json")).unwrap();
    assert_eq!(ignored::inventory(&r.work).unwrap().files, 1);
}

#[cfg(unix)]
#[test]
fn pnpm_links_survive_by_target_both_strip_and_whole_folder_removal() {
    for days in [4, 30] {
        let home = crate::profile::tests::Home::with_a_configured_base();
        let _profile = crate::profile::started_in(&home.dir);
        let r = Repo::new();
        r.write("web/package.json", "{}");
        git::text(&r.work, &["add", "web/package.json"]).unwrap();
        git::text(&r.work, &["commit", "-m", "manifest"]).unwrap();
        r.write("web/node_modules/.pnpm/tool/file", "build output");
        let sentinel = r._home.join("outside-sentinel");
        fs::write(&sentinel, "target must survive").unwrap();
        std::os::unix::fs::symlink(&sentinel, Path::new(&r.work).join("web/node_modules/tool"))
            .unwrap();
        std::os::unix::fs::symlink(
            &sentinel,
            Path::new(&r.work).join("web/node_modules/pnpm-workspace.yaml"),
        )
        .unwrap();
        r.write("web/pnpm-workspace.yaml", "allowBuilds:\n  esbuild: true\n");
        assert_eq!(ignored::inventory(&r.work).unwrap().files, 0);
        r.age(days);
        let svc = r.services(days);
        let state = Store::default();
        // At 30 days exercise Git's whole-folder removal directly, with the
        // link still present; at 4 days exercise strip itself.
        let preview = r.observe(now(), &known()).item;
        state.inner.lock().unwrap().items = vec![preview.clone()];
        assert!(operate(&svc, &state, &preview, now(), days == 4, &checks())
            .unwrap()
            .is_some());
        assert!(!Path::new(&r.work).join("web/node_modules").exists());
        assert_eq!(
            fs::read_to_string(&sentinel).unwrap(),
            "target must survive"
        );
        assert_eq!(gone(&r.work), days == 30);
    }
}

#[test]
fn m1_unknown_usage_withholds_strip_and_windows_does_too() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("Cargo.toml", "[package]");
    git::text(&r.work, &["add", "Cargo.toml"]).unwrap();
    git::text(&r.work, &["commit", "-m", "manifest"]).unwrap();
    r.write("target/keep", "live build");
    #[cfg(unix)]
    let mut live = Command::new("sleep")
        .arg("30")
        .current_dir(&r.work)
        .spawn()
        .unwrap();
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    for windows in [false, true] {
        sweep_checked(
            &svc,
            &state,
            &Checks {
                windows,
                usage: Usage::default,
                ..checks()
            },
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&r.work).join("target/keep")).unwrap(),
            "live build"
        );
        assert_eq!(state.saved().unwrap().history[0].stripped, 0);
    }
    #[cfg(unix)]
    {
        let _ = live.kill();
        let _ = live.wait();
    }
}

#[test]
fn m2_content_budget_withholds_large_untracked_file_in_words() {
    let r = Repo::new();
    let f = fs::File::create(Path::new(&r.work).join("media.bin")).unwrap();
    f.set_len(1024 * 1024 * 1024).unwrap();
    let o = observe(
        &r.allocation(),
        &r.checkout(),
        &Settings::default(),
        &BTreeSet::new(),
        &known(),
        &crate::agent_chat::ChatManager::default(),
        old(),
        false,
        ignored::inventory,
    )
    .unwrap();
    assert_eq!(o.item.state, "abandoned");
    assert!(o.item.status_hash.is_empty());
    assert!(o.item.why.contains("512 MiB total limit"), "{}", o.item.why);
}

#[cfg(unix)]
fn with_git_wrapper<T>(home: &Path, script: &str, action: impl FnOnce() -> T) -> T {
    use std::os::unix::fs::PermissionsExt;
    let path = home.join("git-wrapper");
    fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    git::TEST_GIT.with(|p| *p.borrow_mut() = Some(path));
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            git::TEST_GIT.with(|p| *p.borrow_mut() = None);
        }
    }
    let _reset = Reset;
    action()
}

#[cfg(unix)]
fn wait_file(path: &Path) {
    let started = std::time::Instant::now();
    while !path.exists() {
        assert!(
            started.elapsed() < Duration::from_secs(45),
            "hold was not reached: {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(unix)]
#[test]
fn h3_archive_held_add_saves_b_restores_a_and_must_keep_both() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("tracked", "A");
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    let preview = r.observe(now(), &known()).item;
    state.inner.lock().unwrap().items = vec![preview.clone()];
    let hold = r._home.join("add-held");
    let release = r._home.join("add-release");
    let script = format!(
        r#"
case "$GIT_INDEX_FILE" in
  */.archive-index-*)
    case " $* " in
      *" add -A "*)
        touch -r '{work}/tracked' '{stamp}'
        printf B > '{work}/tracked'
        touch '{hold}'
        while test ! -f '{release}'; do sleep 0.01; done
        /usr/bin/git "$@"
        result=$?
        printf A > '{work}/tracked'
        touch -r '{stamp}' '{work}/tracked'
        exit "$result"
        ;;
    esac
    ;;
esac
exec /usr/bin/git "$@"
"#,
        work = r.work,
        stamp = r._home.join("tracked-stamp").display(),
        hold = hold.display(),
        release = release.display()
    );
    std::thread::scope(|scope| {
        let mover = scope.spawn(|| {
            wait_file(&hold);
            assert_eq!(
                fs::read_to_string(Path::new(&r.work).join("tracked")).unwrap(),
                "B"
            );
            fs::write(&release, "release").unwrap();
        });
        let error = with_git_wrapper(&r._home, &script, || {
            archive_checked(
                &svc,
                &state,
                &checks(),
                &preview.key,
                &preview.head,
                &preview.status_hash,
            )
        })
        .unwrap_err();
        mover.join().unwrap();
        assert!(error.contains("archive and folder are kept"), "{error}");
    });
    assert_eq!(
        fs::read_to_string(Path::new(&r.work).join("tracked")).unwrap(),
        "A"
    );
    let saved = state.saved().unwrap();
    assert_eq!(saved.archives.len(), 1);
    assert_eq!(
        git::text(
            &r.root,
            &["show", &format!("{}:tracked", saved.archives[0].reference)]
        )
        .unwrap(),
        "B"
    );
}

#[cfg(unix)]
#[test]
fn m3_profile_moved_during_held_final_inventory_keeps_folder() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    let preview = r.observe(now(), &known()).item;
    state.inner.lock().unwrap().items = vec![preview.clone()];
    let hold = r._home.join("inventory-held");
    let release = r._home.join("inventory-release");
    let count = r._home.join("inventory-count");
    let profile = home.profile();
    let moved = r._home.join("profile-away");
    let script = format!(
        r#"
case " $* " in
  *" --ignored=matching "*)
    n=0
    if test -f '{count}'; then n=$(cat '{count}'); fi
    n=$((n+1))
    echo "$n" > '{count}'
    if test "$n" = 4; then
      /usr/bin/git "$@"
      result=$?
      touch '{hold}'
      while test ! -f '{release}'; do sleep 0.005; done
      exit "$result"
    fi
    ;;
esac
exec /usr/bin/git "$@"
"#,
        count = count.display(),
        hold = hold.display(),
        release = release.display()
    );
    std::thread::scope(|scope| {
        let mover = scope.spawn(|| {
            wait_file(&hold);
            fs::rename(&profile, &moved).unwrap();
            fs::write(&release, "release").unwrap();
        });
        let result = with_git_wrapper(&r._home, &script, || {
            operate(&svc, &state, &preview, now(), false, &checks())
        });
        mover.join().unwrap();
        assert!(result.is_err());
    });
    assert!(Path::new(&r.work).exists());
    assert!(!profile.exists());
    fs::rename(&moved, &profile).unwrap();
}

#[cfg(unix)]
#[test]
fn m3_removed_outcome_is_owed_cache_dropped_and_reported_on_profile_return() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    let profile = home.profile();
    let moved = r._home.join("profile-away");
    let script = format!(
        r#"
case " $* " in
  *" worktree remove "*)
    /usr/bin/git "$@"
    result=$?
    if test "$result" = 0; then mv '{profile}' '{moved}'; fi
    exit "$result"
    ;;
esac
exec /usr/bin/git "$@"
"#,
        profile = profile.display(),
        moved = moved.display()
    );
    let mut rx = crate::bus::events().subscribe();
    with_git_wrapper(&r._home, &script, || sweep_checked(&svc, &state, &checks())).unwrap();
    assert!(gone(&r.work));
    let cache = state.inner.lock().unwrap();
    assert!(cache.owed);
    assert!(!cache.items.iter().any(|i| i.path == r.work));
    assert_eq!(cache.pending_reports.len(), 1);
    assert_eq!(cache.saved.history[0].removed.len(), 1);
    drop(cache);
    while let Ok(event) = rx.try_recv() {
        assert!(
            !(event.contains("worktree-swept") && event.contains(&r.work)),
            "premature report: {event}"
        );
    }
    fs::rename(&moved, &profile).unwrap();
    settle_store(&state).unwrap();
    assert!(!state.inner.lock().unwrap().owed);
    let mut reported = false;
    while let Ok(event) = rx.try_recv() {
        reported |= event.contains("worktree-swept") && event.contains(&r.work);
    }
    assert!(
        reported,
        "owed-save retry must emit the report without an hourly sweep"
    );
    assert_eq!(
        Store::default().saved().unwrap().history[0].removed.len(),
        1
    );
}

#[test]
#[ignore = "manual 60-worktree host timing proof"]
fn host_sixty_worktree_pass_timing_and_lock_hold() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.age(30);
    let svc = r.services(30);
    let project = crate::workspaces::list_workspaces_impl(&svc.workspaces).unwrap()[0]
        .id
        .clone();
    for n in 1..60 {
        let path = r
            ._home
            .canonical()
            .unwrap()
            .join(format!(".worktrees/repo/octiq/bench-{n}"));
        git::text(
            &r.root,
            &[
                "worktree",
                "add",
                "-b",
                &format!("octiq/bench-{n}"),
                path.to_str().unwrap(),
                "octiq/test",
            ],
        )
        .unwrap();
        let modified = UNIX_EPOCH + Duration::from_secs(1_000_000);
        for entry in fs::read_dir(&path).unwrap() {
            let entry = entry.unwrap();
            if entry.file_name() != ".git" {
                fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(entry.path())
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(modified))
                    .unwrap();
            }
        }
        directory_handle(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        crate::chat_index::upsert(serde_json::from_value(json!({"id":format!("bench-{n}"),"projectId":project,"title":"timing","cwd":path,"updatedAt":now()-30*DAY,"createdAt":now()-30*DAY})).unwrap()).unwrap();
    }
    LOCK_MAX.with(|n| n.set(Duration::ZERO));
    let started = std::time::Instant::now();
    let state = Store::default();
    sweep_checked(&svc, &state, &checks()).unwrap();
    let elapsed = started.elapsed();
    let max = LOCK_MAX.with(|n| n.get());
    let saved = state.saved().unwrap();
    println!(
        "HOST_TIMING pass_ms={} max_lifecycle_hold_ms={} removed={} failures={}",
        elapsed.as_millis(),
        max.as_millis(),
        saved.history[0].removed.len(),
        saved.history[0].failed.len()
    );
    assert_eq!(saved.history[0].removed.len(), 60);
}

#[cfg(unix)]
#[test]
#[ignore = "manual pnpm-sized 10800-entry real sweep proof"]
fn host_real_pnpm_sized_sweep_with_783_links_preserves_external_sentinel() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("web/package.json", "{}");
    git::text(&r.work, &["add", "web/package.json"]).unwrap();
    git::text(&r.work, &["commit", "-m", "manifest"]).unwrap();
    for n in 0..10_000 {
        r.write(&format!("web/node_modules/.pnpm/file-{n}"), "rebuildable");
    }
    let sentinel = r._home.join("outside-sentinel");
    fs::write(&sentinel, "must remain").unwrap();
    for n in 0..783 {
        std::os::unix::fs::symlink(
            &sentinel,
            Path::new(&r.work).join(format!("web/node_modules/link-{n}")),
        )
        .unwrap();
    }
    r.write("web/pnpm-workspace.yaml", "allowBuilds:\n  esbuild: true\n");
    assert_eq!(ignored::inventory(&r.work).unwrap().files, 0);
    let check_started = std::time::Instant::now();
    assert_eq!(
        ignored::bounded(&r.work, Duration::from_secs(10), 100_000)
            .unwrap()
            .files,
        0
    );
    println!(
        "PNPM_FINAL_CHECK entries=10783 budget_ms=10000 elapsed_ms={}",
        check_started.elapsed().as_millis()
    );
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    LOCK_MAX.with(|n| n.set(Duration::ZERO));
    sweep_checked(&svc, &state, &checks()).unwrap();
    println!(
        "PNPM_SWEEP {} max_lock_ms={}",
        serde_json::to_string(&state.saved().unwrap().history[0]).unwrap(),
        LOCK_MAX.with(|n| n.get()).as_millis()
    );
    assert!(gone(&r.work));
    assert_eq!(fs::read_to_string(&sentinel).unwrap(), "must remain");
}

#[test]
fn archive_large_64mib_untracked_preview_and_final_disk_compare() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    let file = fs::File::create(Path::new(&r.work).join("large-media.bin")).unwrap();
    file.set_len(64 * 1024 * 1024).unwrap();
    r.write("tracked", "changed as well");
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    let preview = r.observe(now(), &known()).item;
    assert_eq!(preview.state, "abandoned");
    state.inner.lock().unwrap().items = vec![preview.clone()];
    let archive = archive_checked(
        &svc,
        &state,
        &checks(),
        &preview.key,
        &preview.head,
        &preview.status_hash,
    )
    .unwrap();
    assert!(gone(&r.work));
    assert_eq!(
        git::text(
            &r.root,
            &[
                "cat-file",
                "-s",
                &format!("{}:large-media.bin", archive.reference)
            ]
        )
        .unwrap(),
        (64 * 1024 * 1024).to_string()
    );
}

#[test]
fn h5_lossy_clean_filter_keeps_automatic_and_archive_folder() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    git::text(
        &r.root,
        &["config", "filter.review.clean", "sed s/SECRET/REDACTED/g"],
    )
    .unwrap();
    git::text(&r.root, &["config", "filter.review.smudge", "cat"]).unwrap();
    r.write(".gitattributes", "*.raw filter=review\n");
    r.write("original.raw", "SECRET unique original\n");
    git::text(&r.work, &["add", "."]).unwrap();
    git::text(&r.work, &["commit", "-m", "lossy filter"]).unwrap();
    r.age(30);
    assert!(git::git(&r.work, &["status", "--porcelain"])
        .unwrap()
        .is_empty());
    let o = r.observe(now(), &known());
    assert_eq!(o.item.state, "abandoned");
    assert!(
        o.item
            .why
            .contains("1 tracked files cannot be restored byte for byte"),
        "{}",
        o.item.why
    );
    let svc = r.services(30);
    let state = Store::default();
    sweep_checked(&svc, &state, &checks()).unwrap();
    assert!(!gone(&r.work));
    // Both the already tracked original and an untracked attribute/file door.
    r.write("untracked.raw", "SECRET another original\n");
    git::text(&r.work, &["rm", "--cached", ".gitattributes"]).unwrap();
    let preview = r.observe(now(), &known()).item;
    state.inner.lock().unwrap().items = vec![preview.clone()];
    let error = archive_checked(
        &svc,
        &state,
        &checks(),
        &preview.key,
        &preview.head,
        &preview.status_hash,
    )
    .unwrap_err();
    assert!(
        error.contains("2 files cannot be restored byte for byte"),
        "{error}"
    );
    assert!(
        error.contains("archive ref refs/octiq/archive/") && error.contains("and folder are kept"),
        "{error}"
    );
    assert_eq!(
        fs::read_to_string(Path::new(&r.work).join("original.raw")).unwrap(),
        "SECRET unique original\n"
    );
    let archive = &state.saved().unwrap().archives[0];
    assert!(git::text(
        &r.root,
        &["show", &format!("{}:original.raw", archive.reference)]
    )
    .unwrap()
    .contains("REDACTED"));
}

#[test]
fn h5_reversible_autocrlf_and_explicit_eol_restore_exact_raw_bytes() {
    let r = Repo::new();
    git::text(&r.root, &["config", "core.autocrlf", "true"]).unwrap();
    r.recheckout();
    r.write("crlf", "one\r\ntwo\r\n");
    git::text(&r.work, &["add", "crlf"]).unwrap();
    git::text(&r.work, &["commit", "-m", "CRLF"]).unwrap();
    assert_eq!(raw::verify(&r.work, "HEAD", false).unwrap().unrestorable, 0);
    r.write("crlf", "changed\r\ntwo\r\n");
    let head = git::text(&r.work, &["rev-parse", "HEAD"]).unwrap();
    let reference = "refs/octiq/archive/crlf";
    git::archive(&r.work, &head, reference, &r._home.join("index")).unwrap();
    assert_eq!(
        raw::verify(&r.work, reference, true).unwrap().unrestorable,
        0
    );
    let target = r._home.join("restore-crlf");
    git::restore(&r.root, target.to_str().unwrap(), "octiq/crlf", reference).unwrap();
    assert_eq!(
        fs::read(target.join("crlf")).unwrap(),
        b"changed\r\ntwo\r\n"
    );
    git::text(&r.root, &["config", "core.autocrlf", "false"]).unwrap();
    r.write(".gitattributes", "crlf text eol=crlf\n");
    assert_eq!(
        raw::verify(&r.work, reference, false).unwrap().unrestorable,
        0
    );
    // Missing/offline smudge is unknown restoration, not proof of preservation.
    git::text(&r.root, &["config", "filter.offline.smudge", "exit 1"]).unwrap();
    git::text(&r.root, &["config", "filter.offline.required", "true"]).unwrap();
    r.write(".gitattributes", "crlf filter=offline\n");
    assert_eq!(
        raw::verify(&r.work, reference, false).unwrap().unrestorable,
        1
    );
}

#[test]
fn h7_hidden_index_edits_are_abandoned_and_archive_restores_raw_bytes() {
    for flag in ["--assume-unchanged", "--skip-worktree"] {
        let home = crate::profile::tests::Home::with_a_configured_base();
        let _profile = crate::profile::started_in(&home.dir);
        let r = Repo::new();
        git::text(&r.root, &["config", "core.autocrlf", "false"]).unwrap();
        r.recheckout();
        git::text(&r.work, &["update-index", flag, "tracked"]).unwrap();
        r.write("tracked", "hidden original\n");
        r.age(30);
        assert!(git::git(&r.work, &["status", "--porcelain"])
            .unwrap()
            .is_empty());
        let preview = r.observe(now(), &known()).item;
        assert_eq!(preview.state, "abandoned", "{flag}");
        assert!(
            preview
                .why
                .contains("1 edited assume-unchanged/skip-worktree files"),
            "{}",
            preview.why
        );
        let svc = r.services(30);
        let state = Store::default();
        sweep_checked(&svc, &state, &checks()).unwrap();
        assert!(!gone(&r.work));
        state.inner.lock().unwrap().items = vec![preview.clone()];
        let archive = archive_checked(
            &svc,
            &state,
            &checks(),
            &preview.key,
            &preview.head,
            &preview.status_hash,
        )
        .unwrap();
        let restored = restore_from(&svc, &state, &archive.key).unwrap();
        assert_eq!(
            fs::read(Path::new(restored["path"].as_str().unwrap()).join("tracked")).unwrap(),
            b"hidden original\n"
        );
    }
    let r = Repo::new();
    git::text(&r.work, &["update-index", "--skip-worktree", "tracked"]).unwrap();
    fs::remove_file(Path::new(&r.work).join("tracked")).unwrap();
    assert_eq!(raw::verify(&r.work, "HEAD", false).unwrap().unrestorable, 0);
}

#[test]
fn h7_status_overrides_hidden_untracked_fsmonitor_and_untracked_cache() {
    let r = Repo::new();
    git::text(&r.root, &["config", "status.showUntrackedFiles", "no"]).unwrap();
    git::text(
        &r.root,
        &["config", "core.fsmonitor", "a-broken-fsmonitor-command"],
    )
    .unwrap();
    git::text(&r.root, &["config", "core.untrackedCache", "true"]).unwrap();
    r.write("new-original", "precious");
    let o = r.observe(old(), &known());
    assert_eq!(o.item.state, "abandoned");
    assert_eq!(o.item.untracked_files, 1);
}

#[cfg(unix)]
#[test]
fn h6_ignored_write_during_held_archive_comparison_keeps_folder() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("dirty", "preserve dirty");
    r.write("package.json", "{}");
    r.write(
        "pnpm-workspace.yaml",
        "allowBuilds:\n  esbuild: set this to true or false\n",
    );
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    let preview = r.observe(now(), &known()).item;
    state.inner.lock().unwrap().items = vec![preview.clone()];
    let hold = r._home.join("held");
    let release = r._home.join("release");
    let script = format!(
        r#"
case "$GIT_INDEX_FILE" in
  */.verify-archive-*) case " $* " in *" diff "*)
    touch '{hold}'; while test ! -f '{release}'; do sleep 0.01; done;; esac;;
esac
exec /usr/bin/git "$@"
"#,
        hold = hold.display(),
        release = release.display()
    );
    std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            wait_file(&hold);
            r.write("pnpm-workspace.yaml", "packages:\n  - only-original/*\n");
            fs::write(&release, "go").unwrap();
        });
        let error = with_git_wrapper(&r._home, &script, || {
            archive_checked(
                &svc,
                &state,
                &checks(),
                &preview.key,
                &preview.head,
                &preview.status_hash,
            )
        })
        .unwrap_err();
        writer.join().unwrap();
        assert!(error.contains("Ignored files changed"), "{error}");
    });
    assert!(!gone(&r.work));
    assert_eq!(state.saved().unwrap().archives.len(), 1);
}

#[cfg(unix)]
#[test]
fn h6_raw_file_write_after_disk_read_is_caught_by_final_ctime_stamps() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    r.write("dirty", "before\n");
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    let preview = r.observe(now(), &known()).item;
    state.inner.lock().unwrap().items = vec![preview.clone()];
    let hold = r._home.join("held");
    let release = r._home.join("release");
    let modified = fs::metadata(Path::new(&r.work).join("dirty"))
        .unwrap()
        .modified()
        .unwrap();
    let script = format!(
        r#"
case " $* " in *" cat-file --filters "*"refs/octiq/archive/"*":dirty "*)
  touch '{hold}'; while test ! -f '{release}'; do sleep 0.01; done;;
esac
exec /usr/bin/git "$@"
"#,
        hold = hold.display(),
        release = release.display()
    );
    std::thread::scope(|scope| {
        let writer = scope.spawn(|| {
            wait_file(&hold);
            r.write("dirty", "after!\n");
            raw::open_regular(&Path::new(&r.work).join("dirty"))
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(modified))
                .unwrap();
            fs::write(&release, "go").unwrap();
        });
        let error = with_git_wrapper(&r._home, &script, || {
            archive_checked(
                &svc,
                &state,
                &checks(),
                &preview.key,
                &preview.head,
                &preview.status_hash,
            )
        })
        .unwrap_err();
        writer.join().unwrap();
        assert!(error.contains("ctime changed"), "{error}");
    });
    assert_eq!(
        fs::read_to_string(Path::new(&r.work).join("dirty")).unwrap(),
        "after!\n"
    );
}

#[test]
fn pnpm_exact_50_byte_literal_and_near_miss() {
    let r = Repo::new();
    r.write("package.json", "{}");
    let exact = "allowBuilds:\n  esbuild: set this to true or false\n";
    assert_eq!(exact.len(), 50);
    r.write("pnpm-workspace.yaml", exact);
    assert_eq!(ignored::inventory(&r.work).unwrap().files, 0);
    r.write(
        "pnpm-workspace.yaml",
        "allowBuilds:\n  esbuild: set this to true or false!\n",
    );
    assert_eq!(ignored::inventory(&r.work).unwrap().files, 1);
}

#[test]
fn m5_preflight_keeps_all_build_folders_when_any_contains_originals() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    for name in ["a", "z"] {
        r.write(&format!("{name}/Cargo.toml"), "[package]");
        r.write(&format!("{name}/target/cache"), "safe cache");
    }
    r.write("z/target/source/ONLY-ORIGINAL", "original");
    r.age(30);
    let svc = r.services(30);
    let state = Store::default();
    sweep_checked(&svc, &state, &checks()).unwrap();
    let report = &state.saved().unwrap().history[0];
    assert_eq!(report.stripped, 0);
    assert_eq!(report.freed_bytes, 0);
    assert!(!report.failed.is_empty());
    for name in ["a", "z"] {
        assert!(Path::new(&r.work)
            .join(format!("{name}/target/cache"))
            .exists());
    }
}

#[cfg(unix)]
#[test]
fn m6_real_fifo_pnpm_returns_within_timeout_and_is_at_stake() {
    let r = Repo::new();
    r.write("package.json", "{}");
    let fifo = Path::new(&r.work).join("pnpm-workspace.yaml");
    assert!(Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    let (tx, rx) = std::sync::mpsc::channel();
    let work = r.work.clone();
    let handle = std::thread::spawn(move || {
        let result = ignored::inventory(&work);
        tx.send(result.map(|i| i.files)).unwrap();
    });
    assert_eq!(
        rx.recv_timeout(Duration::from_secs(3))
            .expect("FIFO blocked inventory")
            .unwrap(),
        1
    );
    handle.join().unwrap();
    assert!(raw::open_regular(&fifo).is_err());
}

#[test]
fn m5_late_second_refusal_keeps_successful_first_strip_in_history_and_cache() {
    thread_local! { static LATE: std::cell::RefCell<(usize, PathBuf)> = std::cell::RefCell::new((0, PathBuf::new())); }
    fn usage() -> Usage {
        LATE.with(|slot| {
            let mut s = slot.borrow_mut();
            s.0 += 1;
            // sweep inventory, operate observation, first final, second final.
            if s.0 == 4 {
                crate::profile::make_dir(s.1.parent().unwrap()).unwrap();
                fs::write(&s.1, "late original").unwrap();
            }
        });
        known()
    }
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    let r = Repo::new();
    for name in ["a", "z"] {
        r.write(&format!("{name}/Cargo.toml"), "[package]");
        r.write(&format!("{name}/target/cache"), "safe cache");
    }
    r.age(30);
    let builds = r.observe(now(), &known()).tree.builds;
    assert_eq!(builds.len(), 2);
    LATE.with(|slot| *slot.borrow_mut() = (0, builds[1].join("source/ONLY-ORIGINAL")));
    let svc = r.services(30);
    let state = Store::default();
    sweep_checked(&svc, &state, &Checks { usage, ..checks() }).unwrap();
    let report = &state.saved().unwrap().history[0];
    assert_eq!(report.stripped, 1);
    assert_eq!(report.freed_bytes, 10);
    assert!(report
        .failed
        .iter()
        .any(|f| f.why.contains("at-stake ignored files")));
    assert!(!builds[0].exists());
    assert!(builds[1].join("source/ONLY-ORIGINAL").exists());
    let cache = state.inner.lock().unwrap();
    let item = cache.items.iter().find(|i| i.path == r.work).unwrap();
    assert_eq!(item.build_bytes, Some(10));
}

#[cfg(unix)]
#[test]
fn h5_plain_checkout_has_one_attribute_pass_and_no_restore_content_reads() {
    let r = Repo::new();
    git::text(&r.root, &["config", "core.autocrlf", "false"]).unwrap();
    r.recheckout();
    let attr = r._home.join("attrs");
    let content = r._home.join("content");
    let script = format!(
        r#"
case " $* " in *" check-attr "*) echo pass >> '{attr}';; *" cat-file "*) touch '{content}';; esac
exec /usr/bin/git "$@"
"#,
        attr = attr.display(),
        content = content.display()
    );
    let proof =
        with_git_wrapper(&r._home, &script, || raw::verify(&r.work, "HEAD", false)).unwrap();
    assert_eq!(proof.unrestorable, 0);
    assert_eq!(fs::read_to_string(attr).unwrap().lines().count(), 1);
    assert!(!content.exists());
}

#[cfg(windows)]
#[test]
fn h5_real_lfs_offline_smudge_fails_closed() {
    assert!(
        Command::new("git")
            .args(["lfs", "version"])
            .status()
            .unwrap()
            .success(),
        "Git LFS is required for this Windows acceptance proof"
    );
    let r = Repo::new();
    let pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:1111111111111111111111111111111111111111111111111111111111111111\nsize 13\n";
    r.write("asset.lfs", pointer);
    git::text(&r.work, &["add", "asset.lfs"]).unwrap();
    git::text(&r.work, &["commit", "-m", "pointer without object"]).unwrap();
    for (name, value) in [
        ("filter.lfs.process", "git-lfs filter-process"),
        ("filter.lfs.clean", "git-lfs clean -- %f"),
        ("filter.lfs.smudge", "git-lfs smudge -- %f"),
        ("filter.lfs.required", "true"),
        ("lfs.url", "http://127.0.0.1:1/offline-lfs-proof"),
        ("lfs.skipdownloaderrors", "false"),
    ] {
        git::text(&r.root, &["config", name, value]).unwrap();
    }
    r.write(".gitattributes", "*.lfs filter=lfs -text\n");
    r.write("asset.lfs", "real original");
    let proof = raw::verify(&r.work, "HEAD", false).unwrap();
    assert_eq!(proof.unrestorable, 1);
    assert_eq!(
        fs::read_to_string(Path::new(&r.work).join("asset.lfs")).unwrap(),
        "real original"
    );
}

#[test]
fn validation_cleanup_checks_hidden_bytes_and_stamps_after_off_lock_proof() {
    let r = Repo::new();
    git::text(&r.work, &["update-index", "--skip-worktree", "tracked"]).unwrap();
    r.write("tracked", "hidden bytes\n");
    assert!(validation_removal_proof(&r.work)
        .err()
        .unwrap()
        .contains("1 tracked files"));
    git::text(&r.work, &["update-index", "--no-skip-worktree", "tracked"]).unwrap();
    r.recheckout();
    let proof = validation_removal_proof(&r.work).unwrap().unwrap();
    r.write("tracked", "changed after proof\n");
    assert!(verify_validation_removal(&r.work, &proof)
        .unwrap_err()
        .contains("ctime changed"));
    assert!(!gone(&r.work));
}
