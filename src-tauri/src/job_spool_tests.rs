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
            "not json\n{}\n[1,2]\n{long}{}{}",
            "{\"key\":", // cut short
            start(&key),
            line(&key, "what", json!({}))
        ),
    );
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &chat).len(), 1);
    append(&file, &format!("{{oops\n{}", progress(&key, 4)));
    pass(&scene, true, true);
    assert_eq!(jobs_of(&scene, &chat)[0]["done"], 4.0);
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
    let again = Spools::at(scene.spools.root.clone().unwrap());
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

#[test]
fn a_gone_servers_folders_are_swept_and_a_live_ones_are_kept() {
    let dir = TestDir::new("job-spool-sweep");
    for name in ["111-a", "222-b", "333-c", "junk"] {
        std::fs::create_dir(dir.join(name)).unwrap();
    }
    sweep(&dir, 333, &|pid| pid == 222);
    assert!(!dir.join("111-a").exists());
    assert!(dir.join("222-b").exists(), "another live server's");
    assert!(dir.join("333-c").exists(), "this one's");
    assert!(dir.join("junk").exists(), "not a launch's folder");
}

#[cfg(unix)]
#[test]
fn the_folders_are_this_users_alone() {
    use std::os::unix::fs::PermissionsExt;
    let scene = scene();
    let (dir, _) = open(&scene, &chat());
    for path in [&dir, scene.spools.root.as_ref().unwrap()] {
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
