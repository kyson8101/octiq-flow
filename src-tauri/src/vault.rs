// Screenshot vault: a global hotkey grabs the active window into a temporary
// store, and the UI later pastes the saved file path(s) into a terminal so an
// agent (Claude Code / Codex) can read the image.
//
// Three parts, all file-on-disk like the rest of the app (no IPC sockets):
//   1. A low-level key monitor (the `rdev` crate) that fires when the user holds
//      BOTH of a modifier pair at once — both Command keys on macOS, both
//      Control keys on Windows by default. rdev distinguishes left/right
//      modifiers, which a normal global-shortcut cannot, and works while
//      OctiqFlow is in the background. On macOS this needs Input Monitoring
//      permission; on Windows the low-level hook needs no special permission.
//   2. A per-OS capture: `screencapture` on macOS (the front window via its
//      CoreGraphics window id, falling back to the full screen), and a
//      PowerShell + System.Drawing grab of the foreground window on Windows.
//      macOS capture needs Screen Recording permission.
//   3. A flat vault folder in the active profile's data root (`<profile>/vault`,
//      see profile.rs) so the shots survive a restart and are still there when
//      the user comes back to OctiqFlow.
//
// The monitor is OPT-IN: nothing starts at boot. The frontend calls
// `vault_start_monitor` (from a Settings button, or silently on later launches
// once the user has enabled it) so the OS permission prompt never fires unasked.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::UNIX_EPOCH;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Image file extensions the vault shows. Captures are always PNG; this also
/// lets a hand-dropped image in the folder appear.
const IMAGE_EXTS: [&str; 4] = ["png", "jpg", "jpeg", "gif"];

/// The vault folder: `<profile>/vault`, in the active profile's data root (see
/// profile.rs). `Option` is kept so callers stay unchanged; `profile_dir` always
/// resolves a path (falling back if the configured base is unreachable).
fn vault_dir() -> Option<PathBuf> {
    Some(crate::profile::profile_dir().join("vault"))
}

/// Ensure the vault folder exists and return it.
fn ensure_vault_dir() -> Result<PathBuf, String> {
    let dir = vault_dir().ok_or("could not find your home folder")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Milliseconds since the Unix epoch (0 if the clock is before it).
fn millis_now() -> u128 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Whether `name` is a plain file name safe to join onto the vault dir — no path
/// separator and no `..`, so a crafted name can never read or write an arbitrary
/// file (path-traversal guard). Mirrors the canvas store's rule.
fn is_safe_name(name: &str) -> bool {
    !name.is_empty() && !name.contains('/') && !name.contains('\\') && !name.contains("..")
}

/// Strip an optional `data:image/png;base64,` prefix, returning just the base64
/// payload. The frontend may send either the raw base64 or the full data URL.
fn strip_b64_prefix(data: &str) -> &str {
    match data.split_once("base64,") {
        Some((_, rest)) => rest,
        None => data,
    }
}

/// One screenshot in the vault, as the frontend lists/renders it.
#[derive(Serialize, Clone)]
pub struct VaultShot {
    /// File name inside the vault folder (e.g. `shot-1718800000000-3.png`).
    name: String,
    /// Absolute path on disk. The frontend renders a thumbnail from it (via the
    /// asset protocol) and pastes it into a terminal.
    path: String,
    /// Last-modified time, milliseconds since the Unix epoch (0 if unknown).
    modified: u64,
    /// File size in bytes.
    size: u64,
}

impl VaultShot {
    /// Build a shot from a path on disk, or `None` if it cannot be stat'd.
    fn from_path(p: &Path) -> Option<Self> {
        let name = p.file_name()?.to_string_lossy().into_owned();
        let meta = std::fs::metadata(p).ok()?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        Some(Self {
            name,
            path: p.to_string_lossy().into_owned(),
            modified,
            size: meta.len(),
        })
    }
}

// ---- Capture --------------------------------------------------------------

/// Monotonic suffix so two captures in the same millisecond never collide.
static CAPTURE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Capture the active window into the vault and return it as a `VaultShot`.
fn do_capture() -> Result<VaultShot, String> {
    let dir = ensure_vault_dir()?;
    let n = CAPTURE_SEQ.fetch_add(1, Ordering::Relaxed);
    let name = format!("shot-{}-{}.png", millis_now(), n);
    let path = dir.join(&name);
    capture_active_window(&path)?;
    if !path.exists() {
        return Err("no screenshot was produced".into());
    }
    VaultShot::from_path(&path).ok_or_else(|| "screenshot file unreadable".into())
}

/// macOS capture: grab the frontmost window by its CoreGraphics window id with
/// the built-in `screencapture` tool. If the id cannot be found, fall back to
/// the full screen. Needs Screen Recording permission, or the image is blank.
#[cfg(target_os = "macos")]
fn capture_active_window(path: &Path) -> Result<(), String> {
    let mut cmd = std::process::Command::new("/usr/sbin/screencapture");
    cmd.arg("-x"); // silent (no shutter sound)
    if let Some(id) = frontmost_window_id() {
        // -o drops the window shadow; -l<id> captures exactly that one window
        // (even if partly occluded), not whatever sits on top of it.
        cmd.arg("-o");
        cmd.arg(format!("-l{id}"));
    }
    cmd.arg(path);
    let status = cmd.status().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("screencapture failed (is Screen Recording allowed?)".into());
    }
    Ok(())
}

