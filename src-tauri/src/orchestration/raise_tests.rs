//! Review of b894867 (P3), H8: a raise of a chat's access level that cannot
//! be recorded is refused; a lowering never waits on a save.
//!
//! P3 let every `chat_set_access` through with the profile folder away,
//! under an exception written for ENDING work: Read to Edits answered Ok,
//! the live agent ran at Edits, and the ledger file still said Read. A raise
//! outlives the moment it is given (a host resume, a queued turn and the
//! next start all read it back), so it needs its record first.
//!
//! Through the real `dispatch` command, on the chat that coordinates a run
//! (the one chat whose level the ledger keeps), with a live stand-in whose
//! stdin is read back: a control message that should not have been sent
//! has somewhere to show up.
use super::tests::approved_plan;
use super::*;
use crate::agent_chat::{ChatAgent, TestChild};
use crate::agent_provider::Access;
use crate::dispatch::{settle_owed, told, Services, Told};
use crate::profile::tests::Home;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::process::ChildStdout;

/// The chat `approved_plan` makes the coordinator of its run.
const LEAD: &str = "chat:master";

/// How each kind of agent takes a new level, which is four different paths
/// through `chat_set_access`.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Path {
    /// A control message down the running process's stdin.
    ClaudeLive,
    /// The app-server thread's next `turn/start`.
    CodexThread,
    /// Antigravity between turns: its process is ended and the next one
    /// starts at the new level.
    Antigravity,
    /// A command-line agent: the next command's flags.
    CommandLine,
}

impl Path {
    const ALL: [Self; 4] = [
        Self::ClaudeLive,
        Self::CodexThread,
        Self::Antigravity,
        Self::CommandLine,
    ];

    fn agent(self) -> ChatAgent {
        match self {
            Self::ClaudeLive => ChatAgent::Claude,
            Self::CodexThread => ChatAgent::Codex,
            Self::Antigravity => ChatAgent::Antigravity,
            Self::CommandLine => ChatAgent::Pi,
        }
    }
}

/// A server with its profile folder on a drive of its own, and the lead's
/// chat running at `level`.
struct World {
    svc: Services,
    _process: crate::profile::Started,
    home: Home,
    path: Path,
    agent: TestChild,
    heard: BufReader<ChildStdout>,
}

impl World {
    fn new(path: Path, level: Access) -> Self {
        let home = Home::with_a_configured_base();
        let process = crate::profile::started_in(&home.dir);
        let svc = Services::at_profile();
        approved_plan(&svc.orchestrations, 1);
        svc.chats.test_start_at(LEAD, path.agent(), level);
        let (agent, heard) = svc.chats.test_hold_heard(LEAD, path.agent(), false);
        if path == Path::CodexThread {
            svc.chats.test_as_codex_thread(LEAD, level);
        }
        let world = Self {
            svc,
            _process: process,
            home,
            path,
            agent,
            heard,
        };
        world.runs_at(level);
        assert_eq!(on_disk(), Some(level), "the level a launch saves");
        world
    }

    fn folder_goes(&self) -> String {
        self.home.move_away();
        crate::profile::available().expect_err("the profile folder is away")
    }

    fn folder_returns(&self) {
        self.home.move_back();
        crate::profile::available().expect("the profile folder is back");
    }

    fn set(&self, access: &str) -> Told {
        told(
            &self.svc,
            "chat_set_access",
            json!({ "key": LEAD, "access": access }),
        )
    }

    /// Everything this server would start or resume the chat at.
    #[track_caller]
    fn runs_at(&self, level: Access) {
        assert_eq!(
            self.svc.chats.test_start_access(LEAD),
            Some(level),
            "{:?}: the level the next turn or process starts at",
            self.path
        );
        assert_eq!(
            self.svc
                .orchestrations
                .saved_resume_context(LEAD)
                .and_then(|start| start.access_level()),
            Some(level),
            "{:?}: the level a host resume starts at",
            self.path
        );
        if self.path == Path::CodexThread {
            assert_eq!(
                self.svc.chats.test_codex_access(LEAD),
                Some(level),
                "the level the thread's next turn starts at"
            );
        }
    }

    /// End the stand-in and read everything it was ever written.
    fn written(self) -> Vec<String> {
        self.svc.chats.test_end(LEAD);
        assert!(self.agent.gone());
        self.heard.lines().map_while(Result::ok).collect()
    }
}

