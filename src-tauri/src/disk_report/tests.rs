use super::super::{history, script};
use super::*;
use crate::test_dir::TestDir;
use std::{fs::File, time::UNIX_EPOCH};
fn dir(path: &Path) {
    crate::profile::make_dir(path).unwrap();
}
fn file(path: &Path, bytes: u64, days: u64) {
    dir(path.parent().unwrap());
    let f = File::create(path).unwrap();
    f.set_len(bytes).unwrap();
    f.set_modified(UNIX_EPOCH + Duration::from_millis(now() - days * DAY))
        .unwrap();
}
fn scanner(home: &Path, platform: &str) -> Scanner {
    Scanner::new(
        home.into(),
        platform,
        "test-scan".into(),
        Arc::new(AtomicBool::new(false)),
        HashSet::new(),
    )
}
fn walk(s: &mut Scanner) {
    s.home_device = device(&fs::symlink_metadata(&s.home).unwrap());
    s.walk(
        &s.home.clone(),
        false,
        false,
        false,
        "home",
        &mut |_, _, _, _| {},
    )
    .unwrap();
}
fn git(path: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
}
#[test]
fn locations_and_classification_are_platform_data() {
    let home = Path::new("/fake");
    for platform in ["macos", "linux", "windows"] {
        for (path, kind, _, cmd) in cache_roots(platform) {
            let c = classify(home, &home.join(path), platform, false).unwrap();
            assert_eq!(c.kind, kind);
            assert_eq!(c.group, "clean");
            assert!(matches!(c.action,Some(Action::Tool{command}) if command==cmd));
        }
    }
    assert!(classify(home, &home.join("node_modules"), "linux", false).is_none());
    assert_eq!(
        classify(home, &home.join("repo/target"), "linux", true)
            .unwrap()
            .group,
        "clean"
    );
    for path in [
        ".ollama",
        ".cache/huggingface",
        ".rustup/toolchains",
        "Library/Developer/CoreSimulator",
    ] {
        assert_eq!(
            classify(home, &home.join(path), "macos", false)
                .unwrap()
                .group,
            "review"
        );
    }
    for name in [
        "Holiday.fcpbundle",
        "cut.prproj",
        "Exports",
        "renders",
        "my-remotion-project",
    ] {
        let c = classify(home, &home.join(name), "linux", true).unwrap();
        assert_eq!(c.group, "work");
        assert!(c.action.is_none());
    }
}
#[test]
fn metadata_walk_threshold_personal_work_and_no_content_reads() {
    let home = TestDir::new("disk-threshold");
    file(&home.join("repo/package.json"), 0, 0);
    file(&home.join("repo/node_modules/pkg/bytes"), THRESHOLD, 1);
    file(&home.join(".cache/uv/content"), THRESHOLD - 1, 1);
    file(&home.join("Exports/movie.mp4"), THRESHOLD, 0);
    file(&home.join("video/remotion.config.ts"), 0, 0);
    file(&home.join("video/out/movie.mp4"), THRESHOLD, 0);
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    let items = s.items();
    assert_eq!(items.len(), 3);
    assert_eq!(items.iter().filter(|i| i.group == "work").count(), 2);
    assert!(items.iter().all(|i| i.bytes >= THRESHOLD));
}
#[test]
fn mac_privacy_roots_are_never_entered_and_library_defaults_to_skip() {
    let home = TestDir::new("disk-tcc");
    for p in [
        "Desktop",
        "Documents",
        "Downloads",
        "Library/Mobile Documents",
        "Library/CloudStorage",
        "Library/Mail",
        "Library/Containers",
        "Library/Group Containers",
        "Library/Application Support/UnknownApp",
        "Library/Caches/UnknownApp",
    ] {
        file(&home.join(p).join("node_modules/data"), THRESHOLD, 0);
    }
    file(&home.join("Library/Caches/Homebrew/data"), THRESHOLD, 0);
    file(&home.join("family.photoslibrary/data"), THRESHOLD, 0);
    file(
        &home.join(".octiqflow/profiles/default/chats/data"),
        THRESHOLD,
        0,
    );
    let mut s = scanner(&home, "macos");
    walk(&mut s);
    assert_eq!(s.items().len(), 1);
    assert_eq!(s.items()[0].kind, "homebrew-cache");
    assert!(!s
        .sizes
        .keys()
        .any(|p| p.ends_with("family.photoslibrary/data")
            || p.ends_with("Desktop/node_modules/data")));
    assert!(s
        .skipped
        .iter()
        .any(|p| Path::new(&p.path).ends_with("Library/Caches/UnknownApp")));
}
#[test]
fn chat_age_split_excludes_every_memory_directory() {
    let home = TestDir::new("disk-history-age");
    file(&home.join(".codex/sessions/old.jsonl"), THRESHOLD, 15);
    file(&home.join(".codex/sessions/new.jsonl"), THRESHOLD, 1);
    file(
        &home.join(".codex/sessions/deep/memory/personal.md"),
        THRESHOLD * 3,
        30,
    );
    file(
        &home.join(".codex/sessions/memory/personal.md"),
        THRESHOLD * 2,
        1,
    );
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    let items = s.items();
    assert_eq!(items.len(), 2);
    assert!(items.iter().all(|i| i.bytes == THRESHOLD));
    let recent = items.iter().find(|i| i.not_recommended).unwrap();
    assert!(recent.action.is_none());
    assert_eq!(recent.note.as_deref(), Some("Not recommended to delete"));
    let old = items.iter().find(|i| !i.not_recommended).unwrap();
    assert!(
        matches!(&old.action,Some(Action::RmOlderThan{days:14,exclude,..}) if exclude==&vec!["memory".to_string()])
    );
}
#[cfg(unix)]
#[test]
fn symlinks_are_not_followed() {
    let home = TestDir::new("disk-symlink");
    let outside = TestDir::new("disk-outside");
    file(&outside.join("data"), THRESHOLD, 0);
    std::os::unix::fs::symlink(&*outside, home.join(".npm")).unwrap();
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    assert!(s.items().is_empty());
    assert!(s.skipped.iter().any(|p| p.reason.contains("Symlink")));
}
#[cfg(windows)]
#[test]
fn junctions_are_not_followed() {
    let home = TestDir::new("disk-junction");
    let outside = TestDir::new("disk-outside");
    file(&outside.join("data"), THRESHOLD, 0);
    let output = Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(home.join(".npm"))
        .arg(&*outside)
        .output()
        .unwrap();
    assert!(output.status.success());
    let mut s = scanner(&home, "windows");
    walk(&mut s);
    assert!(s.items().is_empty());
    assert!(s.skipped.iter().any(|p| p.reason.contains("junction")));
    // Remove the junction, never its target, before TestDir cleanup.
    fs::remove_dir(home.join(".npm")).unwrap();
    assert!(outside.join("data").exists());
}
fn report(home: &Path, at: u64) -> Report {
    let c = candidate(
        &home.join("a ' $ path\ncache"),
        "cache",
        "clean",
        "Cache",
        "Rebuilds",
        None,
    );
    let i = scanner(home, "linux").item(
        &c,
        &Size {
            bytes: THRESHOLD,
            newest: at,
            complete: true,
            ..Size::default()
        },
    );
    Report {
        scan_id: "history".into(),
        scanned_at: at,
        platform: "linux".into(),
        home: display(home),
        threshold_bytes: THRESHOLD,
        total_bytes: THRESHOLD,
        items: vec![i],
        skipped: vec![],
        previous_scan_at: None,
    }
}
#[test]
fn csv_appends_quotes_and_compares_latest_earlier_scan() {
    let home = TestDir::new("disk-csv");
    let mut first = report(&home, 100);
    history::save(&home, &mut first).unwrap();
    let mut second = report(&home, 200);
    let previous = history::previous(&home, 200).unwrap();
    history::compare(&mut second, &previous);
    assert_eq!(second.previous_scan_at, Some(100));
    assert_eq!(second.items[0].previous_bytes, Some(THRESHOLD));
    assert!(!second.items[0].grew);
    second.items[0].bytes += 10 * 1024 * 1024;
    history::compare(&mut second, &previous);
    assert!(second.items[0].grew);
    history::save(&home, &mut second).unwrap();
    assert_eq!(
        history::previous(&home, 300).unwrap().rows[&second.items[0].key].1,
        second.items[0].bytes
    );
    assert_eq!(history::load(&home).unwrap().unwrap().scanned_at, 200);
    assert_eq!(history::previous(&home, 150).unwrap().at, Some(100));
}
#[cfg(unix)]
#[test]
fn history_refuses_redirected_output() {
    let home = TestDir::new("disk-csv-link");
    let target = TestDir::new("disk-target");
    std::os::unix::fs::symlink(&*target, home.join("disk-report")).unwrap();
    assert!(history::save(&home, &mut report(&home, 1)).is_err());
    assert!(fs::read_dir(&*target).unwrap().next().is_none());
}
#[test]
fn scripts_quote_all_platforms_and_gate_rm() {
    let home = TestDir::new("disk-script");
    let mut r = report(&home, 1);
    let path = "/a space/quote' and \" $HOME;$(touch bad)";
    r.items[0].path = path.into();
    r.items[0].action = Some(Action::Rm { path: path.into() });
    let mut w = r.items[0].clone();
    w.action = Some(Action::Worktree {
        repo: path.into(),
        path: path.into(),
    });
    let mut old = r.items[0].clone();
    old.action = Some(Action::RmOlderThan {
        path: path.into(),
        days: 14,
        exclude: vec!["memory".into()],
    });
    for platform in ["macos", "linux", "windows"] {
        let windows = platform == "windows";
        let off = script::generate(&[&r.items[0], &w, &old], windows, false);
        assert!(off.contains("Type exactly yes"));
        assert!(off.contains("Skipped (no tool command)"));
        assert!(!off.contains("rm -rf"));
        assert!(!off.contains("Remove-Item"));
        assert!(!off.contains("--force"));
        let on = script::generate(&[&r.items[0], &w, &old], windows, true);
        assert!(on.contains("ignored output"));
        assert!(on.contains("worktree remove"));
        if windows {
            assert!(on.contains("quote'' and"));
            assert!(on.contains("-LiteralPath"));
            assert!(on.contains("ReparsePoint"));
            assert!(on.contains("-ieq 'memory'"));
        } else {
            assert!(on.contains("quote'\\'' and"));
            assert!(on.contains("rm -rf --"));
            assert!(on.contains("-iname 'memory'"));
            assert!(on.contains("-mmin +20160"));
            assert!(!on.contains("-delete"));
            assert!(on.contains("-exec rm -f -- {} +"));
        }
    }
}
#[cfg(unix)]
#[test]
fn generated_bash_is_parseable_with_hostile_paths() {
    let home = TestDir::new("disk-script-parse");
    let mut r = report(&home, 1);
    r.items[0].action = Some(Action::RmOlderThan {
        path: "/tmp/space ' $()\n newline".into(),
        days: 14,
        exclude: vec!["a ' $()".into()],
    });
    let path = home.join("cleanup.sh");
    fs::write(&path, script::generate(&[&r.items[0]], false, true)).unwrap();
    assert!(Command::new("bash")
        .arg("-n")
        .arg(path)
        .status()
        .unwrap()
        .success());
}
#[test]
fn git_worktrees_require_every_check_and_preserve_managed_workspaces() {
    let home_guard = TestDir::new("disk-worktree");
    // Git prints macOS /private/var while TestDir can use its /var alias.
    let home = fs::canonicalize(&*home_guard).unwrap();
    let primary = home.join("repo");
    dir(&primary);
    git(&primary, &["init", "-b", "main"]);
    git(&primary, &["config", "user.email", "test@example.invalid"]);
    git(&primary, &["config", "user.name", "Test"]);
    fs::write(primary.join(".gitignore"), "output/\n").unwrap();
    git(&primary, &["add", "."]);
    git(&primary, &["commit", "-m", "base"]);
    let linked = home.join("linked");
    git(
        &primary,
        &["worktree", "add", "-b", "task", &display(&linked)],
    );
    file(&linked.join("output/cache"), THRESHOLD, 10);
    let old = UNIX_EPOCH + Duration::from_millis(now() - 10 * DAY);
    for p in [&linked, &linked.join("output"), &linked.join(".gitignore")] {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x02000000).access_mode(0x100);
        }
        options.open(p).unwrap().set_modified(old).unwrap();
    }
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    let usage = InUse {
        paths: vec![],
        error: None,
    };
    let mut items = s.items();
    s.worktrees(&usage, &mut items, &mut |_, _, _, _| {})
        .unwrap();
    let i = items.iter().find(|i| i.kind == "git-worktree").unwrap();
    assert_eq!(i.group, "clean", "{:?}", i.note);
    let w = i.worktree.as_ref().unwrap();
    assert!(w.eligible);
    assert_eq!(w.ignored_bytes, THRESHOLD);
    assert_ne!(i.path, display(&primary));
    s.managed.insert(linked.clone());
    let mut items = vec![];
    s.worktrees(&usage, &mut items, &mut |_, _, _, _| {})
        .unwrap();
    assert_eq!(items[0].group, "review");
    assert!(items[0]
        .note
        .as_ref()
        .unwrap()
        .contains("Managed by an OctiqFlow run"));
    s.managed.clear();
    file(&linked.join("untracked"), 1, 0);
    walk(&mut s);
    let mut items = vec![];
    s.worktrees(&usage, &mut items, &mut |_, _, _, _| {})
        .unwrap();
    assert!(!items[0].worktree.as_ref().unwrap().clean);
    assert_eq!(items[0].group, "review");
    fs::remove_file(linked.join("untracked")).unwrap();
    let mut items = vec![];
    s.worktrees(
        &InUse {
            paths: vec![linked.join("open")],
            error: None,
        },
        &mut items,
        &mut |_, _, _, _| {},
    )
    .unwrap();
    assert!(items[0].worktree.as_ref().unwrap().in_use);
    file(&linked.join("new-commit"), 1, 0);
    git(&linked, &["add", "new-commit"]);
    git(&linked, &["commit", "-m", "unmerged"]);
    let mut items = vec![];
    s.worktrees(&usage, &mut items, &mut |_, _, _, _| {})
        .unwrap();
    assert!(!items[0].worktree.as_ref().unwrap().merged);
    assert_eq!(items[0].group, "review");
}
#[test]
fn cancelled_walk_stops_without_writes() {
    let home = TestDir::new("disk-cancel");
    let mut s = scanner(&home, "linux");
    s.cancel.store(true, Ordering::Relaxed);
    assert!(s
        .walk(&home, false, false, false, "home", &mut |_, _, _, _| {})
        .is_err());
    assert!(fs::read_dir(&*home).unwrap().next().is_none());
}
#[test]
fn process_prefix_is_component_aware_and_unknown_is_held() {
    let usage = InUse {
        paths: vec![PathBuf::from("/home/repo-other/file")],
        error: None,
    };
    assert!(!usage.contains(Path::new("/home/repo")));
    assert!(InUse {
        paths: vec![],
        error: Some("unknown".into())
    }
    .contains(Path::new("/home/repo")));
    assert_eq!(docker_bytes("1.25GB"), 1_250_000_000);
}