/// Find the frontmost normal window's CoreGraphics id: the first on-screen,
/// layer-0 window not owned by OctiqFlow itself. The on-screen list is ordered
/// front-to-back, so the first match is the window the user is looking at. Pure
/// FFI into CoreGraphics + CoreFoundation; returns `None` if nothing matches.
#[cfg(target_os = "macos")]
fn frontmost_window_id() -> Option<u32> {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
    use core_foundation_sys::base::{CFRelease, CFTypeRef};
    use core_foundation_sys::dictionary::{CFDictionaryGetValueIfPresent, CFDictionaryRef};
    use core_foundation_sys::number::{kCFNumberSInt64Type, CFNumberGetValue, CFNumberRef};
    use std::os::raw::c_void;

    // CGWindowListOption bits we use.
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    const NULL_WINDOW_ID: u32 = 0;

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
    }

    /// Read an integer value out of a window-info dictionary by key name.
    unsafe fn dict_i64(dict: CFDictionaryRef, key: &CFString) -> Option<i64> {
        let mut value: *const c_void = std::ptr::null();
        let present = CFDictionaryGetValueIfPresent(
            dict,
            key.as_concrete_TypeRef() as *const c_void,
            &mut value as *mut *const c_void,
        );
        // The binding returns `bool` in some versions and `u8` in others; cast
        // so the check works either way.
        if present as i64 == 0 || value.is_null() {
            return None;
        }
        let mut out: i64 = 0;
        let ok = CFNumberGetValue(
            value as CFNumberRef,
            kCFNumberSInt64Type,
            &mut out as *mut i64 as *mut c_void,
        );
        if ok as i64 != 0 {
            Some(out)
        } else {
            None
        }
    }

    unsafe {
        let array = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, NULL_WINDOW_ID);
        if array.is_null() {
            return None;
        }
        let key_layer = CFString::new("kCGWindowLayer");
        let key_owner = CFString::new("kCGWindowOwnerPID");
        let key_number = CFString::new("kCGWindowNumber");
        let my_pid = std::process::id() as i64;
        let count = CFArrayGetCount(array);
        let mut found: Option<u32> = None;
        for i in 0..count {
            let dict = CFArrayGetValueAtIndex(array, i) as CFDictionaryRef;
            if dict.is_null() {
                continue;
            }
            let layer = dict_i64(dict, &key_layer);
            let owner = dict_i64(dict, &key_owner);
            let number = dict_i64(dict, &key_number);
            if let (Some(layer), Some(owner), Some(number)) = (layer, owner, number) {
                // layer 0 = a normal app window (the menu bar, dock, etc. sit on
                // higher layers); skip our own windows so the hotkey never grabs
                // OctiqFlow instead of the app under test.
                if layer == 0 && owner != my_pid && number > 0 {
                    found = Some(number as u32);
                    break;
                }
            }
        }
        CFRelease(array as CFTypeRef);
        found
    }
}

