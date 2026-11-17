//! Quarantine: nothing reaches a folder by its path after the last check.
//! Every test ends with a safe control that is really removed, so a refusal
//! is never mistaken for a removal that could not happen.
use super::*;
use crate::worktree_lifespan::quarantine::{self, Record, PREFIX};

/// A git whose first `worktree <sub>` waits (later ones pass), for the test: it says it has
/// arrived (`hold`), runs `before`, and goes on when `release` exists.
fn barrier_script(sub: &str, hold: &Path, release: &Path, before: &str) -> String {
    format!(
        r#"
case " $* " in
  *" worktree {sub} "*)
    if test ! -f '{hold}'; then
    {before}
    touch '{hold}'
    while test ! -f '{release}'; do sleep 0.01; done
    fi
    ;;
esac
exec /usr/bin/git "$@"
"#,
        hold = hold.display(),
        release = release.display()
    )
}
fn leftovers(r: &Repo) -> Vec<String> {
    fs::read_dir(above_of(r))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(PREFIX))
        .collect()
}
fn records() -> usize {
    fs::read_dir(crate::profile::profile_dir().join("lifespan-quarantine"))
        .map(|d| d.count())
        .unwrap_or(0)
}
fn report(store: &Store) -> Sweep {
    store.saved().unwrap().history[0].clone()
}
fn removed_for_real(store: &Store, r: &Repo) {
    assert!(
        gone(&r.work),
        "the safe control must really be removed: {:?}",
        report(store).failed
    );
    assert_eq!(report(store).removed.len(), 1);
    assert!(leftovers(r).is_empty(), "{:?}", leftovers(r));
    assert_eq!(records(), 0);
}
fn name_of(r: &Repo) -> String {
    Path::new(&r.work)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}
