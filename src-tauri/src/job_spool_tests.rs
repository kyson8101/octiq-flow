//! The spool folder (`job_spool.rs`): what a record must carry to count,
//! how a file is read on, and when files and folders go.
use super::*;
use crate::bus::tap::Tap;
use crate::test_dir::TestDir;
use std::cell::Cell;

struct Scene {
    _dir: TestDir,
    store: Store,
    spools: Spools,
}

fn scene() -> Scene {
    let dir = TestDir::new("job-spool-scene");
    Scene {
        store: Store::load(dir.join("jobs.json")),
        spools: Spools::at(dir.join("spool")),
        _dir: dir,
    }
}

fn chat() -> String {
    format!("chat:spool-test-{}", uuid::Uuid::new_v4().simple())
}

/// A launch's folder and secret, as its agent is given them.
fn open(scene: &Scene, chat: &str) -> (PathBuf, String) {
    let env: BTreeMap<String, String> = scene
        .spools
        .open(chat, chat, &uuid::Uuid::new_v4().to_string())
        .into_iter()
        .collect();
    (PathBuf::from(&env[SPOOL_ENV]), env[KEY_ENV].clone())
}

fn pass(scene: &Scene, live: bool, alive: bool) {
    scene.spools.pass(&scene.store, &|_, _| live, &|_| alive);
}

fn line(key: &str, kind: &str, fields: Value) -> String {
    let mut record = fields;
    record["key"] = json!(key);
    record["type"] = json!(kind);
    format!("{record}\n")
}

fn start(key: &str) -> String {
    line(
        key,
        "start",
        json!({ "label": "render\nfinal", "command": "sh -c x", "wake": false, "wrapperPid": 1 }),
    )
}

fn progress(key: &str, done: u32) -> String {
    line(
        key,
        "progress",
        json!({ "done": done, "total": 5, "unit": "items" }),
    )
}

fn end(key: &str, code: i32) -> String {
    line(key, "end", json!({ "exitCode": code, "tail": ["5/5"] }))
}

fn append(path: &Path, text: &str) {
    use std::io::Write as _;
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap()
        .write_all(text.as_bytes())
        .unwrap();
}

fn file_in(dir: &Path) -> PathBuf {
    dir.join(format!("{}.ndjson", uuid::Uuid::new_v4().simple()))
}

fn chat_jobs_heard(tap: &Tap) -> Vec<Value> {
    tap.heard()
        .into_iter()
        .filter(|(event, _)| event == "chat-job")
        .map(|(_, payload)| payload)
        .collect()
}

fn jobs_of(scene: &Scene, chat: &str) -> Vec<Value> {
    scene.store.list(Some(chat)).unwrap()
}

/// The launch's cursor of one file, for what the host noted of it.
fn cursor_logged(scene: &Scene, dir: &Path, file: &Path) -> bool {
    let name = dir.file_name().unwrap().to_string_lossy().into_owned();
    let launches = scene.spools.launches.lock().unwrap();
    let launch = launches[&name].lock().unwrap();
    let file = file.file_name().unwrap().to_string_lossy().into_owned();
    launch.files[&file].logged
}