/// Windows capture: grab the foreground window's rectangle with PowerShell +
/// System.Drawing (always present on Windows). No special permission needed.
#[cfg(target_os = "windows")]
fn capture_active_window(path: &Path) -> Result<(), String> {
    let out = path.to_string_lossy().replace('\'', "''");
    let script = format!(
        r#"
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class OctiqWin {{
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT {{ public int Left; public int Top; public int Right; public int Bottom; }}
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out OctiqWin.RECT lpRect);
}}
"@
Add-Type -AssemblyName System.Drawing
$h = [OctiqWin]::GetForegroundWindow()
$r = New-Object OctiqWin+RECT
[void][OctiqWin]::GetWindowRect($h, [ref]$r)
$w = $r.Right - $r.Left
$ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) {{ throw 'no foreground window' }}
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save('{out}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
"#
    );
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("PowerShell screen capture failed".into());
    }
    Ok(())
}

/// Other platforms: capture is not wired up.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn capture_active_window(_path: &Path) -> Result<(), String> {
    Err("screenshot capture is only supported on macOS and Windows".into())
}

// ---- Hotkey monitor -------------------------------------------------------

/// Map a browser `KeyboardEvent.code` to the rdev key the listener watches. The
/// frontend's key recorder captures the chord as these physical-key codes —
/// left and right modifiers are distinct (e.g. "MetaLeft" vs "MetaRight"), which
/// is exactly what lets "both Command keys" be a real chord. `None` for a code
/// this build does not handle (the recorder warns and drops it).
fn code_to_rdev(code: &str) -> Option<rdev::Key> {
    use rdev::Key::*;
    let key = match code {
        "MetaLeft" => MetaLeft,
        "MetaRight" => MetaRight,
        "ControlLeft" => ControlLeft,
        "ControlRight" => ControlRight,
        "ShiftLeft" => ShiftLeft,
        "ShiftRight" => ShiftRight,
        // The browser splits Alt into left/right; rdev calls right Alt "AltGr".
        "AltLeft" => Alt,
        "AltRight" => AltGr,
        "Space" => Space,
        "Enter" => Return,
        "Tab" => Tab,
        "Escape" => Escape,
        "Backspace" => Backspace,
        "Delete" => Delete,
        "CapsLock" => CapsLock,
        "ArrowUp" => UpArrow,
        "ArrowDown" => DownArrow,
        "ArrowLeft" => LeftArrow,
        "ArrowRight" => RightArrow,
        "Home" => Home,
        "End" => End,
        "PageUp" => PageUp,
        "PageDown" => PageDown,
        "Insert" => Insert,
        "Backquote" => BackQuote,
        "Minus" => Minus,
        "Equal" => Equal,
        "BracketLeft" => LeftBracket,
        "BracketRight" => RightBracket,
        "Backslash" => BackSlash,
        "Semicolon" => SemiColon,
        "Quote" => Quote,
        "Comma" => Comma,
        "Period" => Dot,
        "Slash" => Slash,
        "Digit0" => Num0,
        "Digit1" => Num1,
        "Digit2" => Num2,
        "Digit3" => Num3,
        "Digit4" => Num4,
        "Digit5" => Num5,
        "Digit6" => Num6,
        "Digit7" => Num7,
        "Digit8" => Num8,
        "Digit9" => Num9,
        "KeyA" => KeyA,
        "KeyB" => KeyB,
        "KeyC" => KeyC,
        "KeyD" => KeyD,
        "KeyE" => KeyE,
        "KeyF" => KeyF,
        "KeyG" => KeyG,
        "KeyH" => KeyH,
        "KeyI" => KeyI,
        "KeyJ" => KeyJ,
        "KeyK" => KeyK,
        "KeyL" => KeyL,
        "KeyM" => KeyM,
        "KeyN" => KeyN,
        "KeyO" => KeyO,
        "KeyP" => KeyP,
        "KeyQ" => KeyQ,
        "KeyR" => KeyR,
        "KeyS" => KeyS,
        "KeyT" => KeyT,
        "KeyU" => KeyU,
        "KeyV" => KeyV,
        "KeyW" => KeyW,
        "KeyX" => KeyX,
        "KeyY" => KeyY,
        "KeyZ" => KeyZ,
        "F1" => F1,
        "F2" => F2,
        "F3" => F3,
        "F4" => F4,
        "F5" => F5,
        "F6" => F6,
        "F7" => F7,
        "F8" => F8,
        "F9" => F9,
        "F10" => F10,
        "F11" => F11,
        "F12" => F12,
        _ => return None,
    };
    Some(key)
}

