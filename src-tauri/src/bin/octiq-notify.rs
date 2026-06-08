// octiq-notify: a tiny standalone CLI that raises an octiq attention alert.
//
// It does NOT talk to the app over IPC. Instead it prints an OSC 777 "notify"
// escape sequence to its own stdout. When this binary is run INSIDE an octiq
// terminal, that stdout is the PTY, so card 12's reader thread sees the
// sequence in the PTY output and raises the attention alert for that terminal.
// No socket, no app handle, no extra dependency — standard library only.
//
// Sequence emitted (terminator is BEL):
//   ESC ] 777 ; notify ; <title> ; <body> BEL
// which the scanner matches by the "777;notify;" prefix and splits the rest on
// the first ';' into (title, body). See src-tauri/src/pty.rs `scan_attention`.
//
// Usage:
//   octiq-notify --title "Claude" --body "needs input"
//   octiq-notify "needs input"            # positional -> body, empty title
//   octiq-notify                          # no args -> empty title, default body
//
// This is its own binary target. Cargo auto-discovers it from src/bin/, so no
// Cargo.toml change is needed. The app (lib + the main `octiq-flow` binary) is
// completely independent of this file.

use std::io::Write;
use std::process::ExitCode;

/// The escape character (0x1B) that starts the OSC introducer.
const ESC: char = '\x1b';
/// The BEL character (0x07) that terminates the OSC sequence.
const BEL: char = '\x07';
/// Used when the caller gives no body at all, so the alert still says something.
const DEFAULT_BODY: &str = "needs attention";

/// What the parsed command line resolved to: either values to emit, or a
/// request to print help (which is not an error).
enum Parsed {
    Notify { title: String, body: String },
    Help,
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_args(&args) {
        Ok(Parsed::Help) => {
            print!("{}", help_text());
            ExitCode::SUCCESS
        }
        Ok(Parsed::Notify { title, body }) => {
            // Write the raw sequence to stdout. If stdout is the octiq PTY, the
            // scanner picks it up; if it is a plain terminal, the bytes are
            // harmless (an unknown OSC is ignored by terminals).
            let seq = build_sequence(&title, &body);
            let mut out = std::io::stdout();
            if out.write_all(seq.as_bytes()).and_then(|_| out.flush()).is_err() {
                return ExitCode::FAILURE;
            }
            ExitCode::SUCCESS
        }
        Err(msg) => {
            // Parse problem (e.g. a flag with no value). Report on stderr so it
            // never gets mistaken for the notify sequence on stdout.
            eprintln!("octiq-notify: {msg}");
            eprint!("{}", help_text());
            ExitCode::FAILURE
        }
    }
}

/// Parse the simple flag/positional grammar.
///
/// - `--title <t>` / `-t <t>`: set the alert title (optional).
/// - `--body <b>`  / `-b <b>`: set the alert body (optional).
/// - `--help` / `-h`: print usage and exit.
/// - Any other args: joined with spaces and used as the body, but ONLY if no
///   `--body` flag was given (the flag wins). This lets `octiq-notify some text`
///   work as a shorthand.
///
/// Returns an error string when a value-taking flag is the last token with no
/// value after it.
fn parse_args(args: &[String]) -> Result<Parsed, String> {
    let mut title: Option<String> = None;
    let mut body: Option<String> = None;
    let mut positional: Vec<String> = Vec::new();

    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();
        match arg {
            "--help" | "-h" => return Ok(Parsed::Help),
            "--title" | "-t" => {
                let value = args
                    .get(i + 1)
                    .ok_or_else(|| format!("flag {arg} needs a value"))?;
                title = Some(value.clone());
                i += 2;
            }
            "--body" | "-b" => {
                let value = args
                    .get(i + 1)
                    .ok_or_else(|| format!("flag {arg} needs a value"))?;
                body = Some(value.clone());
                i += 2;
            }
            _ => {
                positional.push(arg.to_string());
                i += 1;
            }
        }
    }

    // Body precedence: explicit --body, else joined positional args, else the
    // default so the alert is never blank.
    let body = body
        .or_else(|| {
            if positional.is_empty() {
                None
            } else {
                Some(positional.join(" "))
            }
        })
        .unwrap_or_else(|| DEFAULT_BODY.to_string());

    Ok(Parsed::Notify {
        title: title.unwrap_or_default(),
        body,
    })
}

