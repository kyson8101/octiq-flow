// Small cross-platform helper for the child processes the app shells out to
// (git, curl). A Tauri app runs with no console of its own, so on Windows every
// `std::process::Command` spawns a brand-new console window that flashes on
// screen for the life of the child. The git status poll behind the sidebar's
// live counts runs often, so without this the window would blink constantly.
//
// `no_console` sets the Win32 CREATE_NO_WINDOW creation flag so the child runs
// with no console at all. It is a no-op on Unix, where there is no such window.
use std::path::Path;
use std::process::Command;

/// Apply the Windows `CREATE_NO_WINDOW` creation flag to `cmd` so spawning it
/// never flashes a console window. No-op off Windows. Call it on the builder
/// before `.output()` / `.spawn()`.
#[cfg_attr(not(windows), allow(unused_variables))]
pub fn no_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW (winbase.h): the child gets no console window.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// A shell to launch an agent through, and the arguments that carry a command.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentShell {
    pub program: String,
    pub args: Vec<String>,
}

/// Decide which POSIX shell launches an agent.
///
/// Agents go through a shell because `agent_provider::build_command` returns a
/// POSIX-quoted command line, and because a login shell is what fills `PATH`
/// for a window-less service. Windows has no login shell, but the bash shipped
/// with Git for Windows reads that same quoting — so only the LOOKUP differs,
/// never the command that is built.
///
/// `is_windows` is a parameter rather than a `#[cfg]` so the Windows branch is
/// testable on a Mac, which is the only machine this project's maintainer has.
/// `probe` resolves a program name or an absolute path to a usable executable;
/// `local_app_data` carries `%LOCALAPPDATA%`, where a per-user Git install goes.
pub fn resolve_agent_shell(
    shell_env: Option<String>,
    local_app_data: Option<String>,
    is_windows: bool,
    probe: &dyn Fn(&str) -> Option<String>,
) -> Result<AgentShell, String> {
    // `-l` fills PATH the way a real terminal does; `-c` carries the command.
    let found = |program: String| {
        Ok(AgentShell {
            program,
            args: vec!["-lc".to_string()],
        })
    };

    // An explicit SHELL wins everywhere. This is the branch macOS has always
    // taken, so nothing about this change can alter what it does there.
    if let Some(shell) = shell_env.filter(|s| !s.trim().is_empty()) {
        return found(shell);
    }
    if !is_windows {
        return found("/bin/zsh".to_string());
    }

    // WSL's bash.exe launches a Linux distribution, not a native agent. Keep
    // looking for Git Bash when a Windows system launcher is first on PATH.
    if let Some(bash) = probe("bash").filter(|path| !is_wsl_bash(path)) {
        return found(bash);
    }
    // Otherwise follow git to its sibling bash: git sits in <root>\cmd, bash in
    // <root>\bin, so the install root is git's grandparent.
    if let Some(git) = probe("git") {
        // Use Windows separators explicitly: std::path follows the host OS,
        // even when is_windows is true in a test running on macOS or Linux.
        let git = git.replace('/', "\\");
        if let Some((root, _)) = git
            .rsplit_once('\\')
            .and_then(|(dir, _)| dir.rsplit_once('\\'))
        {
            if let Some(bash) = probe(&format!(r"{root}\bin\bash.exe")) {
                return found(bash);
            }
        }
    }
    // The installer's "Use Git from Git Bash only" option keeps git OFF PATH,
    // so a perfectly good bash can exist that neither lookup above can see.
    let mut candidates = vec![
        r"C:\Program Files\Git\bin\bash.exe".to_string(),
        r"C:\Program Files (x86)\Git\bin\bash.exe".to_string(),
    ];
    if let Some(local) = local_app_data.filter(|s| !s.trim().is_empty()) {
        candidates.push(format!(r"{local}\Programs\Git\bin\bash.exe"));
    }
    for candidate in &candidates {
        if let Some(bash) = probe(candidate) {
            return found(bash);
        }
    }

    // Naming the fix matters more than usual here: the caller cannot, and the
    // raw spawn error this replaces ("The system cannot find the path
    // specified") points at nothing the user could act on.
    Err(
        "no POSIX shell found. OctiqFlow runs agents through a shell, and on \
         Windows that means the bash shipped with Git for Windows. Install it \
         from https://git-scm.com/download/win, or set SHELL to a bash."
            .to_string(),
    )
}

/// Known Windows/Store entry points into WSL. Explicit SHELL overrides are
/// honored separately; automatic discovery must not silently switch OSes.
fn is_wsl_bash(path: &str) -> bool {
    let path = path.replace('\\', "/").to_ascii_lowercase();
    let path = path.strip_suffix(".exe").unwrap_or(&path);
    [
        "/system32/bash",
        "/sysnative/bash",
        "/microsoft/windowsapps/bash",
    ]
    .iter()
    .any(|suffix| path.ends_with(suffix))
}