/// The default capture chord as browser key codes: both Command keys on macOS,
/// both Control keys elsewhere (the right Windows key is often missing).
fn default_codes() -> Vec<&'static str> {
    #[cfg(target_os = "macos")]
    {
        vec!["MetaLeft", "MetaRight"]
    }
    #[cfg(not(target_os = "macos"))]
    {
        vec!["ControlLeft", "ControlRight"]
    }
}

/// Tauri-managed state for the hotkey monitor. `running` guards against spawning
/// the listener thread twice; it is cleared again when the thread exits, so a
/// failed start (e.g. Input Monitoring not yet granted) can be retried. `keys`
/// is the recorded chord — every key in it must be held at once to fire — and is
/// read live by the listener so a Settings change takes effect without a restart.
pub struct VaultMonitor {
    running: Arc<AtomicBool>,
    keys: Arc<Mutex<Vec<rdev::Key>>>,
}

impl Default for VaultMonitor {
    fn default() -> Self {
        let keys = default_codes()
            .into_iter()
            .filter_map(code_to_rdev)
            .collect();
        Self {
            running: Arc::new(AtomicBool::new(false)),
            keys: Arc::new(Mutex::new(keys)),
        }
    }
}

impl VaultMonitor {
    /// Set the capture chord from recorded browser key codes. Requires at least
    /// two recognized keys, so a lone key can never become a global hotkey that
    /// fires on every keystroke. Read live by the listener (takes effect at once).
    fn set_keys(&self, codes: &[String]) -> Result<(), String> {
        let mapped: Vec<rdev::Key> = codes.iter().filter_map(|c| code_to_rdev(c)).collect();
        if mapped.len() < 2 {
            return Err("pick at least two keys for the capture hotkey".into());
        }
        if let Ok(mut k) = self.keys.lock() {
            *k = mapped;
        }
        Ok(())
    }

    /// Start the global key listener once. Idempotent — a second call is a no-op
    /// so the Settings button can be pressed repeatedly. On macOS this needs
    /// Input Monitoring permission; if it is missing the listener errors out and
    /// the flag is cleared so the user can retry after granting it.
    fn start(&self, app: AppHandle) -> Result<(), String> {
        if self.running.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let keys = self.keys.clone();
        let running = self.running.clone();
        std::thread::spawn(move || {
            // macOS uses a native CGEventTap that reads only key CODES and
            // modifier flags. rdev's listener cannot be used here: for every key
            // press it builds a character string via the Text Input Source APIs,
            // which on recent macOS must run on the main thread and abort the
            // process when called from this background thread. Windows keeps rdev.
            #[cfg(target_os = "macos")]
            {
                if let Err(e) = mac_listen::run(app, keys) {
                    eprintln!("[octiq] vault hotkey monitor: {e}");
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                rdev_listen(app, keys);
            }
            // The listener only returns on error (a live tap blocks forever).
            // Clear the flag so the user can retry after granting permission.
            running.store(false, Ordering::SeqCst);
        });
        Ok(())
    }
}

/// True when every key in the recorded chord is currently held.
fn chord_held(pressed: &[rdev::Key], required: &[rdev::Key]) -> bool {
    !required.is_empty() && required.iter().all(|rk| pressed.contains(rk))
}

/// Windows/Linux key listener: rdev distinguishes left/right modifiers and is
/// safe on these platforms (the main-thread text-input issue is macOS-only).
#[cfg(not(target_os = "macos"))]
fn rdev_listen(app: AppHandle, keys: Arc<Mutex<Vec<rdev::Key>>>) {
    let mut pressed: Vec<rdev::Key> = Vec::new();
    let mut armed = true;
    let callback = move |event: rdev::Event| {
        let required = keys.lock().map(|g| g.clone()).unwrap_or_default();
        match event.event_type {
            rdev::EventType::KeyPress(k) => {
                if !pressed.contains(&k) {
                    pressed.push(k);
                }
                if chord_held(&pressed, &required) && armed {
                    armed = false;
                    trigger_capture(&app);
                }
            }
            rdev::EventType::KeyRelease(k) => {
                pressed.retain(|p| *p != k);
                if !chord_held(&pressed, &required) {
                    armed = true;
                }
            }
            _ => {}
        }
    };
    if let Err(e) = rdev::listen(callback) {
        eprintln!("[octiq] vault hotkey monitor stopped: {e:?}");
    }
}

/// macOS key listener: a native CoreGraphics event tap that reads only key codes
/// and modifier flags. It never calls the Text Input Source APIs, so it is safe
/// to run on this background thread (unlike rdev's listener, which crashes there
/// on recent macOS). The C callback cannot capture state, so the shared chord +
/// pressed-set live in a module static.
#[cfg(target_os = "macos")]
mod mac_listen {
    use super::{chord_held, trigger_capture};
    use std::os::raw::c_void;
    use std::sync::{Arc, Mutex};
    use tauri::AppHandle;