#[test]
fn a_spooled_job_starts_moves_and_ends_through_the_store_and_its_file_goes() {
    let scene = scene();
    let chat = chat();
    let tap = Tap::on(&chat);
    let (dir, key) = open(&scene, &chat);
    let file = file_in(&dir);
    append(&file, &(start(&key) + &progress(&key, 2)));
    pass(&scene, true, true);
    let jobs = jobs_of(&scene, &chat);
    assert_eq!(jobs.len(), 1);
    let job = &jobs[0];
    assert_eq!(job["status"], "running");
    assert_eq!(job["source"], "wrapper");
    // The label is made one line, as the hook makes it.
    assert_eq!(job["label"], "render final");
    assert_eq!(
        (job["done"].clone(), job["total"].clone()),
        (json!(2.0), json!(5.0))
    );
    // The host's id, not the file's: the answer the wrapper waits for names it.
    let stem = file.file_stem().unwrap().to_string_lossy().into_owned();
    assert_ne!(job["id"], json!(stem));
    let answer: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{stem}.ack"))).unwrap())
            .unwrap();
    assert_eq!(answer["id"], job["id"]);
    // Nothing over the hook speaks for a spooled job: it has no token.
    let id = job["id"].as_str().unwrap();
    assert!(scene.store.progress(id, "", Progress::default()).is_err());
    assert!(
        scene.store.has_running(&chat),
        "it holds the idle reaper off"
    );

    append(&file, &end(&key, 3));
    pass(&scene, true, true);
    let job = &jobs_of(&scene, &chat)[0];
    assert_eq!(job["status"], "failed");
    assert_eq!(job["exitCode"], 3);
    assert!(!file.exists(), "an end taken and saved removes its file");
    assert!(
        dir.join(format!("{stem}.ack")).exists(),
        "its answer waits for --detach"
    );
    assert!(chat_jobs_heard(&tap).len() >= 2);

    // The launch's process is gone; the answer has been there its time.
    pass(&scene, false, true);
    assert!(dir.exists(), "the answer is still kept");
    {
        let launches = scene.spools.launches.lock().unwrap();
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        for cursor in launches[&name].lock().unwrap().files.values_mut() {
            cursor.ack_at = Some(Instant::now() - ACK_KEEP);
        }
    }
    pass(&scene, false, true);
    assert!(!dir.exists(), "a launch that is over leaves no folder");
    assert!(
        scene.spools.launches.lock().unwrap().is_empty(),
        "nor a secret"
    );
}

#[test]
fn a_record_with_no_key_a_forged_key_or_another_launchs_key_changes_nothing() {
    let scene = scene();
    let (mine, other) = (chat(), chat());
    let (dir, key) = open(&scene, &mine);
    let (other_dir, other_key) = open(&scene, &other);
    for (what, text) in [
        ("no key", start("").replace("\"key\":\"\",", "")),
        ("forged", start("0123456789abcdef0123456789abcdef")),
        ("another launch's", start(&other_key)),
    ] {
        let file = file_in(&dir);
        // Each refused start is followed by records that would move a job.
        append(&file, &(text + &progress(&key, 1) + &end(&key, 0)));
        pass(&scene, true, true);
        assert!(jobs_of(&scene, &mine).is_empty(), "{what}");
        assert!(
            jobs_of(&scene, &other).is_empty(),
            "{what}: not the other chat's either"
        );
        assert!(cursor_logged(&scene, &dir, &file), "{what}: logged");
        assert!(file.exists(), "{what}: a launch still running keeps it");
    }
    // The folder a record is in is not what names its chat: the other
    // launch's own secret in this launch's folder is still refused.
    let file = file_in(&dir);
    append(&file, &start(&other_key));
    pass(&scene, true, true);
    assert!(jobs_of(&scene, &other).is_empty());
    // And its own folder takes it.
    append(&file_in(&other_dir), &start(&other_key));
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &other).len(), 1);
}

#[test]
fn a_malformed_line_is_skipped_and_the_lines_around_it_count() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let file = file_in(&dir);
    let long = format!("{}\n", "x".repeat(LINE_MAX + 10));
    append(
        &file,
        &format!(
            "{}not json\n{}\n[1,2]\n{long}{}",
            start(&key),
            "{\"key\":", // cut short
            line(&key, "what", json!({}))
        ),
    );
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &chat).len(), 1);
    append(&file, &format!("{{oops\n{}", progress(&key, 4)));
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &chat)[0]["done"], 4.0);

    // A file is the launch's by its first line: one that opens with
    // anything else is refused whole, whatever follows.
    let other = file_in(&dir);
    append(&other, &format!("not json\n{}", start(&key)));
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &chat).len(), 1);
    assert!(cursor_logged(&scene, &dir, &other));
    assert!(other.exists(), "a refused file is never removed");
}

#[test]
fn a_last_line_with_no_newline_yet_is_waited_for() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let file = file_in(&dir);
    let whole = start(&key);
    let (first, rest) = whole.split_at(whole.len() / 2);
    append(&file, first);
    pass(&scene, true, true);
    assert!(
        jobs_of(&scene, &chat).is_empty(),
        "half a record is not one"
    );
    append(&file, rest);
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &chat).len(), 1);

    // A line still being written that is already too long to be a record
    // is skipped to its newline, not held for ever.
    append(&file, &"y".repeat(LINE_MAX + 1));
    pass(&scene, true, true);
    append(&file, &format!("yyy\n{}", progress(&key, 3)));
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &chat)[0]["done"], 3.0);
}