fn kill(children: &mut [std::process::Child]) {
    for child in children {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[test]
fn a_registered_process_above_the_checkout_cannot_write_into_it_once_it_is_moved_aside() {
    // The reviewer's H1 probe: a process whose working folder is above the
    // checkout, registered as a job by a chat whose own folders are elsewhere.
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let store = Store::default();
    let above = above_of(&r);
    let name = name_of(&r);
    let elsewhere = r._home.join("elsewhere");
    crate::profile::make_dir(&elsewhere).unwrap();
    let mut sleeper = std::process::Command::new("sleep")
        .arg("60")
        .current_dir(&above)
        .spawn()
        .unwrap();
    svc.chats
        .test_remember_start("chat:pid-above", &elsewhere.to_string_lossy());
    svc.chats
        .jobs
        .register(
            "chat:pid-above",
            serde_json::from_value(
                serde_json::json!({ "label": "above", "pid": sleeper.id(), "wake": false }),
            )
            .unwrap(),
        )
        .unwrap();
    let hold = r._home.join("git-held");
    let release = r._home.join("git-release");
    let script = barrier_script("remove", &hold, &release, "");
    let wrote = std::thread::scope(|scope| {
        let late = scope.spawn(|| {
            wait_file(&hold);
            // Git is about to remove the folder; a writer by the old path.
            let status = std::process::Command::new("sh")
                .arg("-c")
                .arg("echo late > \"$1/late.txt\"")
                .arg("sh")
                .arg(&name)
                .current_dir(&above)
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            fs::write(&release, "release").unwrap();
            status.success()
        });
        with_git_wrapper(&r._home, &script, || {
            sweep_checked(&svc, &store, &checks()).unwrap()
        });
        late.join().unwrap()
    });
    assert!(!wrote, "a write by the old path must not reach the folder");
    assert!(sleeper.try_wait().unwrap().is_none(), "nothing was stopped");
    removed_for_real(&store, &r);
    assert!(!Path::new(&above).join(&name).exists());
    kill(std::slice::from_mut(&mut sleeper));
}

#[test]
fn a_terminal_above_the_checkout_neither_blocks_its_removal_nor_reaches_it() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let store = Store::default();
    let above = above_of(&r);
    let name = name_of(&r);
    terminal(&svc, "term-above", &above, None).unwrap();
    let typed = r._home.join("typed");
    let hold = r._home.join("git-held");
    let release = r._home.join("git-release");
    let script = barrier_script("remove", &hold, &release, "");
    let spawned = std::thread::scope(|scope| {
        let late = scope.spawn(|| {
            wait_file(&hold);
            // The shell types a write by the old path, and another terminal
            // is opened at the folder above: neither is refused or stopped.
            crate::pty::pty_write_impl(
                &svc.ptys,
                "term-above".into(),
                format!(
                    "echo late > {name}/late.txt; echo done > '{}'\n",
                    typed.display()
                ),
            )
            .unwrap();
            wait_file(&typed);
            let spawned = terminal(&svc, "term-late", &above, None);
            fs::write(&release, "release").unwrap();
            spawned
        });
        with_git_wrapper(&r._home, &script, || {
            sweep_checked(&svc, &store, &checks()).unwrap()
        });
        late.join().unwrap()
    });
    spawned.expect("a terminal started during a removal is not refused");
    removed_for_real(&store, &r);
    assert!(!Path::new(&above).join(&name).exists());
    assert_eq!(svc.ptys.shell_pids().len(), 2, "no terminal was stopped");
    crate::pty::pty_close_impl(&svc.ptys, "term-above".into()).unwrap();
    crate::pty::pty_close_impl(&svc.ptys, "term-late".into()).unwrap();
}

#[test]
fn a_writer_holding_a_file_or_folder_inside_follows_the_move_and_keeps_the_folder() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let store = Store::default();
    let hold = r._home.join("git-held");
    let release = r._home.join("git-release");
    let ready = r._home.join("holder-ready");
    let script = barrier_script("move", &hold, &release, "");
    let file = format!("{}/work", r.work);
    let mut holders = std::thread::scope(|scope| {
        let late = scope.spawn(|| {
            wait_file(&hold);
            // Before the move: one holds a file inside open, one has the
            // folder as its working folder. Both are past every path check.
            let reader = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!(
                    "exec 3<'{file}'; touch '{}'; exec sleep 60",
                    ready.display()
                ))
                .spawn()
                .unwrap();
            let sitter = std::process::Command::new("sleep")
                .arg("60")
                .current_dir(&r.work)
                .spawn()
                .unwrap();
            wait_file(&ready);
            fs::write(&release, "release").unwrap();
            vec![reader, sitter]
        });
        with_git_wrapper(&r._home, &script, || {
            sweep_checked(&svc, &store, &checks()).unwrap()
        });
        late.join().unwrap()
    });
    let kept = report(&store);
    assert!(
        kept.failed
            .iter()
            .any(|f| f.path == r.work && f.why.contains("holds") && f.why.contains("put back")),
        "{:?}",
        kept.failed
    );
    assert!(Path::new(&r.work).join("work").exists());
    assert!(leftovers(&r).is_empty());
    assert_eq!(records(), 0);
    // Git's own record followed the folder both ways.
    assert_eq!(
        git::text(&r.work, &["rev-parse", "--show-toplevel"]).unwrap(),
        r.work
    );
    kill(&mut holders);
    sweep_checked(&svc, &store, &checks()).unwrap();
    removed_for_real(&store, &r);
}

#[test]
fn a_process_that_makes_the_old_path_again_is_never_deleted_or_merged_into() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let store = Store::default();
    let hold = r._home.join("git-held");
    let release = r._home.join("git-release");
    let script = barrier_script("remove", &hold, &release, "");
    let original = r.work.clone();
    std::thread::scope(|scope| {
        let late = scope.spawn(|| {
            wait_file(&hold);
            // `mkdir -p` by the old path, then a file in it.
            fs::create_dir_all(Path::new(&original).join("sub")).unwrap();
            fs::write(Path::new(&original).join("sub/kept.txt"), "mine").unwrap();
            fs::write(&release, "release").unwrap();
        });
        with_git_wrapper(&r._home, &script, || {
            sweep_checked(&svc, &store, &checks()).unwrap()
        });
        late.join().unwrap();
    });
    // The quarantine was removed (its proof passed) and the new folder stands.
    assert!(leftovers(&r).is_empty());
    assert_eq!(records(), 0);
    assert_eq!(
        fs::read_to_string(Path::new(&r.work).join("sub/kept.txt")).unwrap(),
        "mine"
    );
    assert!(
        !Path::new(&r.work).join("work").exists(),
        "the old files went"
    );
    let done = report(&store);
    assert_eq!(done.removed.len(), 1);
    assert!(
        done.failed
            .iter()
            .any(|f| f.path == r.work && f.why.contains("made") && f.why.contains("again")),
        "{:?}",
        done.failed
    );
}