    type CFRef = *const c_void;
    type TapCallback = unsafe extern "C" fn(CFRef, u32, CFRef, *mut c_void) -> CFRef;

    // CGEventTap location / placement / option. The HID location is the most
    // global (it taps events at the hardware-input level, before any app sees
    // them) and is what rdev used — so it reliably receives key events from every
    // app, not just OctiqFlow.
    const HID_TAP: u32 = 0; // kCGHIDEventTap
    const HEAD_INSERT: u32 = 0; // kCGHeadInsertEventTap
    const LISTEN_ONLY: u32 = 1; // kCGEventTapOptionListenOnly
                                // Event types we listen to.
    const KEY_DOWN: u32 = 10;
    const KEY_UP: u32 = 11;
    const FLAGS_CHANGED: u32 = 12;
    // The system can disable a tap; we re-enable it when these arrive.
    const TAP_DISABLED_TIMEOUT: u32 = 0xFFFF_FFFE;
    const TAP_DISABLED_USER_INPUT: u32 = 0xFFFF_FFFF;
    // CGEventField for the key code.
    const KEYCODE_FIELD: u32 = 9; // kCGKeyboardEventKeycode
    const MASK: u64 = (1 << KEY_DOWN) | (1 << KEY_UP) | (1 << FLAGS_CHANGED);

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventTapCreate(
            tap: u32,
            place: u32,
            options: u32,
            events_of_interest: u64,
            callback: TapCallback,
            user_info: *mut c_void,
        ) -> CFRef;
        fn CGEventTapEnable(port: CFRef, enable: bool);
        fn CGEventGetIntegerValueField(event: CFRef, field: u32) -> i64;
        fn CGEventGetFlags(event: CFRef) -> u64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFMachPortCreateRunLoopSource(alloc: CFRef, port: CFRef, order: isize) -> CFRef;
        fn CFRunLoopGetCurrent() -> CFRef;
        fn CFRunLoopAddSource(rl: CFRef, source: CFRef, mode: CFRef);
        fn CFRunLoopRun();
        static kCFRunLoopCommonModes: CFRef;
    }

    /// Shared state for the C callback (which cannot capture). `port` is the tap
    /// stored as a usize so the state stays `Send` (a raw pointer is not).
    struct State {
        keys: Arc<Mutex<Vec<rdev::Key>>>,
        app: AppHandle,
        pressed: Vec<rdev::Key>,
        armed: bool,
        port: usize,
    }

    static STATE: Mutex<Option<State>> = Mutex::new(None);

    /// The device-dependent modifier flag bit for a modifier key code, used to
    /// tell a press from a release on a FlagsChanged event. `None` for keys that
    /// are not left/right modifiers.
    fn modifier_bit(keycode: i64) -> Option<u64> {
        Some(match keycode {
            55 => 0x0000_0008, // left command
            54 => 0x0000_0010, // right command
            56 => 0x0000_0002, // left shift
            60 => 0x0000_0004, // right shift
            59 => 0x0000_0001, // left control
            62 => 0x0000_2000, // right control
            58 => 0x0000_0020, // left option
            61 => 0x0000_0040, // right option
            _ => return None,
        })
    }