#[test]
fn temp_requires_known_cache_age_and_no_use() {
    let home = TestDir::new("disk-temp-home");
    let temp = TestDir::new("disk-temp-root");
    for name in [
        "npm-old",
        "claude-123",
        "unknown-data",
        "octiqflow-job-spool-42",
        "pnpm-new",
    ] {
        file(
            &temp.join(name).join("data"),
            THRESHOLD,
            if name == "pnpm-new" { 1 } else { 5 },
        );
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x02000000).access_mode(0x100);
        }
        options
            .open(temp.join(name))
            .unwrap()
            .set_modified(
                UNIX_EPOCH
                    + Duration::from_millis(now() - if name == "pnpm-new" { DAY } else { 5 * DAY }),
            )
            .unwrap();
    }
    let mut s = scanner(&home, "linux");
    s.home_device = device(&fs::symlink_metadata(&*home).unwrap());
    let mut items = vec![];
    let roots = vec![temp.to_path_buf()];
    let usage = InUse {
        paths: vec![],
        error: None,
    };
    s.temp_roots(&roots, &usage, &mut items, &mut |_, _, _, _| {})
        .unwrap();
    assert_eq!(items.len(), 2);
    assert!(items
        .iter()
        .any(|i| i.kind == "ai-session-temp" && i.group == "review"));
    let mut items = vec![];
    s.temp_roots(
        &roots,
        &InUse {
            paths: vec![],
            error: Some("unknown".into()),
        },
        &mut items,
        &mut |_, _, _, _| {},
    )
    .unwrap();
    assert!(items.is_empty());
}