fn a_late_change_goes_back(change: &str) {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let store = Store::default();
    let hold = r._home.join("git-held");
    let release = r._home.join("git-release");
    // Written just before Git moves the folder: after every earlier check.
    let before = change.replace("{work}", &r.work).replace("{root}", &r.root);
    let script = barrier_script("move", &hold, &release, &before);
    std::thread::scope(|scope| {
        let late = scope.spawn(|| {
            wait_file(&hold);
            fs::write(&release, "release").unwrap();
        });
        with_git_wrapper(&r._home, &script, || {
            sweep_checked(&svc, &store, &checks()).unwrap()
        });
        late.join().unwrap();
    });
    let kept = report(&store);
    assert!(
        kept.failed
            .iter()
            .any(|f| f.path == r.work && f.why.contains("put back")),
        "{change}: {:?}",
        kept.failed
    );
    assert!(
        Path::new(&r.work).join("work").exists(),
        "{change}: {:?}",
        kept.failed
    );
    assert!(leftovers(&r).is_empty() && records() == 0);
}

#[test]
fn a_late_write_to_a_tracked_file_is_seen_in_the_quarantine_and_the_folder_goes_back() {
    a_late_change_goes_back("echo late >> '{work}/work'");
}

#[test]
fn a_late_untracked_file_is_seen_in_the_quarantine_and_the_folder_goes_back() {
    a_late_change_goes_back("echo late > '{work}/new-file'");
}

/// Git's own non-force removal refuses a tracked or untracked change, so the
/// two tests above would pass with the repeated proof switched off. An ignored
/// file under `works/` is deleted by Git without a word: only the proof on the
/// quarantine path sees it.
#[test]
fn a_late_ignored_file_that_only_the_repeated_proof_sees_sends_the_folder_back() {
    a_late_change_goes_back(
        "echo 'works/' >> '{root}/.git/info/exclude'; mkdir -p '{work}/works'; echo late > '{work}/works/clip'",
    );
}

/// Git moves INTO a folder that is there already. The original path made again
/// in the gap before the folder is put back must not lose or merge anything.
#[test]
fn a_path_made_again_just_before_the_move_back_is_reported_with_where_the_folder_went() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let store = Store::default();
    let flag = r._home.join("first-move-seen");
    // The first move (aside) is preceded by a late write, so the proof sends
    // the folder back; the second (back) finds the old path made again.
    let script = format!(
        r#"
case " $* " in
  *" worktree move "*)
    if test ! -f '{flag}'; then
      touch '{flag}'
      echo late >> '{work}/work'
    else
      mkdir -p '{work}'
    fi
    ;;
esac
exec /usr/bin/git "$@"
"#,
        flag = flag.display(),
        work = r.work
    );
    with_git_wrapper(&r._home, &script, || {
        sweep_checked(&svc, &store, &checks()).unwrap()
    });
    let kept = report(&store);
    let nested = leftovers(&r);
    assert!(
        kept.failed
            .iter()
            .any(|f| f.path == r.work && f.why.contains("made again") && f.why.contains(PREFIX)),
        "{:?}",
        kept.failed
    );
    // Nothing is lost: the checkout is inside the recreated folder, intact.
    assert!(
        Path::new(&r.work).read_dir().unwrap().flatten().any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with(PREFIX)
            && e.path().join("work").exists()),
        "{nested:?}"
    );
    assert_eq!(records(), 0);
}

#[test]
fn a_move_that_fails_or_a_taken_quarantine_name_keeps_the_folder_in_words() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let store = Store::default();
    // A different volume (EXDEV), a locked worktree, or Windows refusing the
    // rename for an open handle all reach us as Git failing the move. There
    // is no second volume here, so Git's answer is stood in for.
    let script = r#"
case " $* " in
  *" worktree move "*)
    echo "fatal: failed to move: Invalid cross-device link" >&2
    exit 128
    ;;