/// Resolve a program name, or an absolute path, to a usable executable path.
///
/// Split from the OS so the search is testable: `path_var` is `PATH`, `sep` its
/// separator, and `exists` answers whether a candidate is really a file.
fn look_up_program(
    name_or_path: &str,
    path_var: Option<&str>,
    sep: char,
    exists: &dyn Fn(&str) -> bool,
) -> Option<String> {
    // Anything already carrying a separator is a path, not a name to search for.
    if name_or_path.contains('/') || name_or_path.contains('\\') {
        return exists(name_or_path).then(|| name_or_path.to_string());
    }
    // The PATH separator implies the path separator: `;` goes with `\`, `:`
    // with `/`. Tying them keeps this deterministic on any host, which is what
    // lets the Windows cases run on a Mac.
    let join = if sep == ';' { '\\' } else { '/' };
    for dir in path_var
        .unwrap_or_default()
        .split(sep)
        .map(|dir| dir.trim_end_matches(['/', '\\']))
        .filter(|dir| !dir.is_empty())
    {
        for candidate in [
            format!("{dir}{join}{name_or_path}"),
            format!("{dir}{join}{name_or_path}.exe"),
        ] {
            if sep == ';' && name_or_path.eq_ignore_ascii_case("bash") && is_wsl_bash(&candidate) {
                continue;
            }
            if exists(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// `look_up_program` against this machine: the real `PATH` and the real disk.
pub fn find_executable(name_or_path: &str) -> Option<String> {
    look_up_program(
        name_or_path,
        std::env::var("PATH").ok().as_deref(),
        if cfg!(windows) { ';' } else { ':' },
        &|candidate| Path::new(candidate).is_file(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Nothing resolves — the "clean Windows machine" case.
    fn nothing(_: &str) -> Option<String> {
        None
    }

    #[test]
    fn an_absolute_path_resolves_to_itself_when_it_exists() {
        let found = look_up_program(r"C:\Program Files\Git\bin\bash.exe", None, ';', &|_| true);
        assert_eq!(found.as_deref(), Some(r"C:\Program Files\Git\bin\bash.exe"));
    }

    #[test]
    fn an_absolute_path_that_is_not_there_resolves_to_nothing() {
        // Otherwise a fixed candidate would be handed back on a machine that
        // never had Git, and the failure would move to spawn time.
        assert_eq!(
            look_up_program(r"C:\Program Files\Git\bin\bash.exe", None, ';', &|_| false),
            None
        );
    }

    #[test]
    fn a_bare_name_is_searched_along_path() {
        let found = look_up_program("bash", Some(r"C:\a;C:\b"), ';', &|c| c == r"C:\b\bash.exe");
        assert_eq!(found.as_deref(), Some(r"C:\b\bash.exe"));
    }

    #[test]
    fn a_bare_name_also_matches_without_an_exe_suffix() {
        // The same lookup serves Unix, where executables carry no extension.
        let found = look_up_program("bash", Some("/usr/bin:/bin"), ':', &|c| c == "/bin/bash");
        assert_eq!(found.as_deref(), Some("/bin/bash"));
    }

    #[test]
    fn a_bare_name_that_is_nowhere_on_path_resolves_to_nothing() {
        assert_eq!(
            look_up_program("bash", Some(r"C:\a;C:\b"), ';', &|_| false),
            None
        );
    }

    #[test]
    fn a_set_shell_wins_on_every_platform() {
        // The one rule that keeps macOS untouched by this change.
        for is_windows in [false, true] {
            let shell =
                resolve_agent_shell(Some("/bin/bash".to_string()), None, is_windows, &nothing)
                    .expect("a set SHELL always resolves");
            assert_eq!(shell.program, "/bin/bash");
            assert_eq!(shell.args, vec!["-lc".to_string()]);
        }
    }

    #[test]
    fn an_empty_shell_is_ignored_rather_than_spawned() {
        // An exported-but-empty SHELL is not a shell; treating it as one would
        // spawn "" and fail with a message about nothing in particular.
        let shell = resolve_agent_shell(Some("  ".to_string()), None, false, &nothing)
            .expect("falls through to the Unix default");
        assert_eq!(shell.program, "/bin/zsh");
    }

    #[test]
    fn unix_without_a_shell_env_uses_zsh() {
        let shell = resolve_agent_shell(None, None, false, &nothing).expect("unix always resolves");
        assert_eq!(shell.program, "/bin/zsh");
        assert_eq!(shell.args, vec!["-lc".to_string()]);
    }

    #[test]
    fn windows_prefers_a_bash_already_on_path() {
        let shell = resolve_agent_shell(None, None, true, &|name| {
            (name == "bash").then(|| r"C:\tools\bash.exe".to_string())
        })
        .expect("bash on PATH resolves");
        assert_eq!(shell.program, r"C:\tools\bash.exe");
        assert_eq!(shell.args, vec!["-lc".to_string()]);
    }

    #[test]
    fn windows_derives_bash_from_git_on_path() {
        // `git` lives in <git>\cmd; its bash is the sibling <git>\bin\bash.exe.
        // The install here is deliberately NOT one of the fixed candidates, so
        // this can only pass by deriving the path from where git was found.
        let shell = resolve_agent_shell(None, None, true, &|name| match name {
            "git" => Some(r"D:\dev\PortableGit\cmd\git.exe".to_string()),
            r"D:\dev\PortableGit\bin\bash.exe" => Some(name.to_string()),
            _ => None,
        })
        .expect("git on PATH leads to its bash");
        assert_eq!(shell.program, r"D:\dev\PortableGit\bin\bash.exe");
    }

    #[test]
    fn windows_derives_bash_from_a_git_path_with_forward_slashes() {
        let shell = resolve_agent_shell(None, None, true, &|name| match name {
            "git" => Some("D:/dev/PortableGit/cmd/git.exe".to_string()),
            r"D:\dev\PortableGit\bin\bash.exe" => Some(name.to_string()),
            _ => None,
        })
        .expect("Windows accepts either path separator");
        assert_eq!(shell.program, r"D:\dev\PortableGit\bin\bash.exe");
    }

    #[test]
    fn windows_skips_wsl_launchers_for_git_bash() {
        for wsl in [
            r"C:\WINDOWS\System32\bash.exe",
            "C:/Windows/Sysnative/bash.exe",
            r"C:\Users\a\AppData\Local\Microsoft\WindowsApps\bash.exe",
        ] {
            let shell = resolve_agent_shell(None, None, true, &|name| match name {
                "bash" => Some(wsl.to_string()),
                r"C:\Program Files\Git\bin\bash.exe" => Some(name.to_string()),
                _ => None,
            })
            .expect("Git Bash is available");
            assert_eq!(shell.program, r"C:\Program Files\Git\bin\bash.exe");
        }
    }

    #[test]
    fn windows_with_only_wsl_names_the_native_shell_requirement() {
        let error = resolve_agent_shell(None, None, true, &|name| {
            (name == "bash").then(|| r"C:\Windows\System32\bash.exe".to_string())
        })
        .expect_err("WSL is not a native Windows agent shell");
        assert!(error.contains("Git for Windows"));
    }

    #[test]
    fn windows_path_search_continues_past_wsl_to_native_bash() {
        let shell = look_up_program(
            "bash",
            Some(r"C:\Windows\System32;D:\PortableGit\bin"),
            ';',
            &|path| {
                matches!(
                    path,
                    r"C:\Windows\System32\bash.exe" | r"D:\PortableGit\bin\bash.exe"
                )
            },
        );
        assert_eq!(shell.as_deref(), Some(r"D:\PortableGit\bin\bash.exe"));
    }

    #[test]
    fn windows_finds_a_git_installed_off_path() {
        // "Use Git from Git Bash only" keeps git OFF PATH — and a user who
        // chose that is exactly the user this resolution exists for.
        let shell = resolve_agent_shell(None, None, true, &|candidate| {
            (candidate == r"C:\Program Files\Git\bin\bash.exe").then(|| candidate.to_string())
        })
        .expect("the fixed install location resolves");
        assert_eq!(shell.program, r"C:\Program Files\Git\bin\bash.exe");
    }

    #[test]
    fn windows_finds_a_per_user_git_install() {
        let shell = resolve_agent_shell(
            None,
            Some(r"C:\Users\a\AppData\Local".to_string()),
            true,
            &|candidate| {
                (candidate == r"C:\Users\a\AppData\Local\Programs\Git\bin\bash.exe")
                    .then(|| candidate.to_string())
            },
        )
        .expect("a per-user Git install resolves");
        assert_eq!(
            shell.program,
            r"C:\Users\a\AppData\Local\Programs\Git\bin\bash.exe"
        );
    }

    #[test]
    fn windows_with_no_shell_anywhere_names_the_fix() {
        // The whole point of the change: the old code reached for /bin/zsh and
        // failed with "The system cannot find the path specified", which tells
        // the user nothing they can act on.
        let error = resolve_agent_shell(None, None, true, &nothing)
            .expect_err("a clean Windows machine has no POSIX shell");
        assert!(error.contains("Git for Windows"), "got: {error}");
        assert!(
            !error.contains("zsh"),
            "must not mention a Unix shell: {error}"
        );
    }
}
