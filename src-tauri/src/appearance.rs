// System appearance: hand the frontend the accent colour the user picked in
// macOS System Settings, so OctiqFlow tints itself like a native Mac app.
//
// macOS keeps the choice in the *global* preferences domain (what
// `defaults read -g AppleAccentColor` prints) as a small integer. The key is
// ABSENT on a fresh account — that is the "Multicolor" default, which renders
// blue — so a missing key is a valid answer, not an error.
//
// We read it through CFPreferences rather than shelling out to `defaults`: the
// CoreFoundation crates are already dependencies (vault.rs uses them for the
// window-capture path) and a subprocess per read would be wasteful, since the
// frontend re-reads this every time the window regains focus (that is how it
// notices the user changed the accent while the app was in the background).
//
// The hexes below are Apple's DARK-mode system colours. OctiqFlow's chrome is
// dark only, so the dark variants are the correct ones — the light variants
// (e.g. #007AFF blue) are noticeably too heavy on a dark surface.
//
// Everything here is best-effort: any failure returns None and the frontend
// keeps its built-in accent. Non-macOS builds always return None.

use serde::Serialize;

/// What the frontend gets back. `hex` is the accent itself; the frontend
/// derives every tint (fills, borders, focus ring) from it. `name` is only for
/// the Settings readout and for debugging a wrong-looking accent.
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct SystemAccent {
    pub hex: String,
    pub name: String,
}

/// Map the `AppleAccentColor` integer to Apple's dark-mode system colour.
///
/// The integers are Apple's, in the order the accent swatches appear in System
/// Settings: -1 is Graphite (the leftmost, greyscale swatch) and 0..=6 run red
/// through pink. `None` means the key was absent — the "Multicolor" default,
/// which paints controls blue.
fn accent_for_index(index: Option<i64>) -> SystemAccent {
    let (hex, name) = match index {
        Some(-1) => ("#98989d", "graphite"),
        Some(0) => ("#ff453a", "red"),
        Some(1) => ("#ff9f0a", "orange"),
        Some(2) => ("#ffd60a", "yellow"),
        Some(3) => ("#32d74b", "green"),
        Some(4) => ("#0a84ff", "blue"),
        Some(5) => ("#bf5af2", "purple"),
        Some(6) => ("#ff375f", "pink"),
        // Multicolor (key absent) and any index Apple adds later both land on
        // blue — the colour macOS itself falls back to.
        _ => ("#0a84ff", "blue"),
    };
    SystemAccent {
        hex: hex.to_string(),
        name: name.to_string(),
    }
}

/// Read `AppleAccentColor` out of the global preferences domain.
#[cfg(target_os = "macos")]
fn read_accent_index() -> Option<i64> {
    use core_foundation::base::TCFType;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use core_foundation_sys::base::{CFGetTypeID, CFRelease};
    use core_foundation_sys::number::{CFNumberGetTypeID, CFNumberRef};
    use core_foundation_sys::preferences::{
        kCFPreferencesAnyApplication, CFPreferencesCopyAppValue,
    };

    let key = CFString::new("AppleAccentColor");
    // SAFETY: CFPreferencesCopyAppValue follows the CoreFoundation "Copy" rule —
    // it returns either NULL or a +1 reference we own. We type-check the value
    // before reading it and release it on every path out.
    unsafe {
        let value =
            CFPreferencesCopyAppValue(key.as_concrete_TypeRef(), kCFPreferencesAnyApplication);
        if value.is_null() {
            return None;
        }
        // The key is normally an integer, but a hand-edited plist could hold
        // anything; reading a non-number as a number would be undefined.
        let out = if CFGetTypeID(value) == CFNumberGetTypeID() {
            CFNumber::wrap_under_get_rule(value as CFNumberRef).to_i64()
        } else {
            None
        };
        CFRelease(value);
        out
    }
}

#[cfg(not(target_os = "macos"))]
fn read_accent_index() -> Option<i64> {
    None
}

/// The accent the user picked in System Settings.
///
/// Returns `None` off macOS, so the frontend keeps OctiqFlow's own accent
/// instead of pretending Windows/Linux has a Mac accent colour.
#[tauri::command]
pub fn system_accent() -> Option<SystemAccent> {
    if cfg!(target_os = "macos") {
        Some(accent_for_index(read_accent_index()))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_every_apple_accent_index() {
        let cases = [
            (-1, "#98989d", "graphite"),
            (0, "#ff453a", "red"),
            (1, "#ff9f0a", "orange"),
            (2, "#ffd60a", "yellow"),
            (3, "#32d74b", "green"),
            (4, "#0a84ff", "blue"),
            (5, "#bf5af2", "purple"),
            (6, "#ff375f", "pink"),
        ];
        for (index, hex, name) in cases {
            let got = accent_for_index(Some(index));
            assert_eq!(got.hex, hex, "hex for accent index {index}");
            assert_eq!(got.name, name, "name for accent index {index}");
        }
    }

    #[test]
    fn absent_key_is_the_multicolor_default_blue() {
        // No `AppleAccentColor` in the domain = System Settings' "Multicolor",
        // which macOS paints blue.
        assert_eq!(accent_for_index(None).hex, "#0a84ff");
    }

    #[test]
    fn unknown_future_index_falls_back_to_blue() {
        assert_eq!(accent_for_index(Some(99)).hex, "#0a84ff");
        assert_eq!(accent_for_index(Some(-7)).hex, "#0a84ff");
    }
}
