//! An agent's memory note in two parts: a curated `## Lessons` section under
//! its header, and the dated entries `vault_agent_memory_append` adds below.
//!
//! Why two parts: the entries are append-only, so a note only grows, and the
//! vault's read pages from the top. A long note showed its agent its OLDEST
//! entries (one ran to 962 lines; the first 200 were all a read returned) and
//! never the newest. So:
//!
//! - **A read** (`view`) returns the header, the Lessons section whole, and
//!   the newest entries that fit a budget, saying how many older ones it left
//!   out and where they start. `startLine` still pages the raw note.
//! - **The Lessons section** is the one part of the note that is rewritten.
//!   The agent proposes the whole new section (`propose`); the person sees it
//!   beside the text it replaces on a one-off permission card, and only their
//!   Allow writes it — as one exact patch of that section, against the note as
//!   it is after the Allow, so an entry appended meanwhile is kept and a
//!   section changed meanwhile is never overwritten. The dated entries are
//!   never touched: what an agent once recorded stays recoverable.
use std::future::Future;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::memory_vault::Vault;
use crate::outcome::{ReasonClass, Refusal};
use crate::permission::Answer;
use crate::team::TeamAgent;

pub const LESSONS_HEADING: &str = "## Lessons";
/// The longest Lessons section. Short on purpose: it is read at the start of
/// every task, so it holds what still holds, not everything that happened.
pub const LESSONS_MAX: usize = 6000;
/// At most this many dated entries in a read…
const RECENT_ENTRIES: usize = 12;
/// …and at most this many characters of them (the newest one is always shown).
const RECENT_CHARS: usize = 16_000;
/// Entries past which a note with no Lessons section is told to distil one.
const DISTIL_AFTER: usize = 8;
/// Pages of 400 lines a read gathers before giving up: past the vault's 1 MiB
/// note limit for any note of real lines.
const MAX_PAGES: usize = 200;
/// The shortest and longest the person's card may stay up.
const WAIT_MIN: Duration = Duration::from_secs(15);

/// `vault_agent_memory_lessons`' arguments.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LessonsProposal {
    /// The whole new Lessons section, without its heading.
    pub lessons: String,
    /// How long the card may stay up, in seconds; set by the MCP from what
    /// its provider waits for a tool call, clamped by the host.
    #[serde(default)]
    pub wait_seconds: Option<u64>,
}

