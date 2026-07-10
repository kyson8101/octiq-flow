// System font enumeration for the terminal font picker. The webview cannot list
// installed fonts from JS (the Local Font Access API is Chromium-only), so the
// backend scans them with `fontdb` (pure Rust; reads the OS font directories)
// and hands the sorted family list to the UI as a <datalist>.
//
// The scan walks the OS font folders, so we do it ONCE per app launch and cache
// the result in a OnceLock: every later `list_fonts` call returns the cached
// clone with no re-scan. Fonts almost never change while the app is open, so a
// per-launch scan is plenty — the cache is only there to avoid re-scanning on
// every picker open.

use std::collections::BTreeSet;
use std::sync::OnceLock;

static FONT_CACHE: OnceLock<Vec<String>> = OnceLock::new();

/// Every unique font family installed on this machine, sorted case-insensitively.
/// The first call scans the system fonts (a few hundred ms); later calls return
/// the cached list instantly. Never errors — a scan problem just yields fewer (or
/// no) names, so the picker shows fewer suggestions rather than breaking.
#[tauri::command]
pub fn list_fonts() -> Vec<String> {
    FONT_CACHE.get_or_init(scan_fonts).clone()
}

/// Load the system fonts and collect their unique family names. A face's first
/// family entry is its primary (often localized) name; many faces (regular/bold/
/// italic) share one family, so a BTreeSet folds them to one entry each.
fn scan_fonts() -> Vec<String> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    let mut set = BTreeSet::new();
    for face in db.faces() {
        if let Some((name, _)) = face.families.first() {
            let name = name.trim();
            if !name.is_empty() {
                set.insert(name.to_string());
            }
        }
    }

    let mut names: Vec<String> = set.into_iter().collect();
    names.sort_by_key(|s| s.to_lowercase());
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    // Runs against this machine's real fonts (any dev box has some), so it also
    // smoke-tests that fontdb loads at all.
    #[test]
    fn scan_is_nonempty_sorted_and_deduped() {
        let fonts = scan_fonts();
        assert!(!fonts.is_empty(), "expected some installed system fonts");

        let mut deduped = fonts.clone();
        deduped.dedup();
        assert_eq!(deduped.len(), fonts.len(), "family list has duplicates");

        let mut sorted = fonts.clone();
        sorted.sort_by_key(|s| s.to_lowercase());
        assert_eq!(
            sorted, fonts,
            "family list is not case-insensitively sorted"
        );
    }
}