    /// Map a macOS virtual key code to the matching rdev key (mirrors rdev's own
    /// table, plus the right-control entry rdev omits). `None` for unmapped keys.
    fn key_from_code(code: i64) -> Option<rdev::Key> {
        use rdev::Key::*;
        Some(match code {
            55 => MetaLeft,
            54 => MetaRight,
            59 => ControlLeft,
            62 => ControlRight,
            56 => ShiftLeft,
            60 => ShiftRight,
            58 => Alt,
            61 => AltGr,
            49 => Space,
            36 => Return,
            48 => Tab,
            53 => Escape,
            51 => Backspace,
            57 => CapsLock,
            126 => UpArrow,
            125 => DownArrow,
            123 => LeftArrow,
            124 => RightArrow,
            50 => BackQuote,
            27 => Minus,
            24 => Equal,
            33 => LeftBracket,
            30 => RightBracket,
            42 => BackSlash,
            41 => SemiColon,
            39 => Quote,
            43 => Comma,
            47 => Dot,
            44 => Slash,
            18 => Num1,
            19 => Num2,
            20 => Num3,
            21 => Num4,
            23 => Num5,
            22 => Num6,
            26 => Num7,
            28 => Num8,
            25 => Num9,
            29 => Num0,
            0 => KeyA,
            1 => KeyS,
            2 => KeyD,
            3 => KeyF,
            5 => KeyG,
            4 => KeyH,
            38 => KeyJ,
            40 => KeyK,
            37 => KeyL,
            12 => KeyQ,
            13 => KeyW,
            14 => KeyE,
            15 => KeyR,
            17 => KeyT,
            16 => KeyY,
            32 => KeyU,
            34 => KeyI,
            31 => KeyO,
            35 => KeyP,
            6 => KeyZ,
            7 => KeyX,
            8 => KeyC,
            9 => KeyV,
            11 => KeyB,
            45 => KeyN,
            46 => KeyM,
            122 => F1,
            120 => F2,
            99 => F3,
            118 => F4,
            96 => F5,
            97 => F6,
            98 => F7,
            100 => F8,
            101 => F9,
            109 => F10,
            103 => F11,
            111 => F12,
            _ => return None,
        })
    }

    unsafe extern "C" fn callback(
        _proxy: CFRef,
        etype: u32,
        event: CFRef,
        _user: *mut c_void,
    ) -> CFRef {
        // If the system disabled the tap, re-enable it and carry on.
        if etype == TAP_DISABLED_TIMEOUT || etype == TAP_DISABLED_USER_INPUT {
            if let Ok(guard) = STATE.lock() {
                if let Some(st) = guard.as_ref() {
                    CGEventTapEnable(st.port as CFRef, true);
                }
            }
            return event;
        }
        let keycode = CGEventGetIntegerValueField(event, KEYCODE_FIELD);
        let Some(key) = key_from_code(keycode) else {
            return event;
        };
        // Press for KeyDown, release for KeyUp; for a modifier (FlagsChanged) the
        // flag bit tells which way it went.
        let is_down = match etype {
            KEY_DOWN => Some(true),
            KEY_UP => Some(false),
            FLAGS_CHANGED => modifier_bit(keycode).map(|bit| (CGEventGetFlags(event) & bit) != 0),
            _ => None,
        };
        if let Some(down) = is_down {
            if let Ok(mut guard) = STATE.lock() {
                if let Some(st) = guard.as_mut() {
                    let required = st.keys.lock().map(|g| g.clone()).unwrap_or_default();
                    if down {
                        if !st.pressed.contains(&key) {
                            st.pressed.push(key);
                        }
                        if chord_held(&st.pressed, &required) && st.armed {
                            st.armed = false;
                            trigger_capture(&st.app);
                        }
                    } else {
                        st.pressed.retain(|k| *k != key);
                        if !chord_held(&st.pressed, &required) {
                            st.armed = true;
                        }
                    }
                }
            }
        }
        event
    }

    /// Create the event tap, install it on this thread's run loop, and run the
    /// loop (blocks until the process exits). Returns an error if the tap cannot
    /// be created — usually because Input Monitoring permission is missing.
    pub fn run(app: AppHandle, keys: Arc<Mutex<Vec<rdev::Key>>>) -> Result<(), String> {
        unsafe {
            let port = CGEventTapCreate(
                HID_TAP,
                HEAD_INSERT,
                LISTEN_ONLY,
                MASK,
                callback,
                std::ptr::null_mut(),
            );
            if port.is_null() {
                return Err("could not create the key event tap — grant Input Monitoring permission to OctiqFlow in System Settings, then restart it".into());
            }
            let source = CFMachPortCreateRunLoopSource(std::ptr::null(), port, 0);
            if source.is_null() {
                return Err("could not create the run loop source for the key tap".into());
            }
            if let Ok(mut guard) = STATE.lock() {
                *guard = Some(State {
                    keys,
                    app,
                    pressed: Vec::new(),
                    armed: true,
                    port: port as usize,
                });
            }
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
            CGEventTapEnable(port, true);
            CFRunLoopRun();
        }
        Ok(())
    }
}