#[test]
fn reading_a_file_again_from_where_it_stopped_or_from_its_start_makes_no_second_event() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let file = file_in(&dir);
    append(&file, &(start(&key) + &progress(&key, 1)));
    pass(&scene, true, true);
    let tap = Tap::on(&chat);
    // Passes with nothing new say nothing.
    pass(&scene, true, true);
    pass(&scene, true, true);
    assert_eq!(chat_jobs_heard(&tap).len(), 0);

    // The reader loses its place (the file was cut, or its offset is gone)
    // and reads the file from the top: the start makes no second job.
    {
        let launches = scene.spools.launches.lock().unwrap();
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        for cursor in launches[&name].lock().unwrap().files.values_mut() {
            cursor.offset = 0;
        }
    }
    append(&file, &end(&key, 0));
    pass(&scene, true, true);
    let jobs = jobs_of(&scene, &chat);
    assert_eq!(jobs.len(), 1, "one job");
    assert_eq!(jobs[0]["status"], "done");
    let ends = chat_jobs_heard(&tap)
        .iter()
        .filter(|p| p["job"]["status"] == "done")
        .count();
    assert_eq!(ends, 1, "one end");

    // A server that starts again holds no secret of the old one's: its
    // reader reads nothing of what is left.
    let again = Spools::at(scene.spools.root.as_ref().unwrap().path.clone());
    let left = file_in(&dir);
    append(&left, &start(&key));
    again.pass(&scene.store, &|_, _| true, &|_| true);
    assert_eq!(jobs_of(&scene, &chat).len(), 1);
}

#[cfg(unix)]
#[test]
fn a_file_that_cannot_be_read_stays_and_is_read_when_it_can_be() {
    use std::os::unix::fs::PermissionsExt;
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let file = file_in(&dir);
    append(&file, &start(&key));
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::File::open(&file).is_ok() {
        // Run as root: nothing is unreadable.
        return;
    }
    pass(&scene, false, true);
    pass(&scene, false, true);
    assert!(jobs_of(&scene, &chat).is_empty());
    assert!(file.exists(), "not dropped");
    assert!(
        dir.exists(),
        "nor its launch's folder, though the launch is over"
    );
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    pass(&scene, false, true);
    assert_eq!(jobs_of(&scene, &chat).len(), 1);
}

#[test]
fn a_wrapper_that_died_without_an_end_is_interrupted_only_once_its_file_is_read() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let file = file_in(&dir);
    append(&file, &start(&key));
    pass(&scene, true, true);
    // The pid watch leaves a spooled job to its reader.
    scene.store.look(&|_| false);
    assert_eq!(jobs_of(&scene, &chat)[0]["status"], "running");
    // It wrote its end and died between two passes: the end is read, not
    // taken for an interruption.
    append(&file, &end(&key, 0));
    pass(&scene, true, false);
    assert_eq!(jobs_of(&scene, &chat)[0]["status"], "done");

    let other = file_in(&dir);
    append(&other, &start(&key));
    pass(&scene, true, true);
    let alive = Cell::new(false);
    scene
        .spools
        .pass(&scene.store, &|_, _| true, &|_| alive.get());
    let interrupted = jobs_of(&scene, &chat)
        .into_iter()
        .filter(|job| job["status"] == "interrupted")
        .count();
    assert_eq!(interrupted, 1);
    assert!(!other.exists());
}

#[test]
fn a_refused_start_is_answered_and_what_follows_it_says_nothing() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    for _ in 0..32 {
        append(&file_in(&dir), &start(&key));
    }
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &chat).len(), 32);
    let file = file_in(&dir);
    append(&file, &(start(&key) + &end(&key, 0)));
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &chat).len(), 32, "the store's own limit");
    let stem = file.file_stem().unwrap().to_string_lossy().into_owned();
    let answer: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join(format!("{stem}.ack"))).unwrap())
            .unwrap();
    assert!(
        answer["why"].as_str().unwrap().contains("32 jobs"),
        "{answer}"
    );
    assert!(!file.exists());
}