/// `## YYYY-MM-DD`, the heading `memory_append` writes for an entry.
fn is_entry_heading(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("## ") else {
        return false;
    };
    let date = rest.trim_end();
    date.len() == 10
        && date.chars().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == '-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// Where the parts of a note are, as line indexes.
#[derive(Debug, PartialEq, Eq)]
struct Layout {
    /// The Lessons heading and the line after its section (exclusive).
    lessons: Option<(usize, usize)>,
    /// Each dated entry's heading.
    entries: Vec<usize>,
    /// The first `## ` line: where a Lessons section goes when there is none.
    first_section: usize,
}

fn layout(lines: &[&str]) -> Layout {
    let entries: Vec<usize> = (0..lines.len())
        .filter(|&i| is_entry_heading(lines[i]))
        .collect();
    let before = entries.first().copied().unwrap_or(lines.len());
    // Only a Lessons heading above the first entry is the section: one an
    // agent wrote inside an entry is that entry's text.
    let lessons = (0..before)
        .find(|&i| lines[i].trim_end() == LESSONS_HEADING)
        .map(|start| {
            let end = (start + 1..lines.len())
                .find(|&i| lines[i].starts_with("## "))
                .unwrap_or(lines.len());
            (start, end)
        });
    let first_section = (0..lines.len())
        .find(|&i| lines[i].starts_with("## "))
        .unwrap_or(lines.len());
    Layout {
        lessons,
        entries,
        first_section,
    }
}

/// The Lessons section's text without its heading, or None when it has none.
fn lessons_of(lines: &[&str], layout: &Layout) -> Option<String> {
    let (start, end) = layout.lessons?;
    Some(lines[start + 1..end].join("\n").trim().to_owned())
}

/// What a read of a memory note answers with, beyond the vault's own fields.
#[derive(Debug, PartialEq, Eq)]
pub struct View {
    pub content: String,
    pub entries: usize,
    pub shown: usize,
    pub has_lessons: bool,
    /// Lines (1-based, inclusive) of the entries left out, when any were.
    pub older_lines: Option<(usize, usize)>,
}

/// The note as an agent should load it: everything above the first dated
/// entry (header and Lessons) whole, then the newest entries that fit.
pub fn view(text: &str) -> View {
    let lines: Vec<&str> = text.lines().collect();
    let layout = layout(&lines);
    let first = layout.entries.first().copied().unwrap_or(lines.len());
    let head = lines[..first].join("\n").trim_end().to_owned();
    let blocks: Vec<(usize, String)> = layout
        .entries
        .iter()
        .enumerate()
        .map(|(n, &start)| {
            let end = layout.entries.get(n + 1).copied().unwrap_or(lines.len());
            (start, lines[start..end].join("\n").trim_end().to_owned())
        })
        .collect();
    let mut chars = 0;
    let mut shown = 0;
    for (_, block) in blocks.iter().rev() {
        let size = block.chars().count();
        if shown > 0 && (shown == RECENT_ENTRIES || chars + size > RECENT_CHARS) {
            break;
        }
        chars += size;
        shown += 1;
    }
    let older = blocks.len() - shown;
    let older_lines = (older > 0).then(|| (blocks[0].0 + 1, blocks[older].0));
    let mut content = head;
    if let Some((from, to)) = older_lines {
        content.push_str(&format!(
            "\n\n_{older} older {} (lines {from}–{to}) not shown here: read them with startLine {from}._",
            if older == 1 { "entry" } else { "entries" }
        ));
    }
    for (_, block) in &blocks[older..] {
        content.push_str("\n\n");
        content.push_str(block);
    }
    View {
        content: content.trim_start().to_owned(),
        entries: blocks.len(),
        shown,
        has_lessons: layout.lessons.is_some(),
        older_lines,
    }
}

/// The view's fields, as the read tool answers with them.
pub fn view_fields(view: &View) -> Value {
    let mut fields = json!({
        "content": view.content,
        "entries": view.entries,
        "entriesShown": view.shown,
        "hasLessons": view.has_lessons,
    });
    if let Some((from, _)) = view.older_lines {
        fields["olderEntriesFrom"] = from.into();
    }
    if !view.has_lessons && view.entries > DISTIL_AFTER {
        fields["lessonsHint"] = "This memory has no Lessons section yet. Distil what still holds from its entries into one with vault_agent_memory_lessons.".into();
    } else if view.older_lines.is_some() {
        fields["lessonsHint"] = "Older entries are not shown. If any of them still holds and is not in your Lessons, propose updated Lessons with vault_agent_memory_lessons.".into();
    }
    fields
}

/// A whole note, gathered page by page (the vault reads at most 400 lines at
/// a time), with its revision. A note that changed between pages is read again.
pub fn read_all(vault: &Vault, actor: &str, path: &str) -> Result<(String, Value), String> {
    'again: for _ in 0..3 {
        let mut text: Vec<String> = Vec::new();
        let mut first: Option<Value> = None;
        let mut start = 1u64;
        for _ in 0..MAX_PAGES {
            let page = vault.call(
                actor,
                "read",
                &json!({ "path": path, "startLine": start, "lineCount": 400 }),
            )?;
            if let Some(first) = &first {
                if first.get("revision") != page.get("revision") {
                    continue 'again;
                }
            }
            text.push(
                page.get("content")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
            );
            let next = page.get("nextLine").and_then(Value::as_u64);
            if first.is_none() {
                first = Some(page);
            }
            match next {
                Some(next) => start = next,
                None => return Ok((text.join("\n"), first.unwrap_or_default())),
            }
        }
        return Err("The memory note is too long to read whole; read it with startLine.".into());
    }
    Err("The memory note kept changing while it was read; read it again.".into())
}

