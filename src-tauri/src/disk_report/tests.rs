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
    for name in ["Holiday.fcpbundle", "cut.prproj"] {
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
    // Git prints macOS /private/var while TestDir can use its /var alias.
    let home = TestDir::new("disk-worktree").canonicalized();
    let primary = home.join("repo");
    dir(&primary);
    git(&primary, &["init", "-b", "main"]);
    git(&primary, &["config", "user.email", "test@example.invalid"]);
    git(&primary, &["config", "user.name", "Test"]);
    fs::write(primary.join(".gitignore"), "output/\ncache.bin\n").unwrap();
    git(&primary, &["add", "."]);
    git(&primary, &["commit", "-m", "base"]);
    let linked = primary.join("target/linked");
    git(
        &primary,
        &["worktree", "add", "-b", "task", &display(&linked)],
    );
    file(&linked.join("output/cache"), THRESHOLD, 10);
    file(&linked.join("cache.bin"), THRESHOLD / 2, 10);
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
    file(&home.join("unrelated.photoslibrary/data"), THRESHOLD, 0);
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
    assert!(
        s.skipped
            .iter()
            .any(|row| Path::new(&row.path).ends_with("unrelated.photoslibrary")),
        "Unrelated skipped roots must not block this clean worktree"
    );
    assert_eq!(w.ignored_bytes, THRESHOLD + THRESHOLD / 2);
    assert_ne!(i.path, display(&primary));
    assert_eq!(
        items.len(),
        1,
        "Parent target must not retain its rm action"
    );
    let measured = s.sizes[&linked].bytes;
    s.sizes.get_mut(&linked).unwrap().bytes = THRESHOLD - 1;
    let mut smaller = s.items();
    s.worktrees(&usage, &mut smaller, &mut |_, _, _, _| {})
        .unwrap();
    assert!(
        smaller.is_empty(),
        "A small worktree still protects the parent cache"
    );
    s.sizes.get_mut(&linked).unwrap().bytes = measured;
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
    s.work_paths.push(linked.join("film.fcpbundle"));
    let mut personal_managed = vec![];
    s.worktrees(&usage, &mut personal_managed, &mut |_, _, _, _| {})
        .unwrap();
    assert_eq!(personal_managed[0].group, "review");
    assert!(personal_managed[0]
        .note
        .as_ref()
        .unwrap()
        .contains("Managed by an OctiqFlow run"));
    assert!(personal_managed[0].action.is_none());
    s.work_paths.clear();
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
fn media_project_outputs_keep_the_parent_work_label() {
    let home = TestDir::new("disk-nested-work");
    file(&home.join("media/remotion.config.ts"), 0, 0);
    file(&home.join("media/Exports/movie.mp4"), THRESHOLD, 10);
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    let items = disjoint_items(s.items());
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].group, "work");
    assert!(items[0].action.is_none());
    assert!(items[0].path.ends_with("media"));
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

#[cfg(unix)]
#[test]
fn git_directory_symlink_does_not_discover_repository() {
    let home = TestDir::new("disk-git-symlink");
    let outside = TestDir::new("disk-git-admin");
    dir(&home.join("repo"));
    std::os::unix::fs::symlink(&*outside, home.join("repo/.git")).unwrap();
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    assert!(s.repos.is_empty());
}

#[test]
fn temp_walk_never_discovers_git_repositories() {
    let home = TestDir::new("disk-temp-git-home");
    let temp = TestDir::new("disk-temp-git");
    dir(&temp.join(".git"));
    let mut s = scanner(&home, "linux");
    s.home_device = device(&fs::symlink_metadata(&*home).unwrap());
    s.walk(&temp, false, false, false, "temp", &mut |_, _, _, _| {})
        .unwrap();
    assert!(s.repos.is_empty());
}

#[test]
fn walk_retains_only_candidate_and_required_root_sizes_not_file_paths() {
    let home = TestDir::new("disk-streaming");
    let cache = home.join(".cache/uv");
    file(&cache.join("payload"), THRESHOLD, 1);
    for n in 0..2048 {
        File::create(cache.join(format!("small-{n}"))).unwrap();
    }
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    assert!(s.entries > 2048);
    assert_eq!(s.sizes.len(), 1);
    assert_eq!(s.candidates.len(), 1);
    assert_eq!(s.sizes[&cache].bytes, THRESHOLD);
}