#[test]
fn the_wrappers_writer_writes_what_the_reader_reads() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let mut writer = Writer::create(&dir, &key).unwrap();
    assert!(writer.record("start", json!({ "label": "build", "wake": false })));
    assert!(writer.record("progress", json!({ "done": 1, "total": 2 })));
    assert!(writer.record("end", json!({ "exitCode": 0, "tail": [] })));
    pass(&scene, true, true);
    let job = &jobs_of(&scene, &chat)[0];
    assert_eq!(job["status"], "done");
    assert_eq!(job["exitCode"], 0);
    assert_eq!(
        wait_answer(&writer.answer_path(), Duration::from_millis(10)).unwrap()["id"],
        job["id"]
    );
    // A second writer never takes a file that is there.
    let env = |name: &str| match name {
        SPOOL_ENV => Some(dir.to_string_lossy().into_owned()),
        KEY_ENV => Some(key.clone()),
        _ => None,
    };
    assert_eq!(Writer::from_env(&env), Some((dir.clone(), key.clone())));
    assert_eq!(Writer::from_env(&|_| None), None);
}

#[cfg(unix)]
#[test]
fn a_gone_servers_folders_are_swept_and_a_live_ones_are_kept() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TestDir::new("job-spool-sweep");
    let mode = |path: &Path, mode: u32| {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap()
    };
    let stem = "0123456789abcdef0123456789abcdef";
    for name in ["111-a", "222-b", "333-c", "444-d", "666-f", "junk"] {
        std::fs::create_dir(dir.join(name)).unwrap();
        mode(&dir.join(name), 0o700);
        append(&dir.join(name).join(format!("{stem}.ndjson")), "x\n");
        append(&dir.join(name).join(format!("{stem}.ack")), "{}");
    }
    // A gone server's folder holding something a launch never writes keeps
    // it, and so stays.
    append(&dir.join("444-d").join("notes.txt"), "keep");
    // One that is not 0700 is not taken for ours.
    mode(&dir.join("666-f"), 0o755);
    // A link under a launch file's name in a gone server's folder is left,
    // and so is the folder.
    std::fs::create_dir(dir.join("777-g")).unwrap();
    mode(&dir.join("777-g"), 0o700);
    let target = dir.join("777-target");
    append(&target, "target");
    std::os::unix::fs::symlink(&target, dir.join("777-g").join(format!("{stem}.ndjson"))).unwrap();
    // A link in a server's place: what it points at is never touched.
    let outside = TestDir::new("job-spool-sweep-outside");
    let canary = outside.join(format!("{stem}.ndjson"));
    append(&canary, "canary");
    std::os::unix::fs::symlink(&*outside, dir.join("555-e")).unwrap();

    let root = Folder::adopt(&dir).unwrap();
    sweep(&root, 333, &|pid| pid == 222);
    assert!(!dir.join("111-a").exists());
    assert!(
        dir.join("222-b").join(format!("{stem}.ndjson")).exists(),
        "another live server's"
    );
    assert!(
        dir.join("333-c").join(format!("{stem}.ndjson")).exists(),
        "this one's"
    );
    assert!(dir.join("444-d").join("notes.txt").exists());
    assert!(!dir.join("444-d").join(format!("{stem}.ndjson")).exists());
    assert!(dir.join("666-f").join(format!("{stem}.ndjson")).exists());
    assert!(
        dir.join("junk").join(format!("{stem}.ndjson")).exists(),
        "not a launch's folder"
    );
    assert_eq!(std::fs::read_to_string(&canary).unwrap(), "canary");
    let link = dir.join("777-g").join(format!("{stem}.ndjson"));
    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "target");
}

#[cfg(unix)]
#[test]
fn only_no_such_process_is_a_process_gone() {
    assert!(process_alive(std::process::id()));
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let pid = child.id();
    child.wait().unwrap();
    assert!(!process_alive(pid), "a reaped child is gone");
    // Numbers that name no single process cannot be asked about.
    assert!(process_alive(0));
    // Another user's process (pid 1 is root's): there, though no signal
    // may be sent to it.
    if unsafe { libc::geteuid() } != 0 {
        assert!(process_alive(1));
    }
    assert!(process_alive(u32::MAX));
}

#[cfg(unix)]
#[test]
fn the_folders_are_this_users_alone() {
    use std::os::unix::fs::PermissionsExt;
    let scene = scene();
    let (dir, _) = open(&scene, &chat());
    for path in [&dir, &scene.spools.root.as_ref().unwrap().path] {
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{}", path.display());
    }
    // A link where the root goes is not a folder of ours.
    let other = TestDir::new("job-spool-link");
    let link = other.join("root");
    std::os::unix::fs::symlink(other.join("elsewhere"), &link).unwrap();
    std::fs::create_dir(other.join("elsewhere")).unwrap();
    assert!(Spools::at(link).root.is_none());
}