esac
exec /usr/bin/git "$@"
"#;
    with_git_wrapper(&r._home, script, || {
        sweep_checked(&svc, &store, &checks()).unwrap()
    });
    let kept = report(&store);
    assert!(
        kept.failed.iter().any(|f| f.path == r.work
            && f.why.contains("could not be moved aside")
            && f.why.contains("cross-device")),
        "{:?}",
        kept.failed
    );
    assert!(Path::new(&r.work).join("work").exists());
    assert!(leftovers(&r).is_empty() && records() == 0);
    // An occupied name is kept and never overwritten.
    quarantine::NEXT_ID.with(|id| *id.borrow_mut() = Some("0123456789abcdef".into()));
    let taken = Path::new(&above_of(&r)).join(format!("{PREFIX}0123456789abcdef"));
    fs::create_dir_all(&taken).unwrap();
    fs::write(taken.join("theirs"), "not ours").unwrap();
    sweep_checked(&svc, &store, &checks()).unwrap();
    let kept = report(&store);
    assert!(
        kept.failed
            .iter()
            .any(|f| f.path == r.work && f.why.contains("is taken")),
        "{:?}",
        kept.failed
    );
    assert_eq!(
        fs::read_to_string(taken.join("theirs")).unwrap(),
        "not ours"
    );
    assert!(Path::new(&r.work).join("work").exists());
    // The safe control: with both out of the way it is really removed.
    fs::remove_dir_all(&taken).unwrap();
    sweep_checked(&svc, &store, &checks()).unwrap();
    removed_for_real(&store, &r);
}

#[test]
fn a_quarantine_left_by_a_killed_server_is_put_back_or_kept_never_removed() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let parent = above_of(&r);
    let record = |id: &str| Record {
        id: id.into(),
        repo: r.root.clone(),
        original: r.work.clone(),
        quarantine: format!("{parent}/{PREFIX}{id}"),
        at: now(),
    };
    let recover = || {
        let mut sweep = Sweep::default();
        quarantine::recover(&svc, &mut sweep).unwrap();
        sweep
    };
    // Killed after the rename and Git's update: put back.
    let a = record("aaaaaaaaaaaaaaaa");
    quarantine::write_record(&a).unwrap();
    git::move_worktree(&r.root, &r.work, &a.quarantine).unwrap();
    let said = recover();
    assert!(
        said.failed.iter().any(|f| f.why.contains("put back")),
        "{:?}",
        said.failed
    );
    assert!(Path::new(&r.work).join("work").exists());
    assert!(!Path::new(&a.quarantine).exists());
    assert_eq!(records(), 0);
    assert_eq!(
        git::text(&r.work, &["rev-parse", "--show-toplevel"]).unwrap(),
        r.work
    );
    // Killed between the rename and Git's update: Git is re-linked, then back.
    let b = record("bbbbbbbbbbbbbbbb");
    quarantine::write_record(&b).unwrap();
    fs::rename(&r.work, &b.quarantine).unwrap();
    recover();
    assert!(Path::new(&r.work).join("work").exists());
    assert_eq!(records(), 0);
    assert_eq!(
        git::text(&r.work, &["rev-parse", "--show-toplevel"]).unwrap(),
        r.work
    );
    // Both exist: neither is touched, and it is said.
    let c = record("cccccccccccccccc");
    quarantine::write_record(&c).unwrap();
    git::move_worktree(&r.root, &r.work, &c.quarantine).unwrap();
    fs::create_dir_all(&r.work).unwrap();
    fs::write(Path::new(&r.work).join("theirs"), "new").unwrap();
    let said = recover();
    assert!(
        said.failed.iter().any(|f| f.why.contains("both")),
        "{:?}",
        said.failed
    );
    assert!(Path::new(&c.quarantine).join("work").exists());
    assert_eq!(
        fs::read_to_string(Path::new(&r.work).join("theirs")).unwrap(),
        "new"
    );
    assert_eq!(records(), 1, "the record stays while it is unresolved");
    // The new folder goes away: the next pass puts the quarantine back.
    fs::remove_dir_all(&r.work).unwrap();
    recover();
    assert!(Path::new(&r.work).join("work").exists());
    assert_eq!(records(), 0);
    // A record for a folder that is gone (removed, then killed) is dropped,
    // and one that names a folder this host would not make is refused.
    quarantine::write_record(&record("dddddddddddddddd")).unwrap();
    recover();
    assert_eq!(records(), 0);
    let mut odd = record("eeeeeeeeeeeeeeee");
    odd.quarantine = format!("{parent}/elsewhere");
    fs::create_dir_all(&odd.quarantine).unwrap();
    quarantine::write_record(&odd).unwrap();
    let said = recover();
    assert!(
        said.failed
            .iter()
            .any(|f| f.why.contains("would not have made")),
        "{:?}",
        said.failed
    );
    assert!(Path::new(&odd.quarantine).exists());
    fs::remove_dir_all(&odd.quarantine).unwrap();
    fs::remove_file(
        crate::profile::profile_dir().join("lifespan-quarantine/eeeeeeeeeeeeeeee.json"),
    )
    .unwrap();
    // The safe control: a plain sweep still removes it.
    let store = Store::default();
    sweep_checked(&svc, &store, &checks()).unwrap();
    removed_for_real(&store, &r);
}

