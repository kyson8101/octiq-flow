use super::*;
use serde_json::json;

#[test]
fn record_head_follows_clear_and_keeps_generation_across_appends_and_cold_reads() {
    let key = unique_key("record-head-clear");
    assert_eq!(record_head(&key).unwrap().last_seq, 0);
    for _ in 0..5 {
        append(&key, &json!({"type":"result"})).unwrap();
    }
    let before = record_head(&key).unwrap();
    assert_eq!(before.last_seq, 5);
    assert_eq!(record_head(&key).unwrap().generation, before.generation);
    append(&key, &json!({"type":"result"})).unwrap();
    forget_count(&key);
    let cold = record_head(&key).unwrap();
    assert_eq!(cold.last_seq, 6);
    assert_eq!(cold.generation, before.generation);
    forget_checked(&key).unwrap();
    let empty = record_head(&key).unwrap();
    assert_eq!(empty.last_seq, 0);
    assert_ne!(empty.generation, before.generation);
    for _ in 0..2 {
        append(&key, &json!({"type":"result"})).unwrap();
    }
    let after = record_head(&key).unwrap();
    assert_eq!(after.last_seq, 2);
    assert_ne!(after.generation, before.generation);
    assert_eq!(record_head(&key).unwrap().generation, after.generation);
    forget(&key);
}

#[test]
fn record_head_and_page_count_compacted_ranges_and_invalid_utf8_identically() {
    let key = unique_key("record-head-storage");
    let path = path_for(&key).unwrap();
    fs::write(
        &path,
        b"{\"type\":\"octiq_compacted\",\"into\":1,\"count\":20}\n\xff\n{\"type\":\"result\"}\n",
    )
    .unwrap();
    assert_eq!(record_head(&key).unwrap().last_seq, 22);
    forget_count(&key);
    let page = page(&key, None).unwrap();
    // Paging already indexed the whole file: a head request must reuse it.
    HEAD_SCAN
        .with(|hook| *hook.borrow_mut() = Some(Box::new(|| panic!("head rescanned after page"))));
    let head = record_head(&key).unwrap();
    HEAD_SCAN.with(|hook| hook.borrow_mut().take());
    assert_eq!(head.last_seq, page.events.last().unwrap().seq);
    assert_eq!(head.last_seq, 22);
    forget(&key);
}

#[test]
fn cold_head_scan_allows_other_appends_and_refuses_a_cleared_source() {
    let key = unique_key("record-head-concurrent");
    append(&key, &json!({"type":"result"})).unwrap();
    forget_count(&key);
    let other = unique_key("record-head-other");
    let cleared = key.clone();
    let appended = other.clone();
    HEAD_SCAN.with(|hook| {
        *hook.borrow_mut() = Some(Box::new(move || {
            let (tx, rx) = std::sync::mpsc::channel();
            let writer = std::thread::spawn(move || {
                let seq = append(&appended, &json!({"type":"result"}));
                forget(&cleared);
                for _ in 0..2 {
                    append(&cleared, &json!({"type":"result"})).unwrap();
                }
                tx.send(seq).unwrap();
            });
            assert_eq!(
                rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(),
                Some(1)
            );
            writer.join().unwrap();
        }))
    });
    assert_eq!(record_head(&key).unwrap().last_seq, 2);
    forget(&key);
    forget(&other);
}

#[test]
fn record_head_changes_generation_and_invalidates_count_after_rewrite() {
    let key = unique_key("record-head-rewrite");
    append(&key, &json!({"type":"result"})).unwrap();
    let before = record_head(&key).unwrap();
    let path = path_for(&key).unwrap();
    assert!(rewrite_lines(&path, |_| Some(
        r#"{"type":"result","changed":true}"#.into()
    ))
    .unwrap());
    let record = identity(&path);
    assert!(!NEXT_SEQ
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .contains_key(&record));
    let after = record_head(&key).unwrap();
    assert_eq!(after.last_seq, before.last_seq);
    assert_ne!(after.generation, before.generation);
    forget(&key);
}