#[test]
fn progress_is_throttled_and_can_cancel_a_walk_in_flight() {
    let home = TestDir::new("disk-live-cancel");
    file(&home.join(".npm/payload"), THRESHOLD, 1);
    let mut s = scanner(&home, "linux");
    s.home_device = device(&fs::symlink_metadata(&*home).unwrap());
    let cancel = s.cancel.clone();
    let mut events = 0;
    assert!(s
        .walk(&home, false, false, false, "home", &mut |_, _, _, _| {
            events += 1;
            cancel.store(true, Ordering::Relaxed);
        })
        .is_err());
    assert_eq!(events, 1);
    assert!(home.join(".npm/payload").exists());
    let mut s = scanner(&home, "linux");
    let mut events = 0;
    let mut emit = |_: &str, _: u64, _: u64, _: Option<String>| {
        events += 1;
    };
    for _ in 0..100 {
        s.progress("home", None, &mut emit);
    }
    assert_eq!(events, 1);
    s.last = Instant::now() - Duration::from_millis(251);
    s.progress("home", None, &mut |_, _, _, _| {
        events += 1;
    });
    assert_eq!(events, 2);
}

#[test]
fn encoded_project_names_inside_chat_history_remain_history() {
    let home = TestDir::new("disk-chat-media-name");
    file(
        &home.join(".claude/projects/my-remotion-project/old.jsonl"),
        THRESHOLD,
        15,
    );
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    let items = s.items();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].kind, "claude-history-older-14-days");
    assert_eq!(items[0].group, "review");
}

#[test]
fn skipped_roots_are_capped_and_unreadable_entries_are_grouped() {
    let home = TestDir::new("disk-skip-cap");
    let mut s = scanner(&home, "linux");
    for n in 0..1000 {
        s.unreadable(&home.join(format!("unreadable-{n}")), "Permission denied");
    }
    assert_eq!(s.skipped.len(), 1);
    assert!(s.skipped[0].reason.contains("1000 entries unreadable"));
    assert!(s.skipped[0].reason.contains("Permission denied"));
    for n in 0..700 {
        s.skip(&home.join(format!("protected-{n}")), "Protected root");
    }
    s.skip(&home.join("protected-0"), "Protected root");
    let rows = s.skipped_report();
    assert_eq!(rows.len(), SKIP_LIMIT + 1);
    assert!(rows.last().unwrap().reason.contains("201 more"));
    assert_eq!(s.skip_index.len(), SKIP_LIMIT);
    assert_eq!(s.unreadable.len(), 1);
}

#[test]
fn treemap_items_are_disjoint_except_complementary_history_age_buckets() {
    let home = TestDir::new("disk-overlap");
    let prototype = report(&home, 1).items[0].clone();
    let make = |relative: &str, kind: &str, bytes: u64| {
        let mut i = prototype.clone();
        i.path = display(&home.join(relative));
        i.kind = kind.into();
        i.key = format!("{kind}:{}", i.path);
        i.bytes = bytes;
        i.group = if kind.contains("history") || kind == "git-worktree" {
            "review"
        } else {
            "clean"
        }
        .into();
        i
    };
    let items = disjoint_items(vec![
        make("repo/node_modules", "project-node_modules", THRESHOLD),
        make("repo", "project-target", THRESHOLD),
        make("repo", "git-worktree", 3 * THRESHOLD),
        make("other/target", "project-target", 2 * THRESHOLD),
        make("other/target/.next", "project-next", THRESHOLD),
        make(
            ".claude/projects",
            "claude-history-older-14-days",
            THRESHOLD,
        ),
        make(".claude/projects", "claude-history-last-14-days", THRESHOLD),
    ]);
    assert_eq!(items.len(), 4);
    assert_eq!(items.iter().map(|i| i.bytes).sum::<u64>(), 7 * THRESHOLD);
    assert_eq!(items.iter().filter(|i| i.path.ends_with("repo")).count(), 1);
    assert!(items.iter().any(|i| i.kind == "git-worktree"));
    for a in &items {
        for b in &items {
            if a.path != b.path {
                assert!(!Path::new(&a.path).starts_with(&b.path));
            }
        }
    }
}

#[test]
fn loading_a_legacy_report_caps_and_rewrites_only_latest_json() {
    let home = TestDir::new("disk-legacy-skip-cap");
    let mut r = report(&home, 1);
    r.skipped = (0..700)
        .map(|n| Skipped {
            path: display(&home.join(format!("root-{n}"))),
            reason: "Excluded root".into(),
        })
        .collect();
    dir(&home.join("disk-report"));
    let path = home.join("disk-report/latest.json");
    fs::write(&path, serde_json::to_vec(&r).unwrap()).unwrap();
    let loaded = history::load(&home).unwrap().unwrap();
    assert_eq!(loaded.skipped.len(), SKIP_LIMIT + 1);
    assert!(loaded.skipped.last().unwrap().reason.contains("200 more"));
    let saved: Report = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved.skipped.len(), SKIP_LIMIT + 1);
    assert!(!home.join("disk-report/sizes.csv").exists());
    assert_eq!(
        history::load(&home).unwrap().unwrap().skipped.len(),
        SKIP_LIMIT + 1
    );
}