#[test]
fn script_selection_is_bound_to_stored_scan_and_work_is_rejected() {
    let home = TestDir::new("disk-selection");
    let mut r = report(&home, 1);
    let id = r.items[0].id.clone();
    assert!(super::super::select(&r, "stale", &[id.clone()]).is_err());
    assert!(super::super::select(&r, &r.scan_id, &["unknown".into()]).is_err());
    assert_eq!(
        super::super::select(&r, &r.scan_id, &[id.clone(), id.clone()])
            .unwrap()
            .len(),
        1
    );
    r.items[0].group = "work".into();
    assert!(super::super::select(&r, &r.scan_id, &[id.clone()]).is_err());
    r.items[0].group = "review".into();
    r.items[0].action = None;
    assert!(super::super::select(&r, &r.scan_id, &[id]).is_err());
}

#[test]
fn personal_work_inside_cache_never_inherits_parent_cleanup() {
    let home = TestDir::new("disk-nested-work");
    file(&home.join("repo/package.json"), 0, 0);
    file(
        &home.join("repo/node_modules/Exports/movie.mp4"),
        THRESHOLD,
        10,
    );
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    let items = s.items();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].group, "work");
    assert!(items[0].action.is_none());
    assert!(items[0].path.ends_with("Exports"));
}

#[cfg(unix)]
#[test]
fn generated_age_cleanup_preserves_recent_files_memories_and_symlinks() {
    use std::io::Write;
    let home = TestDir::new("disk-age-execution");
    let root = home.join("history ' $ data");
    file(&root.join("old"), 1, 15);
    file(&root.join("recent"), 1, 1);
    file(&root.join("nested/MEMORY/old"), 1, 30);
    let outside = home.join("outside");
    file(&outside.join("old"), 1, 30);
    std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
    let mut r = report(&home, 1);
    r.items[0].action = Some(Action::RmOlderThan {
        path: display(&root),
        days: 14,
        exclude: vec!["memory".into()],
    });
    let script = home.join("cleanup.sh");
    fs::write(&script, script::generate(&[&r.items[0]], false, true)).unwrap();
    let mut child = Command::new("bash")
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"yes\n").unwrap();
    assert!(child.wait().unwrap().success());
    assert!(!root.join("old").exists());
    for p in [
        root.join("recent"),
        root.join("nested/MEMORY/old"),
        outside.join("old"),
    ] {
        assert!(p.exists());
    }
}