#[test]
fn rewrite_preparation_allows_appends_and_refuses_a_changed_source() {
    let key = unique_key("storage-concurrent-append");
    append(&key, &json!({"type":"user","message":{"content":"keep"}}));
    let path = path_for(&key).unwrap();
    let seen = generation(&key).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let mut writer = None;
    let mut edited = false;
    let result = rewrite_numbered(
        &path,
        |_, _| {
            if edited {
                return None;
            }
            edited = true;
            let key = key.clone();
            let tx = tx.clone();
            writer = Some(std::thread::spawn(move || {
                tx.send(append(&key, &json!({"type":"result"}))).unwrap();
            }));
            assert_eq!(
                rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap(),
                Some(2)
            );
            Some(r#"{"type":"user","message":{"content":"must not publish"}}"#.into())
        },
        true,
    );
    assert!(result.is_err());
    writer.unwrap().join().unwrap();
    assert_eq!(generation(&key), Some(seen));
    assert_eq!(since(&key, 0)[0].event["message"]["content"], "keep");
    assert_eq!(since(&key, 1)[0].seq, 2);
    forget(&key);
}

#[test]
fn rewrite_preparation_cannot_put_cleared_words_in_a_new_history() {
    let key = unique_key("storage-concurrent-clear");
    append(&key, &json!({"type":"octiq_note","text":"old"}));
    let path = path_for(&key).unwrap();
    let result = rewrite_numbered(
        &path,
        |_, _| {
            forget(&key);
            append(&key, &json!({"type":"octiq_note","text":"fresh"}));
            Some(r#"{"type":"octiq_note","text":"old rewritten"}"#.into())
        },
        true,
    );
    assert!(result.is_err());
    assert_eq!(since(&key, 0).len(), 1);
    assert_eq!(since(&key, 0)[0].event["text"], "fresh");
    forget(&key);
}

#[test]
fn publication_releases_the_append_lock_before_readback() {
    struct AppendOnDrop(String);
    impl Drop for AppendOnDrop {
        fn drop(&mut self) {
            assert_eq!(
                append(&self.0, &json!({"type":"octiq_note","text":"new"})),
                Some(5)
            );
        }
    }
    let key = unique_key("storage-readback-append");
    append(&key, &json!({"type":"octiq_note","text":"keep"}));
    for _ in 0..3 {
        append(&key, &json!({"type":"octiq_compacted","into":1}));
    }
    let path = path_for(&key).unwrap();
    assert!(
        rewrite_numbered_guarded(&path, |_, _| None, true, || Ok(AppendOnDrop(key.clone())))
            .unwrap()
    );
    assert!(!path.with_extension("jsonl.compact-backup").exists());
    assert_eq!(since(&key, 4)[0].event["text"], "new");
    forget(&key);
}

#[test]
fn ranges_keep_seq_page_context_and_receipts_across_restart() {
    let key = unique_key("storage-ranges");
    let init = json!({"type":"system","subtype":"init","session_id":"session","slash_commands":["help"],"tools":["tool"]});
    append(&key, &init);
    append(&key, &json!({"type":"octiq_user_turn","uuid":"p1"}));
    append(
        &key,
        &json!({"type":"user","uuid":"p1","message":{"content":"question"}}),
    );
    for _ in 0..10 {
        append(&key, &json!({"type":"octiq_compacted","into":3}));
    }
    append(
        &key,
        &json!({"type":"octiq_question_answered","id":"q1","answer":"yes"}),
    );
    append(&key, &json!({"type":"result"}));
    append(&key, &init);
    let path = path_for(&key).unwrap();
    let generation = generation(&key).unwrap();
    assert!(rewrite_numbered(&path, |_, _| None, true).unwrap());
    assert_eq!(receipt(&key, &generation), Held::Moved);
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("\"count\":10"));
    assert!(text.contains("octiq_record_refs"));
    let tail = since(&key, 8);
    assert_eq!(seqs(&tail), [13, 14, 15, 16]);
    assert_eq!(tail.last().unwrap().event, init);
    assert_eq!(of_type(&key, "octiq_question_answered").len(), 1);
    for before in [None, Some(8), Some(14), Some(17)] {
        let page = page_with_budget(&key, before, 999999, 20).unwrap();
        let forward = page_forward(&key, before, 999999, 20).unwrap();
        assert_eq!(
            serde_json::to_value(page).unwrap(),
            serde_json::to_value(forward).unwrap()
        );
    }
    forget_count(&key);
    assert_eq!(append(&key, &init), Some(17));
    assert_eq!(since(&key, 16)[0].event, init);
    forget(&key);
    assert_eq!(append(&key, &init), Some(1));
    assert_eq!(since(&key, 0)[0].event, init);
    forget(&key);
}

#[test]
fn interrupted_compaction_keeps_backup_and_resumes_even_after_new_appends() {
    for stage in [1, 2] {
        let key = unique_key("storage-crash");
        append(
            &key,
            &json!({"type":"octiq_question_answered","answer":"keep"}),
        );
        for _ in 0..4 {
            append(&key, &json!({"type":"octiq_compacted","into":1}));
        }
        let path = path_for(&key).unwrap();
        let seen = generation(&key).unwrap();
        FAIL_COMPACT_AT.with(|fail| fail.set(stage));
        assert!(rewrite_numbered(&path, |_, _| None, true).is_err());
        FAIL_COMPACT_AT.with(|fail| fail.set(0));
        assert!(path.with_extension("jsonl.compact-backup").exists());
        if stage == 2 {
            assert_eq!(receipt(&key, &seen), Held::Moved);
        }
        assert_eq!(
            append(&key, &json!({"type":"octiq_task_reopened","taskId":"new"})),
            Some(6)
        );
        rewrite_numbered(&path, |_, _| None, true).unwrap();
        assert!(!path.with_extension("jsonl.compact-backup").exists());
        assert_eq!(of_type(&key, "octiq_question_answered").len(), 1);
        assert_eq!(since(&key, 5)[0].event["taskId"], "new");
        forget(&key);
    }
}

#[test]
#[ignore]
fn storage_crash_child() {
    let path =
        PathBuf::from(std::env::var("OCTIQ_COMPACT_CRASH_FILE").expect("parent test scratch path"));
    let scratch = crate::paths::canonicalize(&std::env::temp_dir()).unwrap();
    assert!(crate::paths::canonicalize(&path)
        .unwrap()
        .starts_with(scratch));
    let _profile = crate::profile::started_in(path.parent().unwrap());
    rewrite_numbered(&path, |_, _| None, true).unwrap();
}

#[test]
fn a_fresh_process_resumes_a_compactor_killed_at_either_publication_boundary() {
    for stage in [1, 2] {
        let scratch = crate::test_dir::TestDir::new("record-storage-process-crash");
        let path = scratch.join("chat_crash.jsonl");
        fs::write(
            &path,
            format!(
                "{{\"type\":\"octiq_question_answered\",\"answer\":\"yes\"}}\n{}\n",
                vec![crate::record_trim::compacted_line(1); 8].join("\n")
            ),
        )
        .unwrap();
        let child = || {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "transcript::tests::storage_crash_child",
                    "--ignored",
                ])
                .env("OCTIQ_COMPACT_CRASH_FILE", &path);
            command
        };
        let killed = child()
            .env("OCTIQ_COMPACT_KILL_AT", stage.to_string())
            .output()
            .unwrap();
        assert_eq!(killed.status.code(), Some(73));
        assert!(path.with_extension("jsonl.compact-backup").is_file());
        let resumed = child()
            .env_remove("OCTIQ_COMPACT_KILL_AT")
            .output()
            .unwrap();
        assert!(
            resumed.status.success(),
            "{}",
            String::from_utf8_lossy(&resumed.stderr)
        );
        assert!(!path.with_extension("jsonl.compact-backup").exists());
        let (end, _) = storage_facts(&path, u64::MAX).unwrap();
        assert_eq!(end, 9);
        assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
    }
}

#[test]
fn page_reads_mixed_list_sources_directly_without_recursive_init_expansion() {
    let key = unique_key("mixed-list-sources");
    let mut init = json!({"type":"system","subtype":"init","tools":["t0"],"slash_commands":["c0"],"skills":["s0"]});
    append(&key, &init);
    for at in 1..40 {
        let field = ["tools", "slash_commands", "skills"][at % 3];
        init[field] = json!([format!("value{at}")]);
        append(&key, &init);
    }
    let file = File::open(path_for(&key).unwrap()).unwrap();
    let index = LineIndex::scan(&file, u64::MAX).unwrap();
    assert_eq!(index.read(&file, 40).unwrap().unwrap().0, init);
    assert_eq!(since(&key, 39)[0].event, init);
    forget(&key);
}

#[test]
fn storage_migration_ends_a_torn_or_unterminated_line_before_future_appends() {
    for body in [
        br#"{"type":"octiq_note","text":"keep"}"#.as_slice(),
        b"{\"type\":\"assistant\",\"text\":\"\xff",
    ] {
        let key = unique_key("storage-final-boundary");
        let path = path_for(&key).unwrap();
        fs::write(&path, body).unwrap();
        assert!(rewrite_numbered(&path, |_, _| None, true).unwrap());
        assert!(fs::read(&path).unwrap().ends_with(b"\n"));
        forget_count(&key);
        assert_eq!(append(&key, &json!({"type":"result"})), Some(2));
        assert_eq!(since(&key, 1)[0].seq, 2);
        forget(&key);
    }
}

#[test]
fn migration_reservation_defers_new_receipt_flows_without_changing_tokens() {
    let key = format!("chat:{}", unique_key("storage-receipt-reservation"));
    append(&key, &json!({"type":"octiq_note","text":"keep"}));
    let seen = generation(&key).unwrap();
    let held = hold_storage(&path_for(&key).unwrap()).unwrap();
    assert!(generation(&key).is_none());
    assert!(generation(&key.replace(':', "_")).is_none());
    assert_eq!(receipt(&key, &seen), Held::Confirmed);
    drop(held);
    assert_eq!(generation(&key), Some(seen));
    forget(&key);
}

#[test]
fn storage_publication_waits_for_the_backup_folder_to_sync() {
    let key = unique_key("storage-folder-sync");
    append(&key, &json!({"type":"octiq_note","text":"keep"}));
    for _ in 0..3 {
        append(&key, &json!({"type":"octiq_compacted","into":1}));
    }
    let path = path_for(&key).unwrap();
    let before = fs::read(&path).unwrap();
    let seen = generation(&key).unwrap();
    FAIL_DIR_SYNC.with(|fail| fail.set(true));
    assert!(rewrite_numbered(&path, |_, _| None, true).is_err());
    FAIL_DIR_SYNC.with(|fail| fail.set(false));
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(generation(&key), Some(seen.clone()));
    assert!(path.with_extension("jsonl.compact-backup").is_file());
    assert!(rewrite_numbered(&path, |_, _| None, true).unwrap());
    assert_eq!(receipt(&key, &seen), Held::Moved);
    assert_eq!(of_type(&key, "octiq_note").len(), 1);
    forget(&key);
}

