// System appearance: make the app's accent the one the user picked in macOS
// System Settings, and follow macOS's key/inactive window states.
//
// Two jobs, both of which native Mac apps get for free and a webview does not:
//
//  1. ACCENT. appearance.rs reads `AppleAccentColor` and hands back a hex. We
//     write it into `--accent-rgb` on :root; every accent token in styles.css
//     derives from that one channel triple, so a single assignment repaints
//     selections, focus rings, switches, and primary buttons together. macOS
//     does not tell a webview when the accent changes, so we re-read on every
//     window focus — that covers the real case (user changes it in System
//     Settings, comes back to the app).
//
//  2. KEY WINDOW. macOS drains the color out of a window that is not frontmost:
//     a selected source-list row goes from accent-filled to gray. We mirror
//     that by toggling `win-inactive` on <html>, which styles.css keys off.
//
// Both are best-effort. If the backend call fails, or we are not on macOS, the
// app keeps OctiqFlow's own sage accent and simply never dims.
const { invoke } = window.__TAURI__.core;

/** OctiqFlow's own accent, used anywhere macOS cannot supply one. */
const FALLBACK_ACCENT = "#8fbfa8";

const root = document.documentElement;

/** True on macOS. WKWebView's user agent always carries "Macintosh"; we read it
 *  rather than asking the backend because the class has to land before first
 *  paint (it gates the traffic-light inset on the mode bar, and a late class
 *  would show the toolbar jumping sideways). */
const isMac = /Macintosh|Mac OS X/.test(navigator.userAgent);

/** "#0a84ff" -> "10 132 255", the space-separated form `rgb()` takes inside a
 *  custom property. Returns null for anything that is not a 6-digit hex, so a
 *  bad value leaves the stylesheet default in place instead of blanking it. */
function hexToChannels(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

function applyAccent(hex) {
  const channels = hexToChannels(hex);
  if (channels) root.style.setProperty("--accent-rgb", channels);
}

/** Ask the backend for the system accent and apply it. Off macOS (the command
 *  returns null) we fall back to sage — pretending Windows has a Mac accent
 *  would be worse than keeping the app's own color. */
async function syncAccent() {
  try {
    const accent = await invoke("system_accent");
    applyAccent(accent?.hex ?? FALLBACK_ACCENT);
  } catch {
    applyAccent(FALLBACK_ACCENT);
  }
}

root.classList.toggle("is-macos", isMac);
root.classList.toggle("not-macos", !isMac);

// Window focus drives both jobs: re-check the accent, and drop the key-window
// styling. `focus`/`blur` on window fire on key-status changes in WKWebView.
window.addEventListener("focus", () => {
  root.classList.remove("win-inactive");
  syncAccent();
});
window.addEventListener("blur", () => root.classList.add("win-inactive"));

syncAccent();
