//! What an action did that could not be written down.
//!
//! An action that ENDS work or ANSWERS a waiting agent never waits on a
//! save: Stop stops, an answer reaches the call parked on it, and the save
//! is tried beside it. When that save fails the action has still happened,
//! so the command's answer is its ordinary one, and what could not be kept
//! is said here, at the place the save failed (`say`):
//!
//! * to whoever asked: `told` collects every `say` made while one command
//!   runs on this thread. The socket puts them beside the result
//!   (`"unsaved": [{ what, reason }]`) and an agent's hook call gets the same
//!   list in its result;
//! * to every open page, as the bus event `unsaved`;
//! * to the server's log.
//!
//! It says nothing about making the save good later. The store that failed
//! remembers that it owes one and tries again (`dispatch::settle_owed`).
use std::cell::RefCell;

use serde::Serialize;

/// One part of an action's record that is not on disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Unsaved {
    /// What was done and not recorded, as a noun phrase the page can put in
    /// a sentence: "the cancelled auto-resume", "the stopped task".
    pub what: String,
    /// Why, in the words of whatever refused the write. For a profile
    /// folder that is away this is the profile's own sentence.
    pub reason: String,
}

thread_local! {
    /// What the command running on this (pooled) thread could not record,
    /// while `told` is listening.
    static TOLD: RefCell<Option<Vec<Unsaved>>> = const { RefCell::new(None) };
}

/// Say that `what` happened and could not be recorded.
pub fn say(what: &str, reason: impl Into<String>) {
    let unsaved = Unsaved {
        what: what.to_string(),
        reason: reason.into(),
    };
    eprintln!(
        "[unsaved] {} could not be recorded: {}",
        unsaved.what, unsaved.reason
    );
    crate::bus::emit("unsaved", &unsaved);
    TOLD.with(|told| {
        if let Some(list) = told.borrow_mut().as_mut() {
            if !list.contains(&unsaved) {
                list.push(unsaved);
            }
        }
    });
}

/// Run one command and hand back what it said it could not record, leaving
/// this thread with no list however the command ends.
pub fn told<T>(run: impl FnOnce() -> T) -> (T, Vec<Unsaved>) {
    struct Listening(Option<Vec<Unsaved>>);
    impl Drop for Listening {
        fn drop(&mut self) {
            let before = self.0.take();
            TOLD.with(|told| *told.borrow_mut() = before);
        }
    }
    let before = TOLD.with(|told| told.borrow_mut().replace(Vec::new()));
    let mut listening = Listening(before);
    let result = run();
    let said = TOLD
        .with(|told| {
            let mut told = told.borrow_mut();
            std::mem::replace(&mut *told, listening.0.take())
        })
        .unwrap_or_default();
    std::mem::forget(listening);
    (result, said)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_command_is_told_what_it_could_not_record_and_the_next_one_is_not() {
        let (answer, said) = told(|| {
            say("the cancelled auto-resume", "the folder is away");
            say("the cancelled auto-resume", "the folder is away");
            say("the cancelled questions", "the folder is away");
            7
        });
        assert_eq!(answer, 7);
        assert_eq!(
            said.iter().map(|s| s.what.as_str()).collect::<Vec<_>>(),
            ["the cancelled auto-resume", "the cancelled questions"],
            "said once each, in order"
        );
        assert_eq!(said[0].reason, "the folder is away");

        // Nothing is listening now: a save that fails outside a command is
        // logged and broadcast, and no later command inherits it.
        say("the stopped task", "the folder is away");
        let ((), said) = told(|| {});
        assert!(said.is_empty(), "{said:?}");
    }

    #[test]
    fn a_command_that_panics_leaves_nothing_for_the_next_on_its_thread() {
        let caught = std::panic::catch_unwind(|| {
            told(|| {
                say("the stopped task", "the folder is away");
                panic!("the command fell over");
            })
        });
        assert!(caught.is_err());
        let ((), said) = told(|| {});
        assert!(said.is_empty(), "{said:?}");
        TOLD.with(|told| assert!(told.borrow().is_none()));
    }
}
