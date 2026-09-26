//! Reading a person's chat message as consent to a plan — or, far more often,
//! as not.
//!
//! A lead may approve its own plan on the person's behalf only when the
//! person's WHOLE turn says nothing but "approve": a word from a short list,
//! at most one plan handle, and politeness. Anything else — a second line
//! asking for a change, a question mark, a negation, a condition, a quote, a
//! name the grammar does not know — is not consent, and the lead is told to
//! treat it as a message instead. The grammar is a whitelist on purpose: a
//! blacklist of "not", "but" and "if" is one missed phrasing away from
//! approving something the person asked to change.
//!
//! Missing a real approval costs one click on the plan card. Inventing one
//! starts workers nobody agreed to. Every tie goes to "not consent".

/// What an approving message said about WHICH plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Consent {
    /// The plan handle the person typed ("approve plan 2278"), lowercase.
    /// `None` means "this plan", which is only enough when one plan is shown.
    pub handle: Option<String>,
}

/// The longest message that can still be a plain approval.
const MAX_CHARS: usize = 160;

/// The short name a plan goes by in conversation: the first four hex digits of
/// its run id. Printed on the plan card, so the person can name one plan when
/// several wait.
pub fn plan_handle(run_id: &str) -> String {
    run_id
        .strip_prefix("run_")
        .unwrap_or(run_id)
        .chars()
        .filter(char::is_ascii_hexdigit)
        .take(4)
        .collect::<String>()
        .to_ascii_lowercase()
}

pub const NOT_CONSENT: &str = "The person's message is not a plain approval, so nothing was approved. Only a message that says just \"approve this plan\" (or \"approve plan <handle>\") approves by chat: anything more — a change, a question, a condition — is an instruction to act on. Answer it, revise the plan if asked, and let them approve the plan they then see.";

/// Read the whole turn. `Err` is the reason it is not consent.
pub fn read(text: &str) -> Result<Consent, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err(NOT_CONSENT.into());
    }
    if text.chars().count() > MAX_CHARS || text.contains('?') {
        return Err(NOT_CONSENT.into());
    }
    let lowered = text.to_lowercase().replace(['\u{2019}', '\u{2018}'], "'");
    let words: Vec<&str> = lowered
        .split(|c: char| {
            c.is_whitespace()
                || matches!(
                    c,
                    '.' | ',' | '!' | ';' | ':' | '-' | '\u{2013}' | '\u{2014}'
                )
        })
        .filter(|word| !word.is_empty())
        .collect();

    let mut approved = false;
    let mut handle: Option<String> = None;
    let mut at = 0;
    'words: while at < words.len() {
        let rest = &words[at..];
        for phrase in CORE {
            if starts_with(rest, phrase) {
                approved = true;
                at += phrase.len();
                continue 'words;
            }
        }
        for phrase in REFERENT {
            if let Some((taken, named)) = referent(rest, phrase) {
                if let Some(named) = named {
                    if handle.as_ref().is_some_and(|earlier| *earlier != named) {
                        return Err("The person named two different plans in one message. Ask which one they approve.".into());
                    }
                    handle = Some(named);
                }
                at += taken;
                continue 'words;
            }
        }
        for phrase in FILLER {
            if starts_with(rest, phrase) {
                at += phrase.len();
                continue 'words;
            }
        }
        return Err(NOT_CONSENT.into());
    }
    if !approved {
        return Err(NOT_CONSENT.into());
    }
    Ok(Consent { handle })
}

/// The approving words themselves. Generic assent ("ok", "go ahead") is
/// filler: allowed around an approval, never one on its own.
const CORE: &[&[&str]] = &[
    &["i", "approve"],
    &["we", "approve"],
    &["is", "approved"],
    &["approve"],
    &["approved"],
];

/// `#` stands for a plan handle.
const REFERENT: &[&[&str]] = &[
    &["the", "#", "plan"],
    &["the", "plan", "#"],
    &["this", "plan"],
    &["the", "plan"],
    &["that", "plan"],
    &["this", "one"],
    &["plan", "#"],
    &["plan"],
    &["this"],
    &["it"],
    &["#"],
];