// Review 3: what the reader did not see is not gone, and files the launch
// did not write cannot take a real job's place.

/// A start that asks for a wake, from a wrapper with a pid.
fn real_start(key: &str) -> String {
    line(
        key,
        "start",
        json!({ "label": "real", "wake": true, "wrapperPid": 123 }),
    )
}

/// A file named by a number, so names sort as the test needs.
fn named(dir: &Path, n: u32) -> PathBuf {
    dir.join(format!("{n:032x}.ndjson"))
}

fn statuses_heard(tap: &Tap) -> Vec<String> {
    chat_jobs_heard(tap)
        .iter()
        .filter_map(|p| p["job"]["status"].as_str().map(str::to_string))
        .collect()
}

/// The wakes the scene's own store owes (it holds one chat's jobs).
fn owed_wakes_of(scene: &Scene) -> usize {
    scene.store.owed_wakes().len()
}

fn cursor_of<T>(scene: &Scene, dir: &Path, file: &Path, read: impl FnOnce(&Cursor) -> T) -> T {
    let name = dir.file_name().unwrap().to_string_lossy().into_owned();
    let launches = scene.spools.launches.lock().unwrap();
    let launch = launches[&name].lock().unwrap();
    let file = file.file_name().unwrap().to_string_lossy().into_owned();
    read(&launch.files[&file])
}

/// The reviewer's case, then the same with the wrapper still alive when the
/// junk lands: 64 files with a wrong secret, named to sort ahead of the real
/// one. The real end is read, once, and the job is never interrupted.
#[test]
fn sixty_four_junk_files_sorted_first_do_not_hide_a_real_jobs_end() {
    for wrapper_alive in [false, true] {
        let scene = scene();
        let chat = chat();
        let tap = Tap::on(&chat);
        let (dir, key) = open(&scene, &chat);
        let file = named(&dir, 0xffff);
        append(&file, &real_start(&key));
        pass(&scene, true, true);
        assert_eq!(jobs_of(&scene, &chat)[0]["status"], "running");
        if wrapper_alive {
            // The junk lands while the wrapper runs, and the reader passes
            // over it before the end is written.
            for i in 0..64 {
                append(&named(&dir, i), &start("wrong"));
            }
            pass(&scene, true, true);
            append(&file, &end(&key, 0));
        } else {
            // As reproduced: the end is written, the junk lands, and the
            // wrapper is dead by the next pass.
            append(&file, &end(&key, 0));
            for i in 0..64 {
                append(&named(&dir, i), &start("wrong"));
            }
        }
        for _ in 0..4 {
            pass(&scene, true, wrapper_alive);
        }
        let jobs = jobs_of(&scene, &chat);
        assert_eq!(jobs.len(), 1, "alive {wrapper_alive}: no job of the junk's");
        assert_eq!(jobs[0]["status"], "done", "alive {wrapper_alive}");
        assert_eq!(jobs[0]["exitCode"], 0, "alive {wrapper_alive}");
        let heard = statuses_heard(&tap);
        assert!(!heard.iter().any(|s| s == "interrupted"), "{heard:?}");
        assert_eq!(heard.iter().filter(|s| *s == "done").count(), 1);
        assert_eq!(owed_wakes_of(&scene), 1, "one wake");
        assert!(!file.exists(), "its end taken, the real file goes");
        for i in 0..64 {
            assert!(named(&dir, i).exists(), "a refused file is never removed");
        }
    }
}

/// A file a listing leaves out (a `readdir` entry that failed) is not
/// gone: only `NotFound` on that very name says so.
#[test]
fn a_file_the_listing_left_out_is_still_read() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let file = named(&dir, 7);
    append(&file, &real_start(&key));
    pass(&scene, true, true);
    let name = file.file_name().unwrap().to_string_lossy().into_owned();
    folder::HIDDEN.with(|hidden| hidden.borrow_mut().insert(name.clone()));
    pass(&scene, true, true);
    append(&file, &end(&key, 0));
    pass(&scene, true, false);
    folder::HIDDEN.with(|hidden| hidden.borrow_mut().remove(&name));
    let job = &jobs_of(&scene, &chat)[0];
    assert_eq!(job["status"], "done");
    assert_eq!(job["exitCode"], 0);
}