/// A key nobody else's test will use, so these can run in parallel against
/// one real profile directory.
fn unique_key(name: &str) -> String {
    format!("test-{name}-{}", uuid::Uuid::new_v4().simple())
}

fn assert_page_has_drawable_turn(page: &Page) {
    let host_prompts = page
        .events
        .iter()
        .filter_map(|record| host_prompt_id(&record.event).map(|id| (id.to_string(), record.seq)))
        .collect();
    assert!(
        page.events.iter().any(|record| {
            host_event(&record.event) && page_prompt(&record.event, record.seq, &host_prompts)
        }),
        "a page must contain a drawable turn, not only context: {page:?}"
    );
}

#[test]
fn pages_walk_backwards_without_gaps_or_duplicates() {
    let key = unique_key("pages");
    append(
        &key,
        &json!({"type":"system", "subtype":"init", "session_id":"session"}),
    );
    for n in 0..12 {
        append(
            &key,
            &json!({"type":"user", "message":{"content":format!("prompt {n}")}}),
        );
        append(
            &key,
            &json!({"type":"assistant", "message":{"id":format!("m{n}"), "content":[]}}),
        );
        append(&key, &json!({"type":"result"}));
    }
    let latest = page_with_budget(&key, None, usize::MAX, 3).unwrap();
    assert_page_has_drawable_turn(&latest);
    assert_eq!(
        serde_json::to_value(&latest).unwrap(),
        serde_json::to_value(page_forward(&key, None, usize::MAX, 3).unwrap()).unwrap()
    );
    assert_eq!(latest.events.len(), 9);
    assert_eq!(latest.context[0].event["session_id"], "session");
    let mut sequences: Vec<u64> = latest.events.iter().map(|e| e.seq).collect();
    let mut cursor = latest.before;
    // A new event cannot shift an already-issued exclusive cursor.
    append(
        &key,
        &json!({"type":"user", "message":{"content":"new prompt"}}),
    );
    while let Some(before) = cursor {
        let older = page_with_budget(&key, Some(before), usize::MAX, 3).unwrap();
        assert_page_has_drawable_turn(&older);
        let expected = page_forward(&key, Some(before), usize::MAX, 3).unwrap();
        assert_eq!(
            serde_json::to_value(&older).unwrap(),
            serde_json::to_value(&expected).unwrap()
        );
        assert!(older.before.is_none_or(|next| next < before));
        sequences.extend(older.events.iter().map(|e| e.seq));
        cursor = older.before;
    }
    sequences.sort_unstable();
    assert_eq!(sequences, (1..=37).collect::<Vec<_>>());
    forget(&key);
}

#[test]
fn startup_context_joins_the_first_drawable_turn_even_over_budget() {
    let key = unique_key("page-startup-context");
    for event in [
        json!({"type":"system", "subtype":"init", "session_id":"session"}),
        json!({"type":"thread.started", "thread_id":"thread"}),
        // Hooks are bounded on write now. Use generic startup metadata
        // to keep exercising an indivisible prefix larger than the budget.
        json!({"type":"system", "subtype":"startup_metadata", "output":"x".repeat(300 * 1024)}),
        // User-shaped context is not an earlier host prompt.
        json!({"type":"user", "message":{"content":[{"type":"tool_result","content":"hook"}]}}),
        json!({"type":"user", "parent_tool_use_id":"p", "message":{"content":"subagent"}}),
        json!({"type":"user", "octiq_speaker":{"id":"a"}, "message":{"content":"seat"}}),
        json!({"type":"user", "octiq_append_to":"u", "message":{"content":"appended"}}),
    ] {
        append(&key, &event);
    }
    for n in 0..4 {
        append(
            &key,
            &json!({"type":"user", "isReplay":true,
                    "octiq_user_turn_id":format!("queued-{n}"),
                    "message":{"content":[{"type":"image", "source":{"data":"image"}}]}}),
        );
        append(&key, &json!({"type":"assistant"}));
        append(&key, &json!({"type":"result"}));
    }
    for (budget, turns) in [(1, 1), (256 * 1024, 3), (256 * 1024, 4), (usize::MAX, 3)] {
        let mut cursor = None;
        let mut sequences = Vec::new();
        loop {
            let page = page_with_budget(&key, cursor, budget, turns).unwrap();
            let expected = page_forward(&key, cursor, budget, turns).unwrap();
            assert_page_has_drawable_turn(&page);
            assert_eq!(
                serde_json::to_value(&page).unwrap(),
                serde_json::to_value(&expected).unwrap()
            );
            sequences.extend(page.events.iter().map(|record| record.seq));
            cursor = page.before;
            if cursor.is_none() {
                assert_eq!(page.events.first().unwrap().seq, 1);
                assert_eq!(page.events.len(), 10, "the prefix and exactly one turn");
                assert!(page.context.is_empty());
                break;
            }
        }
        sequences.sort_unstable();
        assert_eq!(sequences, (1..=19).collect::<Vec<_>>());
    }
    forget(&key);
}

#[test]
fn a_torn_prefix_does_not_offer_an_empty_earlier_page() {
    let key = unique_key("page-torn-prefix");
    fs::write(
            path_for(&key).unwrap(),
            "{\"torn\":\n{\"type\":\"user\",\"message\":{\"content\":\"prompt\"}}\n{\"type\":\"result\"}\n",
        )
        .unwrap();
    for page in [
        page_with_budget(&key, None, 1, 1).unwrap(),
        page_forward(&key, None, 1, 1).unwrap(),
    ] {
        assert_page_has_drawable_turn(&page);
        assert_eq!(page.before, None);
        assert_eq!(
            page.events.iter().map(|r| r.seq).collect::<Vec<_>>(),
            [2, 3]
        );
    }
    forget(&key);
}