#[test]
fn a_move_back_never_overwrites_a_path_that_was_made_again() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let store = Store::default();
    let hold = r._home.join("git-held");
    let release = r._home.join("git-release");
    let ready = r._home.join("holder-ready");
    let file = format!("{}/work", r.work);
    // A holder inside forces the folder back; the old path is made again
    // while it is away, so it cannot go back.
    let script = format!(
        r#"
case " $* " in
  *" worktree move "*)
    touch '{hold}'
    while test ! -f '{release}'; do sleep 0.01; done
    /usr/bin/git "$@"
    rc=$?
    /bin/mkdir -p '{work}'
    exit $rc
    ;;
esac
exec /usr/bin/git "$@"
"#,
        hold = hold.display(),
        release = release.display(),
        work = r.work
    );
    let mut holders = std::thread::scope(|scope| {
        let late = scope.spawn(|| {
            wait_file(&hold);
            let reader = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!(
                    "exec 3<'{file}'; touch '{}'; exec sleep 60",
                    ready.display()
                ))
                .spawn()
                .unwrap();
            wait_file(&ready);
            fs::write(&release, "release").unwrap();
            vec![reader]
        });
        with_git_wrapper(&r._home, &script, || {
            sweep_checked(&svc, &store, &checks()).unwrap()
        });
        late.join().unwrap()
    });
    let kept = report(&store);
    assert!(
        kept.failed.iter().any(|f| f.path == r.work
            && f.why.contains("could not be put back")
            && f.why.contains("was made again")),
        "{:?}",
        kept.failed
    );
    let left = leftovers(&r);
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(Path::new(&above_of(&r))
        .join(&left[0])
        .join("work")
        .exists());
    assert!(Path::new(&r.work).exists() && !Path::new(&r.work).join("work").exists());
    assert_eq!(records(), 1);
    kill(&mut holders);
}

#[test]
fn a_slow_lsof_ends_in_unknown_inside_the_final_budget_and_the_folder_goes_back() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, _svc) = merged_checkout();
    let proof = validation_removal_proof(&r.work).unwrap().unwrap();
    // An lsof that takes far longer than the whole budget.
    let slow = r._home.join("slow-lsof");
    fs::write(&slow, "#!/bin/sh\nsleep 60\n").unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&slow, fs::Permissions::from_mode(0o700)).unwrap();
    }
    TEST_LSOF.with(|p| *p.borrow_mut() = Some(slow));
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            TEST_LSOF.with(|p| *p.borrow_mut() = None);
        }
    }
    let reset = Reset;
    let started = std::time::Instant::now();
    let why = {
        let _budget = git::FinalBudget::with_timeout(Duration::from_secs(4));
        remove_proven(&r.root, &r.work, &proof).unwrap_err()
    };
    assert!(
        started.elapsed() < Duration::from_secs(9),
        "{:?}",
        started.elapsed()
    );
    assert!(
        why.contains("could not be read") && why.contains("put back"),
        "{why}"
    );
    assert!(Path::new(&r.work).join("work").exists());
    assert!(leftovers(&r).is_empty() && records() == 0);
    assert_eq!(
        git::text(&r.work, &["rev-parse", "--show-toplevel"]).unwrap(),
        r.work
    );
    // Control: with the real lsof the same proof removes it.
    drop(reset);
    remove_proven(&r.root, &r.work, &proof).unwrap();
    assert!(gone(&r.work));
}