/// macOS TCC permission checks for the hotkey + capture. `CGPreflight*` reports
/// whether access is granted; `CGRequest*` prompts for it (and adds the app to
/// the matching System Settings list) the first time. The key point: without
/// Input Monitoring, a listen-only event tap is still created but only receives
/// THIS app's own key events — so the hotkey works while OctiqFlow is focused but
/// not globally. That is the usual "works inside the app only" symptom.
#[cfg(target_os = "macos")]
mod mac_perms {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }
    pub fn input_monitoring_granted() -> bool {
        unsafe { CGPreflightListenEventAccess() }
    }
    pub fn request_input_monitoring() {
        unsafe {
            CGRequestListenEventAccess();
        }
    }
    pub fn screen_recording_granted() -> bool {
        unsafe { CGPreflightScreenCaptureAccess() }
    }
    pub fn request_screen_recording() {
        unsafe {
            CGRequestScreenCaptureAccess();
        }
    }
}

/// Run a capture off the listener thread (capture spawns a subprocess and must
/// never stall the input event tap) and emit the result to the frontend.
fn trigger_capture(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || match do_capture() {
        Ok(shot) => {
            let _ = app.emit("vault-captured", &shot);
        }
        Err(e) => {
            let _ = app.emit("vault-capture-error", e);
        }
    });
}

// ---- Commands -------------------------------------------------------------

/// Start the global capture hotkey listener (opt-in; see module docs). Safe to
/// call repeatedly — only the first call spawns the listener.
#[tauri::command]
pub fn vault_start_monitor(
    app: AppHandle,
    monitor: tauri::State<VaultMonitor>,
) -> Result<(), String> {
    // On macOS the global key tap needs Input Monitoring. If it looks missing,
    // trigger the system prompt — but STILL start the listener. Preflight is
    // unreliable for unsigned dev builds (each rebuild is a new binary that macOS
    // has not authorized yet), so the tap creation itself is the real test; a
    // hard block here would stop the hotkey from ever starting after a rebuild.
    #[cfg(target_os = "macos")]
    {
        if !mac_perms::input_monitoring_granted() {
            mac_perms::request_input_monitoring();
        }
    }
    monitor.start(app)
}

/// The current state of the macOS permissions the vault needs. On non-macOS both
/// are reported granted (no extra permission is required there).
#[derive(Serialize)]
pub struct VaultPermissions {
    input_monitoring: bool,
    screen_recording: bool,
    is_macos: bool,
}

/// Report whether Input Monitoring (the global hotkey) and Screen Recording (the
/// capture) are granted, so the UI can show the real state.
#[tauri::command]
pub fn vault_permissions() -> VaultPermissions {
    #[cfg(target_os = "macos")]
    {
        VaultPermissions {
            input_monitoring: mac_perms::input_monitoring_granted(),
            screen_recording: mac_perms::screen_recording_granted(),
            is_macos: true,
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        VaultPermissions {
            input_monitoring: true,
            screen_recording: true,
            is_macos: false,
        }
    }
}

/// Prompt for the macOS permissions the vault needs (Input Monitoring + Screen
/// Recording) and return the state afterwards. macOS shows its prompt / adds
/// OctiqFlow to the lists the first time; a newly granted Input Monitoring
/// permission may need an app restart to take effect.
#[tauri::command]
pub fn vault_request_permissions() -> VaultPermissions {
    #[cfg(target_os = "macos")]
    {
        mac_perms::request_input_monitoring();
        mac_perms::request_screen_recording();
    }
    vault_permissions()
}

/// Set the capture chord from recorded browser key codes (e.g.
/// `["MetaLeft", "MetaRight"]` or `["ControlLeft", "ShiftLeft", "Digit2"]`).
/// Needs at least two recognized keys. Takes effect live (no restart).
#[tauri::command]
pub fn vault_set_keys(
    monitor: tauri::State<VaultMonitor>,
    codes: Vec<String>,
) -> Result<(), String> {
    monitor.set_keys(&codes)
}

/// Capture the active window right now and return the new shot. Backs the manual
/// capture / "Test capture" buttons in the UI.
#[tauri::command]
pub fn vault_capture_now() -> Result<VaultShot, String> {
    do_capture()
}

/// List every screenshot in the vault, newest first. A missing folder yields an
/// empty list, never an error, so the UI can render before the first capture.
#[tauri::command]
pub fn vault_list() -> Result<Vec<VaultShot>, String> {
    let Some(dir) = vault_dir() else {
        return Ok(vec![]);
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(vec![]); // folder not created yet
    };
    let mut shots: Vec<VaultShot> = vec![];
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_image = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .map(|e| IMAGE_EXTS.contains(&e.as_str()))
            .unwrap_or(false);
        if !is_image {
            continue;
        }
        if let Some(shot) = VaultShot::from_path(&path) {
            shots.push(shot);
        }
    }
    shots.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(shots)
}