/// 200 junk files with whole first lines and a wrong secret, all named
/// ahead of a new real job: the real one is registered within
/// ceil(201 / LOOK_MAX) passes, and the junk is refused once and then only
/// statted.
#[test]
fn two_hundred_junk_files_hold_a_new_real_job_back_a_bounded_number_of_passes() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    for i in 0..200 {
        append(&named(&dir, i), &start("wrong"));
    }
    let file = named(&dir, 0xffff);
    append(&file, &real_start(&key));
    let bound = 201usize.div_ceil(LOOK_MAX);
    let mut passes = 0;
    while jobs_of(&scene, &chat).is_empty() {
        passes += 1;
        assert!(passes <= bound, "not registered within {bound} passes");
        pass(&scene, true, true);
    }
    for _ in 0..3 {
        pass(&scene, true, true);
    }
    for i in 0..200 {
        let opened = cursor_of(&scene, &dir, &named(&dir, i), |c| c.opened);
        assert_eq!(opened, 1, "a refused file is read once");
    }
}

/// Files whose first line never ends wait at the back of the line, so they
/// cannot hold the files behind them for ever: a real job named after 200
/// of them is registered within ceil(201 / LOOK_MAX) + 1 passes.
#[test]
fn files_whose_first_line_never_ends_do_not_starve_a_real_job() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    for i in 0..200 {
        append(&named(&dir, i), "{\"key\":\"still writing");
    }
    let file = named(&dir, 0xffff);
    append(&file, &real_start(&key));
    let bound = 201usize.div_ceil(LOOK_MAX) + 1;
    let mut passes = 0;
    while jobs_of(&scene, &chat).is_empty() {
        passes += 1;
        assert!(passes <= bound, "not registered within {bound} passes");
        pass(&scene, true, true);
    }
    // Not refused: their first line is not whole yet.
    let vetted = cursor_of(&scene, &dir, &named(&dir, 0), |c| c.vetted);
    assert!(matches!(vetted, Vetted::Waiting(_)), "{vetted:?}");
}

/// A refused file that keeps growing stays refused and is never opened
/// again. When the launch is over it is still there: the host drops the
/// secret and leaves the folder that holds it.
#[test]
fn a_growing_junk_file_stays_refused_cheap_and_in_place() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let junk = file_in(&dir);
    append(&junk, &start("wrong"));
    pass(&scene, true, true);
    for n in 0..5 {
        // Even a line that carries the real secret, later in the file.
        append(&junk, &(progress(&key, n) + &"z".repeat(4096) + "\n"));
        pass(&scene, true, true);
    }
    let (vetted, opened) = cursor_of(&scene, &dir, &junk, |c| (c.vetted, c.opened));
    assert!(matches!(vetted, Vetted::Foreign(_)), "{vetted:?}");
    assert_eq!(opened, 1, "looked at once, then only statted");
    assert!(jobs_of(&scene, &chat).is_empty());

    // An answer-named file next to it that the host never wrote.
    let stem = junk.file_stem().unwrap().to_string_lossy().into_owned();
    append(&dir.join(format!("{stem}.ack")), "not the host's");
    // And one beside a file of the launch's that never started, which the
    // host removes when the launch is over: only an answer it wrote goes.
    let unstarted = file_in(&dir);
    append(&unstarted, &progress(&key, 1));
    let other_stem = unstarted
        .file_stem()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    append(
        &dir.join(format!("{other_stem}.ack")),
        "not the host's either",
    );
    pass(&scene, true, true);
    pass(&scene, false, true);
    assert!(!unstarted.exists());
    assert!(dir.join(format!("{other_stem}.ack")).exists());
    assert!(
        scene.spools.launches.lock().unwrap().is_empty(),
        "the launch is over: its secret goes"
    );
    assert!(junk.exists(), "a refused file is never removed");
    assert!(dir.join(format!("{stem}.ack")).exists());
    assert!(dir.exists(), "nor the folder that holds it");
}

/// A refused name that is removed and made again is a new file, and is
/// looked at again.
#[test]
fn a_refused_name_made_again_is_looked_at_again() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let file = file_in(&dir);
    append(&file, &start("wrong"));
    pass(&scene, true, true);
    std::fs::remove_file(&file).unwrap();
    append(&file, &real_start(&key));
    pass(&scene, true, true);
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &chat).len(), 1);
}