/// Reading from the end finds exactly the page reading every line from the
/// front does, over records shaped like real ones: queued prompts inside a
/// reply, subagent and seat events, torn lines, context of both kinds.
#[test]
fn a_page_read_from_the_end_is_the_page_read_from_the_front() {
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut roll = move |n: u64| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state % n
    };
    for round in 0..300 {
        let key = unique_key("page-equivalence");
        let path = path_for(&key).unwrap();
        let mut text = String::new();
        for _ in 0..roll(60) {
            let event = match roll(20) {
                0 => {
                    json!({"type":"system","subtype":"init","session_id":format!("s{}", roll(9))})
                }
                1 => json!({"type":"thread.started","thread_id":format!("t{}", roll(9))}),
                2 | 3 => {
                    json!({"type":"user","message":{"content":"x".repeat(roll(40) as usize)}})
                }
                4 => {
                    json!({"type":"user","message":{"content":[{"type":"tool_result","content":"r"}]}})
                }
                5 => json!({"type":"user","octiq_append_to":"u","message":{"content":"more"}}),
                6 => json!({"type":"assistant","message":{"content":[]}}),
                7 => json!({"type":"stream_event","event":{"type":"message_start"}}),
                8 => {
                    json!({"type":"stream_event","event":{"type":"content_block_delta","text":"y".repeat(roll(30) as usize)}})
                }
                9 | 10 => json!({"type":"result"}),
                11 => json!({"type":"turn.started"}),
                12 => json!({"type":"turn.completed"}),
                13 => json!({"type":"result","parent_tool_use_id":"p"}),
                14 => {
                    json!({"type":"user","octiq_speaker":{"id":"a"},"message":{"content":"seat"}})
                }
                15 => json!({"type":"user", "uuid":format!("user-{}", roll(4)),
                        "octiq_user_turn":true, "message":{"content":"host"}}),
                16 | 17 => json!({"type":"user", "isReplay":true,
                        "octiq_user_turn_id":format!("user-{}", roll(4)), "message":{"content":"echo"}}),
                18 => json!({"type":"user", "uuid":"user-0", "octiq_user_turn":true,
                        "parent_tool_use_id":"p", "message":{"content":"subagent"}}),
                _ => {
                    text.push_str("{\"torn\": \n");
                    continue;
                }
            };
            text.push_str(&event.to_string());
            text.push('\n');
        }
        if roll(4) == 0 {
            text.push_str("{\"half");
        }
        fs::write(&path, &text).unwrap();
        let lines = text.lines().count() as u64;
        for _ in 0..6 {
            let budget = [1, 40, 120, 400, usize::MAX][roll(5) as usize];
            let turns = roll(5) as usize;
            let before = (roll(3) > 0).then(|| roll(lines + 2) + 1);
            let found = page_with_budget(&key, before, budget, turns).unwrap();
            let expected = page_forward(&key, before, budget, turns).unwrap();
            let shape = |page: &Page| {
                (
                    page.events
                        .iter()
                        .map(|e| (e.seq, e.event.clone()))
                        .collect::<Vec<_>>(),
                    page.context
                        .iter()
                        .map(|e| (e.seq, e.event.clone()))
                        .collect::<Vec<_>>(),
                    page.before,
                )
            };
            assert_eq!(
                shape(&found),
                shape(&expected),
                "round {round}, before {before:?}, budget {budget}, turns {turns}:\n{text}"
            );
        }
        forget(&key);
    }
}

/// The same check over real records, with timings:
/// `OCTIQ_PAGE_CHECK=<a.jsonl>:<b.jsonl> cargo test --release -- --ignored real_records`
#[test]
#[ignore]
fn real_records_page_the_same_from_either_end() {
    let Ok(files) = std::env::var("OCTIQ_PAGE_CHECK") else {
        return;
    };
    for file in files.split(':') {
        let key = unique_key("page-real");
        fs::copy(file, path_for(&key).unwrap()).unwrap();
        let mut cursor = None;
        for _ in 0..3 {
            let started = std::time::Instant::now();
            let found = page(&key, cursor).unwrap();
            let fast = started.elapsed();
            let started = std::time::Instant::now();
            let expected = page_forward(&key, cursor, 256 * 1024, 3).unwrap();
            let slow = started.elapsed();
            eprintln!("{file} before {cursor:?}: {fast:?} from the end, {slow:?} from the front, {} events, next before {:?}", found.events.len(), found.before);
            let seqs = |p: &Page| {
                p.events
                    .iter()
                    .chain(&p.context)
                    .map(|e| e.seq)
                    .collect::<Vec<_>>()
            };
            assert_eq!(seqs(&found), seqs(&expected));
            assert_eq!(found.before, expected.before);
            cursor = found.before;
            if cursor.is_none() {
                break;
            }
        }
        forget(&key);
    }
}

#[test]
fn startup_replay_stays_with_its_host_prompt_despite_the_byte_budget() {
    let key = unique_key("page-startup-replay");
    append(
        &key,
        &json!({"type":"user", "uuid":"user-first", "octiq_user_turn":true,
                "message":{"content":"first prompt"}}),
    );
    // SessionStart hooks, slash-command lists and init can occupy most of
    // the byte budget before Claude echoes the prompt back.
    for _ in 0..2 {
        append(
            &key,
            &json!({"type":"system", "subtype":"hook_response", "output":"x".repeat(105 * 1024)}),
        );
    }
    append(&key, &json!({"type":"system", "subtype":"init"}));
    append(
        &key,
        &json!({"type":"user", "isReplay":true, "octiq_user_turn_id":"user-first",
                "message":{"content":[{"type":"image", "source":{"data":"a".repeat(60 * 1024)}}]}}),
    );
    append(
        &key,
        &json!({"type":"stream_event", "event":{"type":"message_start"}}),
    );
    for _ in 0..20 {
        append(
            &key,
            &json!({"type":"stream_event", "event":{"type":"content_block_delta", "text":"x".repeat(4096)}}),
        );
    }
    for page in [
        page(&key, None).unwrap(),
        page_forward(&key, None, 256 * 1024, 3).unwrap(),
    ] {
        assert_eq!(page.before, None);
        assert_eq!(page.events.first().unwrap().seq, 1);
        assert_eq!(page.events.len(), 26);
    }
    forget(&key);
}

#[test]
fn replay_without_an_earlier_host_prompt_starts_its_queued_turn() {
    let key = unique_key("page-queued-replay");
    append(
        &key,
        &json!({"type":"user", "uuid":"user-first", "octiq_user_turn":true,
                "message":{"content":"first"}}),
    );
    append(&key, &json!({"type":"assistant"}));
    append(&key, &json!({"type":"result"}));
    append(
        &key,
        &json!({"type":"user", "isReplay":true, "octiq_user_turn_id":"user-queued",
                "message":{"content":"queued"}}),
    );
    append(&key, &json!({"type":"assistant"}));
    // Even if this UUID appears later, it was not before the replay.
    append(
        &key,
        &json!({"type":"user", "uuid":"user-queued", "octiq_user_turn":true,
                "message":{"content":"later"}}),
    );
    for page in [
        page_with_budget(&key, None, 1, 1).unwrap(),
        page_forward(&key, None, 1, 1).unwrap(),
    ] {
        assert_eq!(page.before, Some(4));
        assert_eq!(page.events.first().unwrap().seq, 4);
        assert_eq!(page.events.len(), 3);
    }
    forget(&key);
}

#[test]
fn byte_budget_keeps_a_stream_and_its_queued_prompt_together() {
    let key = unique_key("page-stream");
    append(&key, &json!({"type":"user", "message":{"content":"old"}}));
    append(&key, &json!({"type":"result"}));
    append(
        &key,
        &json!({"type":"user", "message":{"content":"current"}}),
    );
    append(
        &key,
        &json!({"type":"stream_event", "event":{"type":"message_start"}}),
    );
    append(
        &key,
        &json!({"type":"user", "octiq_user_turn":true, "message":{"content":"queued"}}),
    );
    append(
        &key,
        &json!({"type":"stream_event", "event":{"type":"content_block_delta", "text":"x".repeat(1000)}}),
    );
    let page = page_with_budget(&key, None, 100, 3).unwrap();
    assert_eq!(page.before, Some(3));
    assert_eq!(
        page.events.iter().map(|e| e.seq).collect::<Vec<_>>(),
        vec![3, 4, 5, 6]
    );
    forget(&key);
}