#[test]
fn a_sweep_puts_a_crashed_validation_quarantine_back_before_it_records_anything_swept() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    svc.orchestrations
        .install_validation_for_test(&r.root, vec![r.work.clone()]);
    let record = Record {
        id: "aaaaaaaaaaaaaaaa".into(),
        repo: r.root.clone(),
        original: r.work.clone(),
        quarantine: format!("{}/{PREFIX}aaaaaaaaaaaaaaaa", above_of(&r)),
        at: now(),
    };
    let crash = || {
        quarantine::write_record(&record).unwrap();
        git::move_worktree(&r.root, &r.work, &record.quarantine).unwrap();
    };
    // Killed after the rename: the folder is aside, not gone. The sweep puts
    // it back first, so the validation checkout is still the ledger's.
    crash();
    reconcile(&svc, &Store::default(), now(), &mut Sweep::default()).unwrap();
    assert!(Path::new(&r.work).join("work").exists());
    assert_eq!(
        svc.orchestrations.validation_paths_for_test(),
        [r.work.clone()]
    );
    assert_eq!(records(), 0);
    // It cannot be put back (Git refuses the move): the original is missing
    // and a record names the folder, so it is still not "gone".
    crash();
    let script = r#"
case " $* " in
  *" worktree move "*) echo "fatal: refused" >&2; exit 128 ;;
esac
exec /usr/bin/git "$@"
"#;
    with_git_wrapper(&r._home, script, || {
        reconcile(&svc, &Store::default(), now(), &mut Sweep::default()).unwrap();
    });
    assert!(!Path::new(&r.work).exists());
    assert!(Path::new(&record.quarantine).join("work").exists());
    assert_eq!(
        svc.orchestrations.validation_paths_for_test(),
        [r.work.clone()]
    );
    assert_eq!(records(), 1, "the record stays while it is unresolved");
    // Safe control: with Git working again the next pass puts it back.
    reconcile(&svc, &Store::default(), now(), &mut Sweep::default()).unwrap();
    assert!(Path::new(&r.work).join("work").exists());
    assert_eq!(records(), 0);
}

#[test]
fn a_quarantine_name_made_between_the_check_and_the_move_does_not_strand_the_record() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let store = Store::default();
    // Someone makes the name after it was found free: Git then moves the
    // checkout INTO it. The removal follows the real path, deletes nothing
    // of theirs, and leaves no record naming a folder that is not the checkout.
    quarantine::BEFORE_MOVE.with(|hook| {
        *hook.borrow_mut() = Some(|q| fs::create_dir_all(q).unwrap());
    });
    sweep_checked(&svc, &store, &checks()).unwrap();
    let kept = report(&store);
    assert!(gone(&r.work), "{:?}", kept.failed);
    assert_eq!(kept.removed.len(), 1, "{:?}", kept.failed);
    assert_eq!(records(), 0);
    let made = leftovers(&r);
    assert_eq!(made.len(), 1, "their folder stays: {made:?}");
    assert!(Path::new(&above_of(&r))
        .join(&made[0])
        .read_dir()
        .unwrap()
        .next()
        .is_none());
}

#[test]
fn a_record_that_names_the_checkout_inside_a_folder_made_first_is_put_back_from_there() {
    let home = crate::profile::tests::Home::with_a_configured_base();
    let _profile = crate::profile::started_in(&home.dir);
    crate::profile::available().unwrap();
    let (r, svc) = merged_checkout();
    let q = format!("{}/{PREFIX}bbbbbbbbbbbbbbbb", above_of(&r));
    fs::create_dir_all(&q).unwrap();
    let nested = format!("{q}/{}", name_of(&r));
    git::move_worktree(&r.root, &r.work, &nested).unwrap();
    quarantine::write_record(&Record {
        id: "bbbbbbbbbbbbbbbb".into(),
        repo: r.root.clone(),
        original: r.work.clone(),
        quarantine: nested.clone(),
        at: now(),
    })
    .unwrap();
    quarantine::recover(&svc, &mut Sweep::default()).unwrap();
    assert!(Path::new(&r.work).join("work").exists());
    assert!(
        Path::new(&q).exists(),
        "the folder someone made is not deleted"
    );
    assert_eq!(records(), 0);
}