// Review 3, B: nothing in a spool folder is followed through a link.

#[cfg(unix)]
fn canary_dir(stem_line: &str) -> (TestDir, PathBuf) {
    let outside = TestDir::new("job-spool-outside");
    let canary = outside.join("0123456789abcdef0123456789abcdef.ndjson");
    append(&canary, stem_line);
    (outside, canary)
}

/// The launch folder swapped for a link to a folder holding a canary: the
/// host reads nothing through it and removes nothing, though the launch is
/// over.
#[cfg(unix)]
#[test]
fn a_launch_folder_swapped_for_a_link_is_left_alone() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let (outside, canary) = canary_dir(&(start(&key) + &end(&key, 0)));
    let moved = dir.with_extension("moved");
    std::fs::rename(&dir, &moved).unwrap();
    std::os::unix::fs::symlink(&*outside, &dir).unwrap();
    for _ in 0..3 {
        pass(&scene, false, true);
    }
    assert!(jobs_of(&scene, &chat).is_empty(), "nothing read through it");
    assert_eq!(
        std::fs::read_to_string(&canary).unwrap(),
        start(&key) + &end(&key, 0)
    );
    assert!(std::fs::symlink_metadata(&dir)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(moved.exists());
    let left = scene.spools.launches.lock().unwrap().len();
    assert_eq!(left, 1, "not taken for a folder that is gone");

    // Another real folder of this user's, 0700, put in its place: not the
    // folder made for the launch, so not read either.
    std::fs::remove_file(&dir).unwrap();
    std::fs::create_dir(&dir).unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    append(&file_in(&dir), &start(&key));
    pass(&scene, true, true);
    assert!(jobs_of(&scene, &chat).is_empty(), "not the launch's folder");
}

/// A spool file replaced by a link to a canary that holds a valid end, and
/// a new name that is a link from the start: neither is read through,
/// neither the link nor its target is removed.
#[cfg(unix)]
#[test]
fn a_spool_file_that_is_a_link_is_never_read_or_removed() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let file = file_in(&dir);
    append(&file, &real_start(&key));
    pass(&scene, true, true);
    let (_outside, canary) = canary_dir(&(real_start(&key) + &end(&key, 0)));
    std::fs::remove_file(&file).unwrap();
    std::os::unix::fs::symlink(&canary, &file).unwrap();
    let fresh = file_in(&dir);
    std::os::unix::fs::symlink(&canary, &fresh).unwrap();
    for _ in 0..3 {
        pass(&scene, true, false);
    }
    let jobs = jobs_of(&scene, &chat);
    assert_eq!(jobs.len(), 1, "the link that is a new name makes no job");
    assert_eq!(
        jobs[0]["status"], "running",
        "the end behind the link is not read"
    );
    for _ in 0..2 {
        pass(&scene, false, false);
    }
    for link in [&file, &fresh] {
        assert!(
            std::fs::symlink_metadata(link)
                .unwrap()
                .file_type()
                .is_symlink(),
            "a link is not removed: {}",
            link.display()
        );
    }
    assert_eq!(
        std::fs::read_to_string(&canary).unwrap(),
        real_start(&key) + &end(&key, 0)
    );
}

/// An answer's name planted as a link to a canary: the answer is written
/// as a new file and renamed over the link's name; the canary is untouched.
#[cfg(unix)]
#[test]
fn an_answer_planted_as_a_link_is_replaced_not_written_through() {
    let scene = scene();
    let chat = chat();
    let (dir, key) = open(&scene, &chat);
    let file = file_in(&dir);
    let stem = file.file_stem().unwrap().to_string_lossy().into_owned();
    let (_outside, canary) = canary_dir("canary");
    let ack = dir.join(format!("{stem}.ack"));
    std::os::unix::fs::symlink(&canary, &ack).unwrap();
    append(&file, &real_start(&key));
    pass(&scene, true, true);
    assert_eq!(std::fs::read_to_string(&canary).unwrap(), "canary");
    assert!(!std::fs::symlink_metadata(&ack)
        .unwrap()
        .file_type()
        .is_symlink());
    let answer: Value = serde_json::from_str(&std::fs::read_to_string(&ack).unwrap()).unwrap();
    assert_eq!(answer["id"], jobs_of(&scene, &chat)[0]["id"]);
}