#[test]
fn appended_queue_envelopes_stay_on_their_combined_turn_page() {
    let key = unique_key("page-appended-queue");
    append(&key, &json!({"type":"user", "message":{"content":"old"}}));
    append(&key, &json!({"type":"result"}));
    append(
        &key,
        &json!({"type":"user", "uuid":"user-1", "octiq_user_turn":true, "message":{"content":"first"}}),
    );
    for id in ["user-2", "user-3", "user-4"] {
        append(
            &key,
            &json!({"type":"user", "uuid":id, "octiq_user_turn":true, "octiq_append_to":"user-1", "message":{"content":id}}),
        );
        append(
            &key,
            &json!({"type":"octiq_user_turn_appended", "uuid":"user-1", "appended_uuid":id}),
        );
    }
    let page = page_with_budget(&key, None, 1, 1).unwrap();
    assert_eq!(page.before, Some(3));
    assert_eq!(
        page.events
            .iter()
            .map(|event| event.seq)
            .collect::<Vec<_>>(),
        (3..=9).collect::<Vec<_>>()
    );
    forget(&key);
}

#[test]
fn events_come_back_in_order_from_where_you_left_off() {
    let key = unique_key("order");
    for i in 1..=5 {
        append(&key, &json!({ "n": i }));
    }

    // A client that saw three asks for three, and gets exactly the rest.
    let rest = since(&key, 3);
    assert_eq!(rest.len(), 2);
    assert_eq!(rest[0].seq, 4);
    assert_eq!(rest[0].event["n"], 4);
    assert_eq!(rest[1].seq, 5);

    // From nothing means the whole conversation.
    assert_eq!(since(&key, 0).len(), 5);
    // Already up to date.
    assert!(since(&key, 5).is_empty());
    // Ahead of us — a stale client, or a record that was deleted and
    // restarted. Answering with nothing beats answering with the wrong
    // events.
    assert!(since(&key, 99).is_empty());

    forget(&key);
}

#[test]
fn a_torn_last_line_does_not_hide_the_events_before_it() {
    let key = unique_key("torn");
    append(&key, &json!({ "n": 1 }));
    append(&key, &json!({ "n": 2 }));

    // Simulate a process killed mid-write.
    let path = path_for(&key).unwrap();
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    write!(file, "{{\"n\": 3, \"hal").unwrap();
    drop(file);

    let all = since(&key, 0);
    assert_eq!(all.len(), 2, "the two whole events must survive");
    assert_eq!(all[1].event["n"], 2);

    forget(&key);
}

#[test]
fn a_synced_line_after_a_torn_one_is_whole_and_numbered_where_it_sits() {
    let key = unique_key("torn-synced");
    append(&key, &json!({ "n": 1 }));
    let path = path_for(&key).unwrap();
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    write!(file, "{{\"n\": 2, \"hal").unwrap();
    drop(file);
    // The process died there; the next one counts the file afresh.
    forget_count(&key);

    let seq = append_synced(&key, &json!({ "n": 3 })).unwrap();
    let all = since(&key, 0);
    assert_eq!(all.len(), 2, "the torn line is skipped, the new one is not");
    assert_eq!(all[1].event["n"], 3);
    assert_eq!(all[1].seq, seq);
    assert_eq!(append_synced(&key, &json!({ "n": 4 })), Some(seq + 1));
    forget(&key);
}

#[test]
fn a_new_file_whose_folder_cannot_be_synced_is_written_but_not_confirmed() {
    let key = unique_key("dir-sync");
    FAIL_DIR_SYNC.with(|f| f.set(true));
    let first = append_synced(&key, &json!({ "n": 1 }));
    // An existing file needs no folder sync, so the next one is confirmed.
    let second = append_synced(&key, &json!({ "n": 2 }));
    FAIL_DIR_SYNC.with(|f| f.set(false));
    assert_eq!(first, None, "unproven, so not confirmed");
    assert_eq!(second, Some(2));
    let all = since(&key, 0);
    assert_eq!(all.len(), 2, "the first line is on disk all the same");
    assert_eq!(all[0].seq, 1);
    forget(&key);
}

/// A line that is in the record is confirmed by the syncs its append
/// had to make, and by nothing less: no file, or a folder that will not
/// sync, is no receipt. Asking writes no event.
#[test]
fn lines_already_in_a_record_are_confirmed_only_by_a_sync_that_succeeds() {
    let key = unique_key("confirm");
    let confirm_synced = |key: &str| confirm_synced(key, &generation(key).unwrap());
    assert_eq!(confirm_synced(&key), None, "no record, nothing to confirm");
    FAIL_DIR_SYNC.with(|f| f.set(true));
    let unproven = append_synced(&key, &json!({ "n": 1 }));
    let refused = confirm_synced(&key);
    FAIL_DIR_SYNC.with(|f| f.set(false));
    assert_eq!((unproven, refused), (None, None));
    assert_eq!(confirm_synced(&key), Some(()));
    assert_eq!(since(&key, 0).len(), 1, "confirming appends nothing");

    // A last line with no line end is given one, so the next ordinary
    // append is its own line and the confirmed one stays readable.
    let path = path_for(&key).unwrap();
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    write!(file, "{{\"n\":2}}").unwrap();
    drop(file);
    // The process died there; the next one counts the file afresh.
    forget_count(&key);
    assert_eq!(confirm_synced(&key), Some(()));
    assert_eq!(append(&key, &json!({ "n": 3 })), Some(3));
    let all: Vec<Value> = since(&key, 0).into_iter().map(|r| r.event).collect();
    assert_eq!(
        all,
        [json!({ "n": 1 }), json!({ "n": 2 }), json!({ "n": 3 })]
    );
    forget(&key);
}

/// `of_type` answers the events of that type and no other line: not one
/// that only mentions the name, not a torn one.
#[test]
fn the_events_of_one_type_are_found_without_the_rest() {
    let key = unique_key("of-type");
    assert!(of_type(&key, "octiq_x").is_empty(), "no record");
    append(&key, &json!({ "type": "user", "text": "about octiq_x" }));
    append(&key, &json!({ "type": "octiq_x", "n": 1 }));
    append(&key, &json!({ "type": "octiq_xy", "n": 2 }));
    append(&key, &json!({ "type": "assistant", "text": "plain" }));
    append(&key, &json!({ "type": "octiq_x", "n": 3 }));
    let mut file = OpenOptions::new()
        .append(true)
        .open(path_for(&key).unwrap())
        .unwrap();
    write!(file, "{{\"type\":\"octiq_x\",\"n\":").unwrap();
    drop(file);
    assert_eq!(
        of_type(&key, "octiq_x"),
        [
            json!({ "type": "octiq_x", "n": 1 }),
            json!({ "type": "octiq_x", "n": 3 })
        ]
    );
    forget(&key);
}

/// A line that is not UTF-8 (a write cut inside a character) is one
/// line skipped, like one that will not parse: the events after it are
/// still found.
#[test]
fn a_line_that_is_not_utf8_hides_no_event_of_a_type_after_it() {
    let key = unique_key("of-type-utf8");
    append(&key, &json!({ "type": "octiq_x", "n": 1 }));
    let mut file = OpenOptions::new()
        .append(true)
        .open(path_for(&key).unwrap())
        .unwrap();
    file.write_all(b"{\"type\":\"octiq_x\",\"text\":\"\xE4\xB8\n")
        .unwrap();
    drop(file);
    append(&key, &json!({ "type": "octiq_x", "n": 2 }));
    assert_eq!(
        of_type(&key, "octiq_x"),
        [
            json!({ "type": "octiq_x", "n": 1 }),
            json!({ "type": "octiq_x", "n": 2 })
        ]
    );
    forget(&key);
}

