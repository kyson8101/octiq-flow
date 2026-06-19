// Small cross-platform helper for the child processes the app shells out to
// (git, curl). A Tauri app runs with no console of its own, so on Windows every
// `std::process::Command` spawns a brand-new console window that flashes on
// screen for the life of the child. The git status poll behind the sidebar's
// live counts runs often, so without this the window would blink constantly.
//
// `no_console` sets the Win32 CREATE_NO_WINDOW creation flag so the child runs
// with no console at all. It is a no-op on Unix, where there is no such window.
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