/// The Lessons text an agent proposed, as it would be stored.
pub fn check_lessons(text: &str) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(
            "Pass the whole Lessons section: what still holds, in a few short lines.".into(),
        );
    }
    if text.chars().count() > LESSONS_MAX {
        return Err(format!(
            "Keep the Lessons under {LESSONS_MAX} characters: what still holds, not everything that happened."
        ));
    }
    if text
        .lines()
        .any(|line| line.starts_with("# ") || line.starts_with("## "))
    {
        return Err("Lessons may not hold `#` or `##` headings; use `###` or a list.".into());
    }
    Ok(text.to_owned())
}

/// The one exact patch that makes `lessons` the note's Lessons section:
/// the text it replaces and the text it becomes. Every line outside the
/// section is kept, the dated entries included.
fn patch(lines: &[&str], layout: &Layout, lessons: &str) -> (String, String) {
    let section = format!("{LESSONS_HEADING}\n\n{lessons}");
    match layout.lessons {
        // The section and the heading after it, so the match is anchored.
        Some((start, end)) if end < lines.len() => (
            lines[start..=end].join("\n"),
            format!("{section}\n\n{}", lines[end]),
        ),
        Some((start, _)) => (lines[start..].join("\n"), section),
        // None yet: from the top of the note down to the first section,
        // which nothing else in the note can repeat.
        None if layout.first_section < lines.len() => {
            let at = layout.first_section;
            (
                lines[..=at].join("\n"),
                format!(
                    "{}\n\n{section}\n\n{}",
                    lines[..at].join("\n").trim_end(),
                    lines[at]
                ),
            )
        }
        None => {
            let all = lines.join("\n");
            let with = format!("{}\n\n{section}", all.trim_end());
            (all, with)
        }
    }
}

/// The card's wording: the whole new section beside the one it replaces.
pub fn describe(agent: &str, path: &str, before: Option<&str>, after: &str) -> String {
    let what = format!(
        "{} the Lessons section of {agent}'s memory ({path}). Its dated entries stay exactly as they are.",
        if before.is_some() { "Replace" } else { "Add" }
    );
    let mut text = format!(
        "{what}\n\nNew Lessons ({} characters):\n{after}",
        after.chars().count()
    );
    if let Some(before) = before {
        text.push_str(&format!(
            "\n\nReplacing ({} characters):\n{}",
            before.chars().count(),
            if before.is_empty() { "(empty)" } else { before }
        ));
    }
    text
}

/// How long the card stays up for this call.
fn wait_for(requested: Option<u64>) -> Duration {
    requested
        .map(Duration::from_secs)
        .unwrap_or(crate::permission::ANSWER_TIMEOUT)
        .clamp(WAIT_MIN, crate::permission::ANSWER_TIMEOUT)
}

/// How the person answered, as the agent reads it. `Ok` only on an Allow.
fn approved(answer: &Answer, wait: Duration) -> Result<(), Refusal> {
    let Some(outcome) = crate::outcome::of_permission(answer) else {
        return Ok(());
    };
    let message = match outcome.reason_class {
        ReasonClass::ApprovalExpired => format!(
            "The person did not answer within {} seconds, so your Lessons were not changed. Tell them what you proposed and call again when they are ready to approve it.",
            wait.as_secs()
        ),
        ReasonClass::ApprovalDenied => {
            "The person declined it, so your Lessons were not changed.".into()
        }
        _ => "Nobody has OctiqFlow open to approve this, so your Lessons were not changed.".into(),
    };
    Err(Refusal { message, outcome })
}