#[test]
fn a_folder_sync_is_skipped_on_windows_and_asked_everywhere_else() {
    let missing = std::env::temp_dir().join(format!("octiq-no-dir-{}", uuid::Uuid::new_v4()));
    // Windows cannot open a folder to sync it; asking would fail forever.
    assert!(sync_dir_on(&missing, true).is_ok());
    // Elsewhere a folder that cannot be synced is an error, not a shrug.
    assert!(sync_dir_on(&missing, false).is_err());
    let folder = std::env::temp_dir();
    if cfg!(windows) {
        // The reason for the skip: Windows refuses to open a folder as a
        // file, so asking would fail even for one that exists.
        assert!(sync_dir_on(&folder, false).is_err());
    } else {
        assert!(sync_dir_on(&folder, false).is_ok());
    }
    // What this platform really does with an existing folder succeeds.
    assert!(sync_dir(&folder).is_ok());
}

#[test]
fn appending_stays_correct_across_many_events() {
    // The counter is in memory; this is the case that would expose it
    // drifting from what is actually on disk.
    let key = unique_key("many");
    let mut last = 0;
    for i in 1..=200 {
        last = append(&key, &json!({ "n": i })).expect("append should record");
    }
    assert_eq!(last, 200, "the 200th event should be seq 200");
    assert_eq!(since(&key, 0).len(), 200);
    assert_eq!(since(&key, 199).len(), 1);
    forget(&key);
}

#[test]
fn a_chat_reusing_a_forgotten_key_starts_from_one() {
    let key = unique_key("reused");
    append(&key, &json!({ "n": 1 }));
    append(&key, &json!({ "n": 2 }));
    forget(&key);

    // Without clearing the counter this would come back as 3, and a client
    // asking for "everything after 0" would be told there is nothing.
    assert_eq!(append(&key, &json!({ "n": 1 })), Some(1));
    forget(&key);
}

#[test]
fn a_key_that_is_really_a_path_is_refused() {
    // Keys arrive from a browser. This one must not write into /etc.
    assert!(path_for("../../etc/passwd").is_none());
    assert!(path_for("chat:with/slash").is_none());
    assert!(path_for("").is_none());
    // The shape our own keys actually take.
    assert!(path_for("chat:7f3a-4b21").is_some());
}

#[test]
fn forgetting_a_chat_leaves_nothing_to_read() {
    let key = unique_key("forget");
    append(&key, &json!({ "n": 1 }));
    assert_eq!(since(&key, 0).len(), 1);
    forget(&key);
    assert!(since(&key, 0).is_empty());
}

/// A receipt is for the record a line was seen in. A chat that was
/// forgotten and spoken in again has a file under the old name that
/// syncs perfectly well and holds none of what the old one did: the
/// receipt asked for with the old record's generation is refused, and
/// one asked for with the new record's is given.
#[test]
fn a_receipt_is_refused_for_a_record_that_was_forgotten_and_made_again() {
    let key = unique_key("generation");
    assert_eq!(generation("not/a key"), None);
    append(&key, &json!({ "n": 1 }));
    let seen = generation(&key).unwrap();
    assert_eq!(confirm_synced(&key, &seen), Some(()));
    assert_eq!(
        generation(&key),
        Some(seen.clone()),
        "a receipt moves nothing"
    );

    forget(&key);
    assert_ne!(generation(&key), Some(seen.clone()));
    assert_eq!(confirm_synced(&key, &seen), None, "no record at all");
    append(&key, &json!({ "n": 2 }));
    assert_eq!(
        confirm_synced(&key, &seen),
        None,
        "the record there now is not the one that was seen"
    );
    let now = generation(&key).unwrap();
    assert_eq!(confirm_synced(&key, &now), Some(()));

    // Forgetting a chat that has no record moves it on as well: what
    // is written afterwards is not what a look before it saw.
    forget(&key);
    let none_there = generation(&key).unwrap();
    forget(&key);
    append(&key, &json!({ "n": 3 }));
    assert_eq!(confirm_synced(&key, &none_there), None);
    forget(&key);
}

/// A line for one history of a chat goes into that record or into
/// none (`append_in`): written and confirmed while the chat still has
/// the record, refused whole once it was forgotten, whatever has the
/// name by then.
#[test]
fn a_line_for_a_record_is_put_in_that_record_or_in_none() {
    let key = unique_key("append-in");
    append(&key, &json!({ "n": 1 }));
    let seen = generation(&key).unwrap();
    assert_eq!(
        append_in(&key, &seen, &json!({ "n": 2 })),
        (Held::Confirmed, Some(2))
    );
    assert_eq!(receipt(&key, &seen), Held::Confirmed);

    forget(&key);
    assert_eq!(
        append_in(&key, &seen, &json!({ "n": 3 })),
        (Held::Moved, None),
        "no record at all"
    );
    assert!(since(&key, 0).is_empty(), "and none was made for it");
    append(&key, &json!({ "new": true }));
    assert_eq!(
        append_in(&key, &seen, &json!({ "n": 3 })),
        (Held::Moved, None),
        "the record there now is another"
    );
    assert_eq!(receipt(&key, &seen), Held::Moved);
    let lines = since(&key, 0);
    assert_eq!(lines.len(), 1, "{lines:?}");
    assert_eq!(lines[0].event, json!({ "new": true }));

    // A record not made yet is one too: the line makes it.
    let fresh = unique_key("append-in-fresh");
    let none_yet = generation(&fresh).unwrap();
    assert_eq!(
        append_in(&fresh, &none_yet, &json!({ "n": 1 })),
        (Held::Confirmed, Some(1))
    );
    assert_eq!(
        append_in("not/a key", &none_yet, &json!({ "n": 1 })),
        (Held::Unconfirmed, None)
    );
    forget(&key);
    forget(&fresh);
}

/// A line `append_in` wrote is confirmed by the record's own receipt,
/// in a file that was already there too: with the folder's sync
/// failing it is written, numbered and not confirmed, and `receipt`
/// says the same of it until the sync goes through.
#[test]
fn a_line_put_in_a_record_is_confirmed_only_with_its_folder() {
    let key = unique_key("append-in-sync");
    append(&key, &json!({ "n": 1 }));
    let seen = generation(&key).unwrap();
    FAIL_DIR_SYNC.with(|fail| fail.set(true));
    assert_eq!(
        append_in(&key, &seen, &json!({ "n": 2 })),
        (Held::Unconfirmed, Some(2)),
        "written, and its folder not synced"
    );
    assert_eq!(receipt(&key, &seen), Held::Unconfirmed);
    assert_eq!(confirm_synced(&key, &seen), None);
    FAIL_DIR_SYNC.with(|fail| fail.set(false));
    assert_eq!(since(&key, 0).len(), 2, "the line is there all the while");
    assert_eq!(receipt(&key, &seen), Held::Confirmed);
    assert_eq!(generation(&key), Some(seen), "a receipt moves nothing");
    forget(&key);
}

