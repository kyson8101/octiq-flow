use std::io::{BufRead, BufReader, Write};
use std::process::{ChildStdout, Command};
use std::time::Duration;

const PART: &str = "OCTIQ_TEST_STAND_IN";
/// What an echoing stand-in writes before it echoes anything. The test
/// harness prints its own header first, and a reader skips past it.
const READY: &str = "octiq-stand-in-ready";

/// Its stdout goes nowhere unless the caller pipes it: the harness's own
/// "test result" lines would otherwise land in the suite's log.
fn playing(part: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().expect("the test binary"));
    command
        .args([
            "--exact",
            "agent_chat::stand_in::agent",
            "--nocapture",
            "--quiet",
            "--test-threads=1",
        ])
        .env(PART, part)
        .stdout(std::process::Stdio::null());
    command
}

/// A process that stays alive for 30 seconds unless it is killed.
pub(crate) fn still() -> Command {
    playing("still")
}

/// A process that copies each line of its stdin to its stdout until stdin
/// closes. Read its stdout through `echoed`.
pub(crate) fn echo() -> Command {
    playing("echo")
}

/// The stdout of an `echo()` child, from the first echoed line on.
pub(crate) fn echoed(stdout: ChildStdout) -> BufReader<ChildStdout> {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).expect("the stand-in's stdout");
        assert!(read > 0, "the stand-in ended before it was ready");
        if line.trim_end() == READY {
            return reader;
        }
    }
}

/// A test that ends a stand-in reads its stdout for the end of output ("nothing
/// was written to the stopped agent"). Closing the stand-in's stdin is one way
/// to end it, and it then leaves on its own: the harness's `.` and `test
/// result` lines must not follow the echoes, or that read is told something
/// was written. The Windows suite met exactly that (a lone `.`), because
/// there the ending came first more often than the kill.
#[test]
fn an_echo_that_ends_on_its_own_leaves_nothing_after_its_echoes() {
    let mut child = echo()
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("an echo");
    let mut stdin = child.stdin.take().expect("its stdin");
    let mut heard = echoed(child.stdout.take().expect("its stdout"));
    writeln!(stdin, "one").unwrap();
    drop(stdin);
    let mut rest = String::new();
    std::io::Read::read_to_string(&mut heard, &mut rest).expect("the rest of its output");
    child.wait().expect("it ended");
    assert_eq!(rest, "one\n");
}

#[test]
fn agent() {
    match std::env::var(PART).as_deref() {
        Ok("still") => std::thread::sleep(Duration::from_secs(30)),
        Ok("echo") => {
            let mut out = std::io::stdout().lock();
            writeln!(out, "{READY}").and_then(|_| out.flush()).unwrap();
            let mut input = std::io::stdin().lock();
            let mut line = Vec::new();
            while input.read_until(b'\n', &mut line).unwrap_or(0) > 0 {
                if out.write_all(&line).and_then(|_| out.flush()).is_err() {
                    std::process::exit(0);
                }
                line.clear();
            }
            // Leave without the harness's closing `.` and `test result`
            // lines: they would read as something the stand-in was written.
            std::process::exit(0);
        }
        _ => {}
    }
}