#[test]
fn code_exports_and_dependency_media_names_are_not_personal_work() {
    let home = TestDir::new("disk-code-exports");
    file(&home.join("repo/package.json"), 0, 0);
    file(&home.join("repo/exports/screenshot.png"), THRESHOLD, 0);
    file(
        &home.join("repo/remotion-fixtures/example.png"),
        THRESHOLD,
        0,
    );
    file(
        &home.join("repo/remotion-fixtures/remotion-render.txt"),
        1,
        0,
    );
    file(&home.join("repo/renders/screenshot.png"), THRESHOLD, 0);
    file(&home.join("repo/dist/example.mp4"), THRESHOLD, 0);
    file(&home.join("repo/node_modules/remotion/package.json"), 0, 0);
    file(
        &home.join("repo/node_modules/remotion/remotion.config.ts"),
        0,
        0,
    );
    file(
        &home.join("repo/node_modules/.remotion/renders/example.mp4"),
        THRESHOLD,
        0,
    );
    file(&home.join(".cache/example-remotion/package.json"), 0, 0);
    file(
        &home.join(".cache/example-remotion/remotion.config.ts"),
        THRESHOLD,
        0,
    );
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    assert!(s.work_paths.is_empty());
    assert!(s.items().iter().all(|i| i.group != "work"));
    assert!(s.items().iter().any(|i| i.kind == "project-node_modules"));
}

#[test]
fn media_outputs_need_real_filename_evidence_or_a_project_marker() {
    let home = TestDir::new("disk-media-context");
    file(&home.join("Exports/data.bin"), THRESHOLD, 0);
    file(&home.join("renders/movie.mp4"), THRESHOLD, 0);
    file(&home.join("my-remotion-project/package.json"), 0, 0);
    file(
        &home.join("my-remotion-project/out/result.bin"),
        THRESHOLD,
        0,
    );
    file(&home.join("code/package.json"), 0, 0);
    file(&home.join("code/Photo Exports/portrait.jpg"), THRESHOLD, 0);
    file(&home.join("code/film/scene.mov"), THRESHOLD, 0);
    let mut s = scanner(&home, "linux");
    walk(&mut s);
    let items = disjoint_items(s.items());
    assert_eq!(items.iter().filter(|i| i.group == "work").count(), 4);
    assert!(!items
        .iter()
        .any(|i| i.path.ends_with("Exports") && !i.path.ends_with("Photo Exports")));
    assert!(items.iter().all(|i| i.action.is_none()));
}

#[cfg(unix)]
#[test]
fn bash_confirmation_requires_literal_yes_including_whitespace() {
    use std::io::Write;
    let home = TestDir::new("disk-exact-confirm");
    let target = home.join("selected data");
    file(&target.join("data"), 1, 1);
    let mut r = report(&home, 1);
    r.items[0].path = display(&target);
    r.items[0].action = Some(Action::Rm {
        path: display(&target),
    });
    let script_path = home.join("cleanup.sh");
    fs::write(&script_path, script::generate(&[&r.items[0]], false, true)).unwrap();
    for answer in [
        b" yes \n".as_slice(),
        b"YES\n",
        b"Yes\n",
        b"no\n",
        b"\n",
        b"yes\n",
    ] {
        let mut child = Command::new("bash")
            .arg(&script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(answer).unwrap();
        assert!(child.wait().unwrap().success());
        assert_eq!(target.exists(), answer != b"yes\n");
    }
}

#[cfg(windows)]
#[test]
fn powershell_confirmation_requires_literal_yes_on_real_windows() {
    use std::io::Write;
    let home = TestDir::new("disk-ps-exact-confirm");
    let target = home.join("selected 測試 ' $ data");
    file(&target.join("data"), 1, 1);
    let mut r = report(&home, 1);
    r.items[0].path = display(&target);
    r.items[0].action = Some(Action::Rm {
        path: display(&target),
    });
    let script_path = home.join("cleanup.ps1");
    fs::write(&script_path, script::generate(&[&r.items[0]], true, true)).unwrap();
    for answer in [" yes ", "YES", "Yes", "no", "", "yes"] {
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-File"])
            .arg(&script_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(format!("{answer}\n").as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "answer={answer:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(target.exists(), answer != "yes", "answer={answer:?}");
    }
}