const FILLER: &[&[&str]] = &[
    &["thank", "you"],
    &["looks", "good"],
    &["looks", "great"],
    &["go", "ahead"],
    &["let's", "go"],
    &["lets", "go"],
    &["you", "can", "start"],
    &["all", "good"],
    &["as", "is"],
    &["please"],
    &["pls"],
    &["yes"],
    &["yep"],
    &["yeah"],
    &["ok"],
    &["okay"],
    &["sure"],
    &["great"],
    &["good"],
    &["perfect"],
    &["thanks"],
    &["thx"],
    &["lgtm"],
    &["proceed"],
];

fn starts_with(words: &[&str], phrase: &[&str]) -> bool {
    words.len() >= phrase.len() && words.iter().zip(phrase).all(|(word, want)| word == want)
}

/// How many words a referent phrase takes, and the handle it named.
fn referent(words: &[&str], phrase: &[&str]) -> Option<(usize, Option<String>)> {
    if words.len() < phrase.len() {
        return None;
    }
    let mut named = None;
    for (word, want) in words.iter().zip(phrase) {
        if *want == "#" {
            let word = word.strip_prefix('#').unwrap_or(word);
            if word.len() != 4 || !word.chars().all(|c| c.is_ascii_hexdigit()) {
                return None;
            }
            named = Some(word.to_string());
        } else if word != want {
            return None;
        }
    }
    Some((phrase.len(), named))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yes(text: &str) -> Consent {
        read(text).unwrap_or_else(|why| panic!("{text:?} should approve: {why}"))
    }

    #[test]
    fn plain_approvals_are_consent() {
        for text in [
            "approve",
            "Approve this plan",
            "approve this plan.",
            "I approve the plan",
            "Approved!",
            "Plan approved, thanks",
            "The plan is approved",
            "yes, approve it",
            "LGTM — approve",
            "ok approve this plan please",
            "approve this plan\nthanks",
            "Approve plan as is, go ahead",
        ] {
            assert_eq!(yes(text).handle, None, "{text:?}");
        }
    }

    #[test]
    fn a_named_plan_carries_its_handle() {
        assert_eq!(yes("approve plan 2278").handle.as_deref(), Some("2278"));
        assert_eq!(yes("Approve plan #A1B2").handle.as_deref(), Some("a1b2"));
        assert_eq!(yes("approve the 2278 plan").handle.as_deref(), Some("2278"));
        assert_eq!(yes("2278 approved").handle.as_deref(), Some("2278"));
    }

    #[test]
    fn anything_more_than_approval_is_not_consent() {
        for text in [
            "",
            "ok",
            "go ahead",
            "yes",
            "sounds good",
            "looks good, go ahead",
            "approve?",
            "should I approve this plan?",
            "don't approve",
            "do not approve this plan",
            "not approved",
            "never approve",
            "approve\nbut change the branch name",
            "approve, but use Sonnet for task 2",
            "approve if the tests pass",
            "approve once CI is green",
            "I'd approve this plan",
            "I will approve later",
            "maybe approve",
            "approve after you rename task 1",
            "> approve this plan",
            "\"approve this plan\"",
            "the worker said approve this plan",
            "Mango, approve this plan",
            "approve and deploy",
            "approve and restart the server",
            "approve plan 2278 and plan ab12",
            "approve plan 2278, plan ab12",
            "approve plan 22789",
            "approve 🚀",
        ] {
            assert!(read(text).is_err(), "{text:?} must not approve");
        }
    }

    #[test]
    fn a_long_message_is_never_a_plain_approval() {
        let long = format!("approve {}", "please ".repeat(40));
        assert!(read(&long).is_err());
    }

    #[test]
    fn handles_are_the_first_four_hex_digits_of_the_run() {
        assert_eq!(plan_handle("run_2278c5a65c104183a60d37a5f4dfa690"), "2278");
        assert_eq!(plan_handle("run_ABCDEF"), "abcd");
    }
}