/// Delete one screenshot from the vault by file name (path-traversal guarded).
#[tauri::command]
pub fn vault_remove(name: String) -> Result<(), String> {
    if !is_safe_name(&name) {
        return Err("invalid screenshot name".into());
    }
    let dir = vault_dir().ok_or("could not find your home folder")?;
    let path = dir.join(&name);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Delete every screenshot in the vault (the "Clear all" action).
#[tauri::command]
pub fn vault_clear() -> Result<(), String> {
    let Some(dir) = vault_dir() else {
        return Ok(());
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_image = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .map(|e| IMAGE_EXTS.contains(&e.as_str()))
            .unwrap_or(false);
        if path.is_file() && is_image {
            let _ = std::fs::remove_file(&path);
        }
    }
    Ok(())
}

/// Overwrite a screenshot with new PNG bytes (used by the crop tool, which draws
/// the cropped region in the frontend and saves it back). `data` is the PNG as
/// base64, with or without a `data:image/png;base64,` prefix. Returns the
/// updated shot. The name is path-traversal guarded and must already be a PNG.
#[tauri::command]
pub fn vault_write_image(name: String, data: String) -> Result<VaultShot, String> {
    if !is_safe_name(&name) {
        return Err("invalid screenshot name".into());
    }
    // Strip an optional data-URL prefix so the frontend can pass either form.
    let b64 = strip_b64_prefix(&data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("bad image data: {e}"))?;
    let dir = ensure_vault_dir()?;
    let path = dir.join(&name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    VaultShot::from_path(&path).ok_or_else(|| "saved image unreadable".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_rejects_path_tricks() {
        // A normal capture name is accepted.
        assert!(is_safe_name("shot-1718800000000-3.png"));
        // Anything that could escape the vault folder is rejected.
        assert!(!is_safe_name(""));
        assert!(!is_safe_name("../secret.png"));
        assert!(!is_safe_name("a/b.png"));
        assert!(!is_safe_name("a\\b.png"));
        assert!(!is_safe_name("..hidden"));
    }

    #[test]
    fn strip_b64_prefix_handles_both_forms() {
        // Full data URL -> just the payload after "base64,".
        assert_eq!(strip_b64_prefix("data:image/png;base64,AAAB"), "AAAB");
        // Raw base64 with no prefix -> unchanged.
        assert_eq!(strip_b64_prefix("AAAB"), "AAAB");
        // Empty stays empty.
        assert_eq!(strip_b64_prefix(""), "");
    }

    #[test]
    fn code_to_rdev_maps_known_and_rejects_unknown() {
        use rdev::Key;
        // Left/right modifiers stay distinct, which is what makes "both Command
        // keys" a real chord.
        assert_eq!(code_to_rdev("MetaLeft"), Some(Key::MetaLeft));
        assert_eq!(code_to_rdev("MetaRight"), Some(Key::MetaRight));
        // Right Alt maps to rdev's AltGr.
        assert_eq!(code_to_rdev("AltRight"), Some(Key::AltGr));
        assert_eq!(code_to_rdev("Digit2"), Some(Key::Num2));
        assert_eq!(code_to_rdev("KeyP"), Some(Key::KeyP));
        assert_eq!(code_to_rdev("F5"), Some(Key::F5));
        // An unhandled code is dropped, not guessed.
        assert_eq!(code_to_rdev("MediaPlayPause"), None);
    }

    #[test]
    fn default_codes_map_to_two_keys() {
        // The per-OS default chord must always resolve to a valid 2-key chord.
        let mapped: Vec<_> = default_codes()
            .into_iter()
            .filter_map(code_to_rdev)
            .collect();
        assert_eq!(mapped.len(), 2);
    }
}