/// The level the ledger FILE holds for the lead's chat.
fn on_disk() -> Option<Access> {
    let path = crate::profile::profile_dir().join("orchestrations.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    serde_json::from_value(saved["resume_contexts"][LEAD]["access"].clone()).ok()
}

/// What a server started now would resume the chat at.
fn after_a_restart() -> Option<Access> {
    OrchestrationStore::load_profile()
        .saved_resume_context(LEAD)
        .and_then(|start| start.access_level())
}

/// The reviewer's probe, on every path: Read to a higher level with the
/// folder away. It is refused in words that say the card is still open,
/// nothing is said as unsaved because nothing happened, the agent is told
/// nothing and keeps running, and nothing is assumed when the folder is
/// back. Then the same raise, with the folder there, is made and recorded.
#[test]
fn a_raise_that_cannot_be_recorded_is_refused_and_nothing_is_assumed_later() {
    for path in Path::ALL {
        let world = World::new(path, Access::Read);
        let why = world.folder_goes();

        let raised = world.set("auto");
        let said = raised
            .result
            .clone()
            .expect_err("a raise whose record cannot be kept went through");
        assert!(
            said.starts_with("The access level was not raised, and the card is still open: "),
            "{path:?}: {said}"
        );
        assert!(said.ends_with(&why), "{path:?}: {said}");
        assert!(raised.unsaved.is_empty(), "{path:?}: {:?}", raised.unsaved);
        world.runs_at(Access::Read);
        assert!(world.agent.alive(), "{path:?}: a refusal ended the agent");
        assert!(settle_owed(&world.svc).is_empty(), "{path:?}");

        world.folder_returns();
        assert!(settle_owed(&world.svc).is_empty());
        world.runs_at(Access::Read);
        assert_eq!(on_disk(), Some(Access::Read), "{path:?}");
        assert_eq!(after_a_restart(), Some(Access::Read), "{path:?}");

        // With the folder there the raise is made, and recorded first.
        let raised = world.set("auto");
        assert_eq!(raised.result, Ok(Value::Null), "{path:?}");
        assert!(raised.unsaved.is_empty(), "{path:?}: {:?}", raised.unsaved);
        world.runs_at(Access::Auto);
        assert_eq!(on_disk(), Some(Access::Auto), "{path:?}");

        // The agent was told of one change of level, the one that was made.
        let written = world.written();
        let changes = written
            .iter()
            .filter(|line| line.contains("set_permission_mode"))
            .count();
        assert_eq!(
            changes,
            usize::from(path == Path::ClaudeLive),
            "{path:?}: {written:?}"
        );
    }
}

/// A lowering is never held up: it takes hold at once, is said as not
/// recorded, and is written when the folder is back.
#[test]
fn a_lowering_takes_hold_at_once_while_the_profile_is_away_and_is_recorded_later() {
    for path in Path::ALL {
        let world = World::new(path, Access::Auto);
        let why = world.folder_goes();

        let lowered = world.set("read");
        assert_eq!(lowered.result, Ok(Value::Null), "{path:?}");
        assert!(
            lowered
                .unsaved
                .iter()
                .any(|u| u.what == "the chat's access level" && u.reason == why),
            "{path:?}: {:?}",
            lowered.unsaved
        );
        world.runs_at(Access::Read);
        assert_eq!(settle_owed(&world.svc), ["the ledger"], "{path:?}");
        // Antigravity takes a level in its next process, so this one ends.
        assert_eq!(
            world.agent.gone_soon(),
            path == Path::Antigravity,
            "{path:?}"
        );

        world.folder_returns();
        assert_eq!(on_disk(), Some(Access::Auto), "written while away");
        assert!(settle_owed(&world.svc).is_empty());
        assert_eq!(on_disk(), Some(Access::Read), "{path:?}");
        assert_eq!(after_a_restart(), Some(Access::Read), "{path:?}");

        let was_claude = path == Path::ClaudeLive;
        let written = world.written();
        let changes = written
            .iter()
            .filter(|line| line.contains("set_permission_mode"))
            .count();
        assert_eq!(changes, usize::from(was_claude), "{path:?}: {written:?}");
    }
}

/// Asking for the level the chat already has is not a raise: it needs no
/// record it does not have, and is not refused.
#[test]
fn asking_for_the_level_a_chat_already_has_is_not_refused_while_the_profile_is_away() {
    let world = World::new(Path::ClaudeLive, Access::Edits);
    world.folder_goes();
    let same = world.set("edits");
    assert_eq!(same.result, Ok(Value::Null));
    world.runs_at(Access::Edits);
    world.folder_returns();
    assert!(settle_owed(&world.svc).is_empty());
    assert_eq!(on_disk(), Some(Access::Edits));
    world.svc.chats.test_end(LEAD);
}
