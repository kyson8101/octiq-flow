//! When a Claude chat compacts its own context.
//!
//! Claude Code runs a headless session at a 1M-token window and compacts only
//! near its end, so a chat grows to hundreds of thousands of tokens and every
//! model call re-reads all of them. `CLAUDE_CODE_AUTO_COMPACT_WINDOW=<tokens>`
//! (verified on claude 2.1.330; at least 100,000) makes the session compact
//! at that size instead. Only a Claude launch is given it; a value the person
//! already passes down (the project's environment or the server's own) is
//! theirs and is left alone.
use super::ChatAgent;
use std::path::Path;

/// The variable Claude Code reads.
pub(super) const AUTO_COMPACT_WINDOW_VAR: &str = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";

/// An orchestration worker's window: one task, a brief and its own work.
const WORKER_WINDOW: u64 = 200_000;
/// Every other Claude chat: ordinary chats, lead threads, front desks.
const CHAT_WINDOW: u64 = 400_000;
/// The least Claude Code accepts, and the room a turn needs over the memory
/// files that every compaction keeps.
const WINDOW_FLOOR: u64 = 100_000;
/// Never more than this, however large the memory files are.
const WINDOW_CEILING: u64 = 900_000;

/// The memory files Claude Code loads from the launch folder itself. Parents
/// are not walked: this is a floor against a compaction loop, not a count.
const MEMORY_FILES: [&str; 4] = [
    "CLAUDE.md",
    "AGENTS.md",
    "CLAUDE.local.md",
    ".claude/CLAUDE.md",
];

/// The window for a launch, or `None` when it gets no variable: any provider
/// but Claude, or a launch that already passes one down (`inherited`).
///
/// A window close to what every turn carries anyway (the memory files survive
/// a compaction) compacts on every turn: a 100K window in a repository whose
/// AGENTS.md alone is about 83K tokens did exactly that. So the window is at
/// least the floor plus the memory files, at about three bytes a token.
pub(super) fn auto_compact_window(
    agent: ChatAgent,
    worker: bool,
    memory_bytes: u64,
    inherited: bool,
) -> Option<u64> {
    if agent != ChatAgent::Claude || inherited {
        return None;
    }
    let target = if worker { WORKER_WINDOW } else { CHAT_WINDOW };
    Some(
        target
            .max(WINDOW_FLOOR.saturating_add(memory_bytes / 3))
            .min(WINDOW_CEILING),
    )
}

/// The summed size of the memory files in `cwd`. A file that is missing,
/// unreadable or not a file counts nothing; this never fails a launch.
pub(super) fn memory_bytes(cwd: &Path) -> u64 {
    MEMORY_FILES
        .iter()
        .map(|name| {
            std::fs::metadata(cwd.join(name))
                .ok()
                .filter(|meta| meta.is_file())
                .map_or(0, |meta| meta.len())
        })
        .fold(0, u64::saturating_add)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_worker_compacts_sooner_than_a_chat() {
        let worker = auto_compact_window(ChatAgent::Claude, true, 0, false).unwrap();
        let chat = auto_compact_window(ChatAgent::Claude, false, 0, false).unwrap();
        assert!(worker < chat, "{worker} vs {chat}");
        assert!(worker >= WINDOW_FLOOR);
    }

    /// The loop guard: the window is raised only once the memory files take
    /// the floor past the role's target, and from exactly that byte.
    #[test]
    fn large_memory_files_raise_the_window_from_the_point_they_would_crowd_it() {
        for worker in [true, false] {
            let target = auto_compact_window(ChatAgent::Claude, worker, 0, false).unwrap();
            let edge = (target - WINDOW_FLOOR) * 3;
            assert_eq!(
                auto_compact_window(ChatAgent::Claude, worker, edge, false),
                Some(target),
                "at the edge the target still stands"
            );
            assert_eq!(
                auto_compact_window(ChatAgent::Claude, worker, edge + 3, false),
                Some(target + 1),
                "past it, the floor plus the memory wins"
            );
        }
    }

    #[test]
    fn the_window_never_passes_the_ceiling() {
        let at = (WINDOW_CEILING - WINDOW_FLOOR) * 3;
        for worker in [true, false] {
            assert_eq!(
                auto_compact_window(ChatAgent::Claude, worker, at, false),
                Some(WINDOW_CEILING)
            );
            assert_eq!(
                auto_compact_window(ChatAgent::Claude, worker, at + 3, false),
                Some(WINDOW_CEILING)
            );
            assert_eq!(
                auto_compact_window(ChatAgent::Claude, worker, u64::MAX, false),
                Some(WINDOW_CEILING)
            );
        }
    }

    #[test]
    fn only_claude_gets_a_window_and_never_over_the_persons_own() {
        for agent in ChatAgent::ALL {
            for worker in [true, false] {
                let window = auto_compact_window(agent, worker, 0, false);
                assert_eq!(window.is_some(), agent == ChatAgent::Claude, "{agent:?}");
                assert_eq!(auto_compact_window(agent, worker, 0, true), None);
            }
        }
    }

    #[test]
    fn memory_is_the_four_files_in_the_launch_folder_and_nothing_above_it() {
        let home = crate::test_dir::TestDir::new("auto-compact-memory");
        let cwd = home.join("project");
        std::fs::create_dir(&cwd).unwrap();
        std::fs::create_dir(cwd.join(".claude")).unwrap();
        // Above the launch folder: not counted.
        std::fs::write(home.join("CLAUDE.md"), vec![b'x'; 1_000]).unwrap();
        assert_eq!(memory_bytes(&cwd), 0, "missing files count nothing");
        std::fs::write(cwd.join("CLAUDE.md"), vec![b'x'; 1]).unwrap();
        std::fs::write(cwd.join("AGENTS.md"), vec![b'x'; 10]).unwrap();
        std::fs::write(cwd.join("CLAUDE.local.md"), vec![b'x'; 100]).unwrap();
        std::fs::write(cwd.join(".claude/CLAUDE.md"), vec![b'x'; 200]).unwrap();
        // A folder by one of the names is not a file.
        std::fs::create_dir(cwd.join(".claude/AGENTS.md")).unwrap();
        assert_eq!(memory_bytes(&cwd), 311);
        assert_eq!(memory_bytes(&home.join("gone")), 0);
    }
}