/// Propose a new Lessons section for `me`'s own memory, put it to the person,
/// and write it only on their Allow. `ask` raises the card and waits.
pub async fn propose<A, F>(
    vault: &Vault,
    actor: &str,
    me: &TeamAgent,
    proposal: LessonsProposal,
    ask: A,
) -> Result<Value, Refusal>
where
    A: FnOnce(crate::permission::Request) -> F,
    F: Future<Output = Answer>,
{
    let invalid = |error: String| Refusal::new(ReasonClass::Validation, error);
    let lessons = check_lessons(&proposal.lessons).map_err(invalid)?;
    let path = me
        .memory_note
        .clone()
        .ok_or_else(|| invalid(format!("{} has no memory note yet.", me.name)))?;
    crate::team::ensure_memory(vault, actor, me)?;
    let (text, _) = read_all(vault, actor, &path)?;
    let lines: Vec<&str> = text.lines().collect();
    let before = lessons_of(&lines, &layout(&lines));
    if before.as_deref() == Some(lessons.as_str()) {
        return Err(invalid("Those are already your Lessons.".into()));
    }
    let wait = wait_for(proposal.wait_seconds);
    let request = crate::permission::Request {
        chat_key: Some(actor.to_string()),
        tool_name: Some("mcp__octiq__vault_agent_memory_lessons".into()),
        tool_input: Some(json!({
            "change": describe(&me.name, &path, before.as_deref(), &lessons),
        })),
        once: true,
        answer_within_secs: Some(wait.as_secs()),
        ..Default::default()
    };
    approved(&ask(request).await, wait)?;

    // The note as it is now. An entry appended while the card was up is
    // fine — the patch leaves it alone — but a section that moved is not what
    // the person approved replacing.
    let (text, page) = read_all(vault, actor, &path)?;
    let lines: Vec<&str> = text.lines().collect();
    let now = layout(&lines);
    if lessons_of(&lines, &now) != before {
        return Err(Refusal::new(
            ReasonClass::Other,
            "Your Lessons changed while the card was up, so nothing was written. Read your memory again and propose from what is there now.",
        ));
    }
    let revision = page
        .get("revision")
        .and_then(Value::as_str)
        .ok_or("Could not read the memory note's revision.")?
        .to_owned();
    let (old_text, new_text) = patch(&lines, &now, &lessons);
    let request_id = format!(
        "agent-memory-lessons-{}-{:x}",
        me.id,
        Sha256::digest(format!("{revision}\n{lessons}").as_bytes())
    );
    let receipt = vault.call(
        actor,
        "patch",
        &json!({
            "path": path,
            "oldText": old_text,
            "newText": new_text,
            "expectedRevision": revision,
            "requestId": &request_id[..request_id.len().min(128)],
        }),
    )?;
    match receipt.get("status").and_then(Value::as_str) {
        Some("saved") => Ok(json!({
            "status": "saved",
            "text": "The person approved it: your Lessons are saved. Your dated entries are unchanged.",
            "agent": me.name,
            "path": path,
            "lessons": lessons,
            "receipt": receipt,
        })),
        other => {
            let id = receipt.get("id").and_then(Value::as_str).unwrap_or("");
            Err(Refusal::new(
                ReasonClass::Other,
                format!(
                    "The Lessons write was not confirmed ({}). Receipt {id} needs review; check it with vault_receipt.",
                    other.unwrap_or("unknown")
                ),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const SEED: &str = "---\ntype: agent-memory\nagent: Nova\nagent-id: agent_n\n---\n\n# Nova — memory\n\nWorking memory for Nova.\n";

    fn entries(n: usize) -> String {
        (1..=n)
            .map(|i| format!("\n## 2026-09-{i:02}\n\nEntry {i}.\n"))
            .collect()
    }

    struct Fixture {
        vault: Vault,
        root: std::path::PathBuf,
        me: TeamAgent,
        _base: crate::test_dir::TestDir,
    }

    impl Fixture {
        fn new(note: &str) -> Self {
            let base = crate::test_dir::TestDir::new("memory-lessons");
            let root = base.join("vault");
            std::fs::create_dir_all(root.join("agent-zone/agents/nova")).unwrap();
            std::fs::write(root.join("agent-zone/agents/nova/memory.md"), note).unwrap();
            let vault = Vault::at(base.join("profile"));
            vault
                .configure(crate::memory_vault::Config {
                    path: root.to_string_lossy().into_owned(),
                    writable: true,
                })
                .unwrap();
            let me: TeamAgent = serde_json::from_value(json!({
                "id": "agent_n", "name": "Nova", "role": "", "agent": "claude",
                "model": "m", "access": "auto",
                "memoryNote": "agent-zone/agents/nova/memory.md",
                "createdAt": 0, "updatedAt": 0,
            }))
            .unwrap();
            Self {
                vault,
                root,
                me,
                _base: base,
            }
        }

        fn note(&self) -> String {
            std::fs::read_to_string(self.root.join("agent-zone/agents/nova/memory.md")).unwrap()
        }

        async fn propose(&self, lessons: &str, decision: &'static str) -> Result<Value, Refusal> {
            propose(
                &self.vault,
                "chat:lead",
                &self.me,
                LessonsProposal {
                    lessons: lessons.into(),
                    wait_seconds: None,
                },
                move |_| {
                    std::future::ready(Answer {
                        decision,
                        // A Deny's reason is the host's own word for it.
                        reason: if decision == "allow" {
                            String::new()
                        } else {
                            crate::permission::DENIED.into()
                        },
                    })
                },
            )
            .await
        }
    }

    #[test]
    fn a_long_note_shows_its_newest_entries_not_its_oldest() {
        let note = format!("{SEED}{}", entries(30));
        let shown = view(&note);
        assert_eq!(shown.entries, 30);
        assert_eq!(shown.shown, RECENT_ENTRIES);
        assert!(shown.content.contains("Entry 30."), "{}", shown.content);
        assert!(!shown.content.contains("Entry 1."));
        assert!(shown.content.starts_with("---\ntype: agent-memory"));
        // Where the left-out entries are, in the note's own numbering.
        let lines: Vec<&str> = note.lines().collect();
        let (from, to) = shown.older_lines.unwrap();
        assert_eq!(lines[from - 1], "## 2026-09-01");
        assert_eq!(
            lines[to], "## 2026-09-19",
            "the line after the range is the first shown"
        );
        assert!(shown
            .content
            .contains(&format!("read them with startLine {from}")));
        let fields = view_fields(&shown);
        assert!(fields["lessonsHint"]
            .as_str()
            .unwrap()
            .contains("no Lessons section"));
    }

    #[test]
    fn the_lessons_are_always_shown_and_one_huge_entry_still_is() {
        let big = "x".repeat(RECENT_CHARS + 10);
        let note = format!(
            "{SEED}\n## Lessons\n\n- Keep it short.\n{}\n## 2026-10-01\n\n{big}\n",
            entries(3)
        );
        let shown = view(&note);
        assert!(shown.has_lessons);
        assert!(shown.content.contains("## Lessons\n\n- Keep it short."));
        assert_eq!(shown.shown, 1, "the newest entry is shown however long");
        assert!(shown.content.ends_with(&big));
        // A short note is shown whole, with no hint.
        let short = view(&format!("{SEED}{}", entries(2)));
        assert_eq!(
            (short.entries, short.shown, short.older_lines),
            (2, 2, None)
        );
        assert!(view_fields(&short).get("lessonsHint").is_none());
    }

    #[test]
    fn a_lessons_heading_inside_an_entry_is_that_entrys_text() {
        let note = format!("{SEED}\n## 2026-09-01\n\n## Lessons\n\nnot the section\n");
        let lines: Vec<&str> = note.lines().collect();
        assert_eq!(layout(&lines).lessons, None);
    }

    #[test]
    fn proposed_lessons_are_checked() {
        assert!(check_lessons("  ").is_err());
        assert!(check_lessons(&"x".repeat(LESSONS_MAX + 1)).is_err());
        assert!(check_lessons("## 2026-01-01\nfake entry").is_err());
        assert!(check_lessons("# Title").is_err());
        assert_eq!(check_lessons("\n### Git\n- a\n").unwrap(), "### Git\n- a");
    }

    #[tokio::test]
    async fn lessons_are_added_above_the_entries_only_on_allow_and_the_entries_are_kept() {
        let note = format!("{SEED}{}", entries(3));
        let f = Fixture::new(&note);
        let denied = f.propose("- Use worktrees.", "deny").await.unwrap_err();
        assert_eq!(denied.outcome.reason_class, ReasonClass::ApprovalDenied);
        assert_eq!(f.note(), note, "a Deny writes nothing");

        let saved = f.propose("- Use worktrees.", "allow").await.unwrap();
        assert_eq!(saved["status"], "saved");
        let after = f.note();
        assert_eq!(
            after,
            format!(
                "{}\n\n## Lessons\n\n- Use worktrees.\n\n## 2026-09-01\n\nEntry 1.\n\n## 2026-09-02\n\nEntry 2.\n\n## 2026-09-03\n\nEntry 3.\n",
                SEED.trim_end()
            )
        );

        // Replacing them touches the section and nothing else.
        f.propose("- Use worktrees.\n- Ask before restarting.", "allow")
            .await
            .unwrap();
        let replaced = f.note();
        assert!(replaced
            .contains("## Lessons\n\n- Use worktrees.\n- Ask before restarting.\n\n## 2026-09-01"));
        assert!(replaced.ends_with("## 2026-09-03\n\nEntry 3.\n"));
        assert_eq!(replaced.matches("## Lessons").count(), 1);

        let same = f
            .propose("- Use worktrees.\n- Ask before restarting.", "allow")
            .await
            .unwrap_err();
        assert_eq!(same.outcome.reason_class, ReasonClass::Validation);
    }

    #[tokio::test]
    async fn a_note_with_no_entries_gets_its_lessons_at_the_end() {
        let f = Fixture::new(SEED);
        f.propose("- First lesson.", "allow").await.unwrap();
        assert_eq!(
            f.note(),
            format!("{}\n\n## Lessons\n\n- First lesson.\n", SEED.trim_end())
        );
        f.propose("- Second lesson.", "allow").await.unwrap();
        assert_eq!(
            f.note(),
            format!("{}\n\n## Lessons\n\n- Second lesson.\n", SEED.trim_end())
        );
    }

    #[tokio::test]
    async fn an_entry_appended_while_the_card_was_up_is_kept_and_a_moved_section_is_not_overwritten(
    ) {
        let note = format!("{SEED}\n## Lessons\n\n- Old.\n{}", entries(1));
        let f = Fixture::new(&note);
        let path = f.root.join("agent-zone/agents/nova/memory.md");
        let shown = Arc::new(Mutex::new(None));
        let seen = shown.clone();
        let appended = path.clone();
        propose(
            &f.vault,
            "chat:lead",
            &f.me,
            LessonsProposal {
                lessons: "- New.".into(),
                wait_seconds: None,
            },
            move |request: crate::permission::Request| {
                *seen.lock().unwrap() = request.tool_input.clone();
                let mut text = std::fs::read_to_string(&appended).unwrap();
                text.push_str("\n## 2026-09-02\n\nWritten meanwhile.\n");
                std::fs::write(&appended, text).unwrap();
                std::future::ready(Answer {
                    decision: "allow",
                    reason: String::new(),
                })
            },
        )
        .await
        .unwrap();
        let card = shown.lock().unwrap().clone().unwrap();
        let change = card["change"].as_str().unwrap();
        assert!(
            change.contains("New Lessons (6 characters):\n- New."),
            "{change}"
        );
        assert!(
            change.contains("Replacing (6 characters):\n- Old."),
            "{change}"
        );
        let after = f.note();
        assert!(after.contains("## Lessons\n\n- New.\n\n## 2026-09-01"));
        assert!(after.ends_with("Written meanwhile.\n"));

        // The section itself edited while the card was up: refused.
        let moved = path.clone();
        let refused = propose(
            &f.vault,
            "chat:lead",
            &f.me,
            LessonsProposal {
                lessons: "- Mine.".into(),
                wait_seconds: None,
            },
            move |_| {
                let text = std::fs::read_to_string(&moved).unwrap();
                std::fs::write(&moved, text.replace("- New.", "- Edited by hand.")).unwrap();
                std::future::ready(Answer {
                    decision: "allow",
                    reason: String::new(),
                })
            },
        )
        .await
        .unwrap_err();
        assert!(refused.message.contains("changed while the card was up"));
        assert!(f.note().contains("- Edited by hand."));
    }

    #[test]
    fn a_long_note_is_read_whole_across_pages() {
        let note = format!("{SEED}{}", entries(28).repeat(10));
        let f = Fixture::new(&note);
        let (text, page) =
            read_all(&f.vault, "chat:lead", f.me.memory_note.as_deref().unwrap()).unwrap();
        assert!(note.lines().count() > 800);
        assert_eq!(text, note.trim_end_matches('\n'));
        assert!(page["revision"].is_string());
    }
}