/// Build the OSC 777 notify sequence for the scanner in pty.rs.
///
/// The scanner splits the payload after `777;notify;` on the FIRST `;` into
/// (title, body). A `;` inside the title would therefore leak into the body,
/// and a `;` inside either field could end the visible text early. To keep the
/// split clean we replace any `;` in the fields with a comma. Control bytes
/// (ESC, BEL, and other C0 controls) are stripped so a value can never close
/// the sequence early or inject a second one.
fn build_sequence(title: &str, body: &str) -> String {
    let title = sanitize(title);
    let body = sanitize(body);
    format!("{ESC}]777;notify;{title};{body}{BEL}")
}

/// Make a field safe to drop between `;` delimiters: turn `;` into `,` so the
/// scanner's split stays correct, and drop ASCII control characters so the
/// value cannot terminate the OSC sequence or start another.
fn sanitize(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if c == ';' { ',' } else { c })
        .collect()
}

/// Usage text shared by `--help` and the parse-error path.
fn help_text() -> String {
    "\
octiq-notify - raise an octiq attention alert from inside an octiq terminal

USAGE:
    octiq-notify [--title <title>] [--body <body>]
    octiq-notify <body words...>

OPTIONS:
    -t, --title <title>   Alert title (optional).
    -b, --body  <body>    Alert body (optional; defaults to \"needs attention\").
    -h, --help            Show this help.

NOTES:
    Prints an OSC 777 notify escape sequence to stdout. Run it INSIDE an octiq
    terminal so octiq's output scanner sees the sequence and flags that tab.
    Outside octiq the sequence is harmless. The binary must be on PATH (or
    called by full path) for agent hooks to reach it.
"
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn notify(args: &[&str]) -> (String, String) {
        let owned: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        match parse_args(&owned).expect("parse should succeed") {
            Parsed::Notify { title, body } => (title, body),
            Parsed::Help => panic!("expected Notify, got Help"),
        }
    }

    #[test]
    fn no_args_uses_empty_title_and_default_body() {
        let (title, body) = notify(&[]);
        assert_eq!(title, "");
        assert_eq!(body, DEFAULT_BODY);
    }

    #[test]
    fn flags_set_title_and_body() {
        let (title, body) = notify(&["--title", "Claude", "--body", "needs input"]);
        assert_eq!(title, "Claude");
        assert_eq!(body, "needs input");
    }

    #[test]
    fn short_flags_work() {
        let (title, body) = notify(&["-t", "Codex", "-b", "review"]);
        assert_eq!(title, "Codex");
        assert_eq!(body, "review");
    }

    #[test]
    fn positional_args_join_into_body() {
        let (title, body) = notify(&["needs", "your", "input"]);
        assert_eq!(title, "");
        assert_eq!(body, "needs your input");
    }

    #[test]
    fn body_flag_wins_over_positional() {
        let (_title, body) = notify(&["--body", "from flag", "ignored", "words"]);
        assert_eq!(body, "from flag");
    }

    #[test]
    fn flag_without_value_is_an_error() {
        let owned = vec!["--title".to_string()];
        assert!(parse_args(&owned).is_err());
    }

    #[test]
    fn help_flag_returns_help() {
        let owned = vec!["--help".to_string()];
        assert!(matches!(parse_args(&owned), Ok(Parsed::Help)));
    }

    #[test]
    fn sequence_matches_scanner_format() {
        let seq = build_sequence("Claude", "needs input");
        assert_eq!(seq, "\x1b]777;notify;Claude;needs input\x07");
    }

    #[test]
    fn semicolons_in_fields_become_commas() {
        // A ';' in the title would otherwise leak into the body when the
        // scanner splits on the first ';'.
        let seq = build_sequence("a;b", "c;d");
        assert_eq!(seq, "\x1b]777;notify;a,b;c,d\x07");
    }

    #[test]
    fn control_bytes_are_stripped() {
        // An embedded ESC or BEL must not be able to close or restart the OSC.
        let seq = build_sequence("ti\x1btle", "bo\x07dy");
        assert_eq!(seq, "\x1b]777;notify;title;body\x07");
    }
}