/// The check of which record a chat has and the append are one step:
/// a chat cleared and written to again by another thread, at any
/// moment, never has a line that was meant for its old record. Each
/// round ends one of two ways: the line was refused (the clear came
/// first), or it went with the record it was written into (the clear
/// came after). A check made before the lock and an append made under
/// it lets the clear land between the two.
#[test]
fn a_cleared_record_never_gets_a_line_meant_for_the_one_before_it() {
    const ROUNDS: usize = 500;
    let (mut refused, mut cleared_away) = (0, 0);
    for round in 0..ROUNDS {
        let key = unique_key("append-in-race");
        append(&key, &json!({ "old": true }));
        let seen = generation(&key).unwrap();
        let together = std::sync::Arc::new(std::sync::Barrier::new(2));
        let clear = {
            let (key, together) = (key.clone(), together.clone());
            std::thread::spawn(move || {
                together.wait();
                forget(&key);
                append(&key, &json!({ "new": true }));
            })
        };
        together.wait();
        let (held, _) = append_in(&key, &seen, &json!({ "answer": "for the old record" }));
        clear.join().unwrap();
        let lines = since(&key, 0);
        assert_eq!(lines.len(), 1, "round {round}: {lines:?}");
        assert_eq!(lines[0].event, json!({ "new": true }), "round {round}");
        match held {
            Held::Moved => refused += 1,
            _ => cleared_away += 1,
        }
        forget(&key);
    }
    assert_eq!(refused + cleared_away, ROUNDS);
}

/// A record removed by its file alone (startup's tidy of transcripts no
/// chat points at) is forgotten the same way: its generation moves and
/// its count goes, so the next record under that name starts at one.
#[test]
fn a_record_removed_by_its_file_is_forgotten_like_any_other() {
    let key = unique_key("forget-file");
    append(&key, &json!({ "n": 1 }));
    assert_eq!(append(&key, &json!({ "n": 2 })), Some(2));
    let seen = generation(&key).unwrap();
    let path = path_for(&key).unwrap();
    assert!(forget_file(&path));
    assert!(!path.exists());
    assert!(!forget_file(&path), "nothing left to remove");
    assert_eq!(append(&key, &json!({ "n": 3 })), Some(1));
    assert_eq!(confirm_synced(&key, &seen), None);
    forget(&key);
}

/// A rewrite keeps every line in its place, so the record it leaves is
/// the same record: a compaction between a look and its receipt costs
/// nothing. Unless it replaced a host event's line, which a receipt may
/// be owed for: then the record is no longer the one that was seen.
#[test]
fn a_rewrite_is_the_same_record_unless_it_replaced_a_host_event() {
    let key = unique_key("rewrite-generation");
    // Text that quotes a host event's spelling is not one: the quotes
    // inside a string are escaped in the record.
    let quoted = json!({ "type": "user", "text": r#"long "type":"octiq_task_reopened""# });
    append(&key, &quoted);
    append(
        &key,
        &json!({ "type": "octiq_task_reopened", "taskId": "t" }),
    );
    let path = path_for(&key).unwrap();
    let seen = generation(&key).unwrap();

    let shorter = r#"{"type":"user","text":"short"}"#;
    let changed = rewrite_lines(&path, |line| {
        line.contains("long").then(|| shorter.to_string())
    });
    assert!(changed.unwrap());
    assert!(
        !rewrite_lines(&path, |_| None).unwrap(),
        "nothing to change"
    );
    assert_eq!(generation(&key), Some(seen.clone()));
    assert_eq!(confirm_synced(&key, &seen), Some(()));
    assert_eq!(of_type(&key, "octiq_task_reopened").len(), 1);

    let emptied = r#"{"type":"octiq_compacted","into":1}"#;
    let changed = rewrite_lines(&path, |line| {
        line.contains("taskId").then(|| emptied.to_string())
    });
    assert!(changed.unwrap());
    assert!(of_type(&key, "octiq_task_reopened").is_empty());
    assert_ne!(generation(&key), Some(seen.clone()));
    assert_eq!(confirm_synced(&key, &seen), None);
    forget(&key);
}

/// A resumed session's history becomes the start of the chat's record, so
/// reopening the chat replays it like anything else said there, and the
/// first turn afterwards is numbered after it.
#[test]
fn a_seeded_history_starts_the_record_and_turns_follow_it() {
    let key = unique_key("seeded");
    let history = [
        json!({"type":"user", "message":{"content":[{"type":"text","text":"earlier"}]}}),
        json!({"type":"assistant", "message":{"content":[{"type":"text","text":"reply"}]}}),
    ];
    assert_eq!(seed(&key, &history), Ok(true));
    let read = since(&key, 0);
    assert_eq!(read.iter().map(|r| r.seq).collect::<Vec<_>>(), vec![1, 2]);
    assert_eq!(read[0].event, history[0]);
    assert_eq!(append(&key, &json!({"type":"result"})), Some(3));

    // A restarted server counts the file rather than trusting memory.
    forget_count(&key);
    assert_eq!(append(&key, &json!({"type":"result"})), Some(4));
    forget(&key);
}

/// A chat something was already said in keeps its record exactly as it
/// is: seeding never writes over a conversation, nor slips lines into it.
#[test]
fn a_chat_with_a_record_is_never_seeded() {
    let key = unique_key("seed-refused");
    append(&key, &json!({"type":"system", "subtype":"init"}));
    assert_eq!(seed(&key, &[json!({"type":"user"})]), Ok(false));
    assert_eq!(since(&key, 0).len(), 1);

    // Known only from the file, as after a restart.
    forget_count(&key);
    assert_eq!(seed(&key, &[json!({"type":"user"})]), Ok(false));
    assert_eq!(since(&key, 0).len(), 1);
    forget(&key);

    assert!(seed("chat:with/slash", &[]).is_err());
}

/// A record whose second line is not UTF-8 (a write cut inside a
/// character), with whole lines written after it.
fn damaged_in_the_middle(name: &str) -> String {
    let key = unique_key(name);
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"{\"type\":\"user\",\"n\":1}\n");
    bytes.extend_from_slice(b"{\"type\":\"assistant\",\"text\":\"\xE4\xBD\n");
    bytes.extend_from_slice(b"{\"type\":\"assistant\",\"n\":3}\n");
    bytes.extend_from_slice(b"{\"type\":\"result\",\"n\":4}\n");
    fs::write(path_for(&key).unwrap(), bytes).unwrap();
    key
}

fn seqs(read: &[Recorded]) -> Vec<u64> {
    read.iter().map(|recorded| recorded.seq).collect()
}

/// Review of bf9d8cd, the carried Medium: `lines().map_while(Result::ok)`
/// ended a read at the first line that is not UTF-8, so a catch-up read
/// missed every event after it.
#[test]
fn a_line_that_is_not_utf8_hides_no_line_after_it() {
    let key = damaged_in_the_middle("damaged-read");
    assert_eq!(seqs(&since(&key, 0)), [1, 3, 4]);
    assert_eq!(seqs(&since(&key, 1)), [3, 4]);
    assert_eq!(since(&key, 3)[0].event["n"], 4);
    // And a page numbers the same lines the same way.
    assert_eq!(seqs(&page(&key, None).unwrap().events), [1, 3, 4]);
    assert_eq!(of_type(&key, "result").len(), 1);
    forget(&key);
}

/// The same line is still a line when the next one is numbered: a seq
/// is the physical line, for the count as for every reader.
#[test]
fn a_line_that_is_not_utf8_is_counted_when_the_next_line_is_numbered() {
    let key = damaged_in_the_middle("damaged-count");
    assert_eq!(append(&key, &json!({"type":"user","n":5})), Some(5));
    let read = since(&key, 4);
    assert_eq!(seqs(&read), [5]);
    assert_eq!(read[0].event["n"], 5);
    assert_eq!(seqs(&page(&key, None).unwrap().events), [1, 3, 4, 5]);
    // Nor is such a record an empty one to be seeded.
    forget_count(&key);
    assert_eq!(seed(&key, &[json!({"type":"user"})]), Ok(false));
    forget(&key);
}

/// Review of bf9d8cd, finding 1: the token was a bare number, so two
/// files that had both never moved on were taken for one. A token is
/// for the record it was read for.
#[test]
fn a_receipt_is_refused_for_a_record_other_than_the_one_its_token_was_taken_for() {
    let first = crate::test_dir::TestDir::new("receipt-first");
    let second = crate::test_dir::TestDir::new("receipt-second");
    let key = unique_key("receipt-record");
    let said = json!({"type":"assistant"});
    let token = {
        let _there = crate::profile::started_in(&first);
        assert!(append_synced(&key, &said).is_some());
        let token = generation(&key).unwrap();
        assert!(confirm_synced(&key, &token).is_some());
        token
    };

    let _elsewhere = crate::profile::started_in(&second);
    assert!(append(&key, &said).is_some());
    assert!(
        confirm_synced(&key, &token).is_none(),
        "a receipt for one record was given on another of the same name"
    );
    let own = generation(&key).unwrap();
    assert!(confirm_synced(&key, &own).is_some());
}

/// Review of bf9d8cd, finding 3: records were told apart by the text of
/// their path, so on a filesystem where two spellings are one file a
/// clear under one spelling left the other's receipt and count alone.
#[test]
fn two_spellings_of_a_record_are_one_record_where_the_filesystem_says_so() {
    let lower = unique_key("spelling");
    let upper = lower.to_uppercase();
    assert_eq!(append(&lower, &json!({"n":1})), Some(1));
    if !path_for(&upper).unwrap().exists() {
        // A filesystem that tells them apart: two records, each its own.
        assert_ne!(generation(&lower), generation(&upper));
        assert_eq!(append(&upper, &json!({"n":1})), Some(1));
        forget(&upper);
        assert_eq!(seqs(&since(&lower, 0)), [1]);
        forget(&lower);
        return;
    }

    assert_eq!(generation(&lower), generation(&upper));
    assert_eq!(append(&upper, &json!({"n":2})), Some(2));
    assert_eq!(
        append(&lower, &json!({"n":3})),
        Some(3),
        "one file was numbered by two counters"
    );
    assert_eq!(seqs(&since(&lower, 0)), [1, 2, 3]);

    let token = generation(&lower).unwrap();
    forget(&upper);
    assert!(!path_for(&lower).unwrap().exists());
    assert_eq!(
        append(&lower, &json!({"n":1})),
        Some(1),
        "the cleared record's count was kept under its other spelling"
    );
    assert!(
        confirm_synced(&lower, &token).is_none(),
        "a record cleared under its other spelling still gave a receipt"
    );
    forget(&lower);
}

/// Review of bf9d8cd, finding 5: a host event was known by the bytes
/// `"type":"octiq_`, so one written with other spacing could be
/// replaced without the record moving on. It is asked of the line's own
/// top-level `type` now.
#[test]
fn a_host_event_is_known_by_its_type_however_the_line_is_spaced() {
    assert!(is_host_event(
        br#"{"type":"octiq_task_reopened","taskId":"t"}"#
    ));
    assert!(is_host_event(
        br#"{ "taskId": "t", "type" : "octiq_task_reopened" }"#
    ));
    assert!(is_host_event(br#"{"type":"octiq_task_reopened"}"#));
    // What an agent says about one, or carries inside something else,
    // is not one.
    assert!(!is_host_event(
        br#"{"type":"assistant","text":"\"type\":\"octiq_task_reopened\""}"#
    ));
    assert!(!is_host_event(
        br#"{"type":"user","message":{"type":"octiq_task_reopened"}}"#
    ));
    assert!(!is_host_event(br#"{"n":1}"#));
    // A line that cannot be read is not known not to be one.
    assert!(is_host_event(b"{\"type\":\"octiq_task_reo"));
    assert!(is_host_event(b"\xff\xfe"));

    let key = unique_key("spaced-host-event");
    let path = path_for(&key).unwrap();
    fs::write(
        &path,
        "{ \"type\" : \"octiq_task_reopened\", \"taskId\" : \"t\" }\n",
    )
    .unwrap();
    let seen = generation(&key).unwrap();
    let replaced = rewrite_lines(&path, |_| Some(r#"{"type":"user"}"#.to_string()));
    assert!(replaced.unwrap());
    assert_eq!(confirm_synced(&key, &seen), None);
    forget(&key);
}

/// Capacity is not a history mutation. Live debt tokens remain known,
/// including more live tokens than the housekeeping batch size.
#[test]
fn generation_capacity_never_moves_live_tokens_and_dead_bookkeeping_is_bounded() {
    let record = |n: usize| PathBuf::from(format!("/chats/chat_{n}.jsonl"));
    let mut table = Generations::default();
    let held: Vec<_> = (0..40).map(|n| table.number(&record(n), 8)).collect();
    for n in 40..1_040 {
        drop(table.number(&record(n), 8));
        assert!(table.observed.len() <= held.len() + 8);
    }
    for (n, old) in held.iter().enumerate() {
        assert_eq!(table.number(&record(n), 8), *old, "untouched life {n}");
    }
    // Real moves remain observable after any amount of unrelated churn.
    table.move_on(&record(0));
    for n in 1_040..2_040 {
        drop(table.number(&record(n), 8));
        table.move_on(&record(n));
    }
    assert_ne!(table.number(&record(0), 8), held[0]);
    assert_eq!(table.number(&record(1), 8), held[1]);
    drop(held);
    for n in 2_040..3_040 {
        drop(table.number(&record(n), 8));
    }
    assert!(table.observed.len() <= 8);
    eprintln!(
        "generation bookkeeping after churn: {} entries, no floor",
        table.observed.len()
    );
}

/// The same for a record that is not there yet when it is asked about:
/// it is the record a later write makes, under either spelling.
#[test]
fn a_record_not_made_yet_is_the_one_a_write_under_another_spelling_makes() {
    let lower = unique_key("unmade");
    let upper = lower.to_uppercase();
    let before = generation(&lower).unwrap();
    assert!(append_synced(&upper, &json!({"n":1})).is_some());
    if !path_for(&lower).unwrap().exists() {
        forget(&upper);
        return;
    }
    assert_eq!(generation(&upper).unwrap(), before);
    assert!(confirm_synced(&lower, &before).is_some());

    forget(&upper);
    assert!(append(&lower, &json!({"n":1})).is_some());
    assert!(
        confirm_synced(&lower, &before).is_none(),
        "a record cleared under its other spelling still gave a receipt"
    );
    forget(&lower);
}
