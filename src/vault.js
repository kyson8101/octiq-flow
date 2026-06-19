// Screenshot vault (frontend). The Rust side (vault.rs) captures the active
// window on a global hotkey and drops PNGs into ~/.octiqflow/vault. This module
// is the UI: a camera button + badge in the mode bar, a drawer that lists the
// shots as thumbnails (read straight from disk via the asset protocol), a crop
// tool, and the Settings card that turns the hotkey on and picks the chord.
//
// Pasting writes a shot's absolute file PATH into the terminal the user last
// looked at (terminals.js `sendToActiveTerminal`), without pressing Enter — so
// the user can wrap their own words around it before sending. Claude Code / Codex
// then read the image from that path.
//
// Same shape as settings.js: a small state layer (localStorage for the user's
// chord pick + whether they enabled the hotkey) and a DOM-wiring block that runs
// on DOMContentLoaded. Every lookup is null-guarded so a trimmed build never
// throws.
import { sendToActiveTerminal } from "/terminals.js";

const { invoke, convertFileSrc } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

// ---- State layer ----------------------------------------------------------

// Whether the user turned the hotkey on (so we restart the listener silently on
// later launches — the OS permission is already granted by then).
const HOTKEY_ENABLED_KEY = "octiq.vault.hotkeyEnabled";
// The recorded capture chord, stored as a JSON array of browser KeyboardEvent
// `code` strings (e.g. ["MetaLeft","MetaRight"]). vault.rs maps the same codes.
const KEYS_KEY = "octiq.vault.keys";

/** True when running on macOS (the webview UA carries "Macintosh"). */
function isMac() {
  return /mac|darwin/i.test(navigator.userAgent);
}

/** The default chord as browser key codes: both Command keys on macOS, both
 *  Control keys elsewhere (the right Windows key is often missing). */
function defaultCodes() {
  return isMac() ? ["MetaLeft", "MetaRight"] : ["ControlLeft", "ControlRight"];
}

/** The stored chord codes if valid (an array of ≥2 strings), else the default. */
function storedCodes() {
  try {
    const v = JSON.parse(localStorage.getItem(KEYS_KEY));
    if (Array.isArray(v) && v.length >= 2 && v.every((c) => typeof c === "string")) {
      return v;
    }
  } catch {
    // fall through to the default
  }
  return defaultCodes();
}

/** A short, readable label for one KeyboardEvent.code, with left/right kept
 *  distinct so the user sees exactly which physical key they recorded. */
function keyLabel(code) {
  const mac = isMac();
  const map = {
    MetaLeft: mac ? "Left ⌘" : "Left ⊞",
    MetaRight: mac ? "Right ⌘" : "Right ⊞",
    ControlLeft: "Left ⌃",
    ControlRight: "Right ⌃",
    ShiftLeft: "Left ⇧",
    ShiftRight: "Right ⇧",
    AltLeft: mac ? "Left ⌥" : "Left Alt",
    AltRight: mac ? "Right ⌥" : "Right Alt",
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Escape: "Esc",
    Backspace: "⌫",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
  };
  if (map[code]) return map[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

/** Human label for a whole chord, e.g. "Left ⌘ + Right ⌘". */
function codesLabel(codes) {
  return codes && codes.length ? codes.map(keyLabel).join(" + ") : "—";
}

/** Whether the user has turned the hotkey on before. */
function hotkeyEnabled() {
  return localStorage.getItem(HOTKEY_ENABLED_KEY) === "1";
}

/** Short "12s ago" / "3m ago" label from an epoch-ms timestamp. */
function timeAgo(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Human file size. */
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

// Current shots, newest first (from the backend). Module-level so the capture
// event, the drawer, and the badge all read one list.
let shots = [];

// ---- DOM wiring -----------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("vault-btn");
  const badge = document.getElementById("vault-badge");
  const overlay = document.getElementById("vault-overlay");
  const grid = document.getElementById("vault-grid");
  const empty = document.getElementById("vault-empty");
  const hint = document.getElementById("vault-hint");
  const footStatus = document.getElementById("vault-foot-status");
  // Right-panel "Screenshots" section: a second view of the same vault with
  // multi-pick + insert. Any of these may be absent in a trimmed build.
  const paneGrid = document.getElementById("shots-grid");
  const paneEmpty = document.getElementById("shots-empty");
  const paneFoot = document.getElementById("shots-foot");
  const insertBtn = document.getElementById("shots-insert");
  const selectAll = document.getElementById("shots-selectall");
  // Names selected in the right-panel multi-pick (kept across refreshes).
  const selected = new Set();
  // The vault button is the minimum the feature needs; bail quietly if absent.
  if (!btn || !overlay || !grid) return;

  // ---- Badge + grid render ----
  const updateBadge = () => {
    if (!badge) return;
    const n = shots.length;
    badge.textContent = String(n);
    badge.classList.toggle("hidden", n === 0);
  };

  const setHint = (text, kind) => {
    if (!hint) return;
    hint.textContent = text || "";
    hint.classList.toggle("hidden", !text);
    hint.classList.toggle("vault-hint-error", kind === "error");
    hint.classList.toggle("vault-hint-ok", kind === "ok");
  };

  const renderGrid = () => {
    grid.replaceChildren();
    if (empty) empty.classList.toggle("hidden", shots.length > 0);
    if (footStatus) {
      footStatus.textContent = shots.length
        ? `${shots.length} screenshot${shots.length === 1 ? "" : "s"}`
        : "";
    }
    for (const shot of shots) {
      const card = document.createElement("div");
      card.className = "vault-card";
      card.dataset.name = shot.name;

      const thumb = document.createElement("div");
      thumb.className = "vault-thumb";
      const img = document.createElement("img");
      img.alt = shot.name;
      img.loading = "lazy";
      // Bust the cache with the modified time so a re-cropped shot re-renders.
      img.src = `${convertFileSrc(shot.path)}?t=${shot.modified}`;
      thumb.append(img);
      // Clicking the thumbnail opens the crop tool.
      thumb.addEventListener("click", () => openCrop(shot));

      const meta = document.createElement("div");
      meta.className = "vault-card-meta";
      meta.textContent = `${timeAgo(shot.modified)} · ${fmtSize(shot.size)}`;

      const actions = document.createElement("div");
      actions.className = "vault-card-actions";
      const pasteBtn = document.createElement("button");
      pasteBtn.className = "btn btn-sm btn-primary";
      pasteBtn.textContent = "Paste";
      pasteBtn.title = "Paste this screenshot's path into the terminal";
      pasteBtn.addEventListener("click", () => pasteShots([shot]));
      const cropBtn = document.createElement("button");
      cropBtn.className = "btn btn-sm";
      cropBtn.textContent = "Crop";
      cropBtn.addEventListener("click", () => openCrop(shot));
      const removeBtn = document.createElement("button");
      removeBtn.className = "icon-btn icon-btn-danger";
      removeBtn.title = "Remove from vault";
      removeBtn.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
      removeBtn.addEventListener("click", () => removeShot(shot));
      actions.append(pasteBtn, cropBtn, removeBtn);

      card.append(thumb, meta, actions);
      grid.append(card);
    }
  };

  const refresh = async () => {
    try {
      shots = await invoke("vault_list");
    } catch {
      shots = [];
    }
    if (!Array.isArray(shots)) shots = [];
    renderGrid();
    renderShotsPane();
    updateBadge();
  };

  // ---- Right-panel "Screenshots" section (multi-pick + insert) ----
  /** Build the right-panel thumbnail grid with selection state. */
  function renderShotsPane() {
    if (!paneGrid) return;
    // Drop selections whose shot was removed/cleared since the last render.
    const names = new Set(shots.map((s) => s.name));
    for (const n of [...selected]) if (!names.has(n)) selected.delete(n);

    paneGrid.replaceChildren();
    if (paneEmpty) paneEmpty.classList.toggle("hidden", shots.length > 0);
    if (paneFoot) paneFoot.classList.toggle("hidden", shots.length === 0);

    for (const shot of shots) {
      const card = document.createElement("div");
      card.className = "shots-card";
      card.classList.toggle("shots-card-selected", selected.has(shot.name));
      card.title = "Click to select; insert selected shots together";
      const img = document.createElement("img");
      img.alt = shot.name;
      img.loading = "lazy";
      img.src = `${convertFileSrc(shot.path)}?t=${shot.modified}`;
      const check = document.createElement("span");
      check.className = "shots-check";
      check.innerHTML =
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
      card.append(img, check);
      card.addEventListener("click", () => {
        if (selected.has(shot.name)) selected.delete(shot.name);
        else selected.add(shot.name);
        card.classList.toggle("shots-card-selected", selected.has(shot.name));
        updateInsertBtn();
      });
      paneGrid.append(card);
    }
    updateInsertBtn();
  }

  /** Refresh the insert button label/disabled state and the select-all box. */
  function updateInsertBtn() {
    const n = selected.size;
    if (insertBtn) {
      insertBtn.textContent = `Insert (${n})`;
      insertBtn.disabled = n === 0;
    }
    if (selectAll) {
      selectAll.checked = shots.length > 0 && n === shots.length;
      selectAll.indeterminate = n > 0 && n < shots.length;
    }
  }

  selectAll?.addEventListener("change", () => {
    selected.clear();
    if (selectAll.checked) for (const s of shots) selected.add(s.name);
    renderShotsPane();
  });
  insertBtn?.addEventListener("click", () => {
    const chosen = shots.filter((s) => selected.has(s.name));
    if (!chosen.length) return;
    const ok = sendToActiveTerminal(`${chosen.map((s) => s.path).join(" ")} `, false);
    if (ok) {
      selected.clear();
      renderShotsPane();
    } else if (insertBtn) {
      // No terminal is visible right now; keep the selection and nudge the user.
      insertBtn.textContent = "Open a terminal first";
      setTimeout(updateInsertBtn, 1600);
    }
  });
  document.getElementById("shots-capture")?.addEventListener("click", async () => {
    try {
      await invoke("vault_capture_now");
      await refresh();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[octiq vault] capture failed:", err);
    }
  });
  document.getElementById("shots-refresh")?.addEventListener("click", refresh);
  document.getElementById("shots-clear")?.addEventListener("click", async () => {
    try {
      await invoke("vault_clear");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[octiq vault] delete all failed:", err);
    }
    selected.clear();
    await refresh();
  });

  // ---- Drawer open/close ----
  let onKey = null;
  const openDrawer = () => {
    overlay.classList.remove("hidden");
    setHint("", null);
    refresh();
    onKey = (e) => {
      if (e.key === "Escape") closeDrawer();
    };
    document.addEventListener("keydown", onKey, true);
  };
  const closeDrawer = () => {
    overlay.classList.add("hidden");
    if (onKey) {
      document.removeEventListener("keydown", onKey, true);
      onKey = null;
    }
  };

  btn.addEventListener("click", openDrawer);
  // Click the dimmed backdrop (outside the panel) to close.
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closeDrawer();
  });
  document.getElementById("vault-close")?.addEventListener("click", closeDrawer);
  document.getElementById("vault-refresh")?.addEventListener("click", refresh);
  document.getElementById("vault-capture")?.addEventListener("click", async () => {
    try {
      await invoke("vault_capture_now");
      await refresh();
      setHint("Captured the active window.", "ok");
    } catch (err) {
      setHint(`Capture failed: ${err}`, "error");
    }
  });

  // ---- Paste ----
  /** Paste one or more shots' file paths into the terminal the user last used.
   *  No Enter is sent, so the user can add their own prompt. */
  const pasteShots = (list) => {
    const paths = list.map((s) => s.path).filter(Boolean);
    if (!paths.length) return;
    // Trailing space so the user can keep typing right after the path(s).
    const ok = sendToActiveTerminal(`${paths.join(" ")} `, false);
    if (ok) {
      closeDrawer();
    } else {
      setHint("Open a project or chat terminal first, then paste.", "error");
    }
  };

  document.getElementById("vault-paste-all")?.addEventListener("click", () => pasteShots(shots));
  document.getElementById("vault-clear")?.addEventListener("click", async () => {
    try {
      await invoke("vault_clear");
    } catch (err) {
      setHint(`Could not clear: ${err}`, "error");
    }
    await refresh();
  });

  const removeShot = async (shot) => {
    try {
      await invoke("vault_remove", { name: shot.name });
    } catch (err) {
      setHint(`Could not remove: ${err}`, "error");
    }
    await refresh();
  };

  // ---- Crop tool ----
  const cropBackdrop = document.getElementById("vault-crop");
  const cropImg = document.getElementById("vault-crop-img");
  const cropStage = document.getElementById("vault-crop-stage");
  const cropSel = document.getElementById("vault-crop-sel");
  const cropSave = document.getElementById("vault-crop-save");
  let cropName = null;
  // Selection rectangle in DISPLAY pixels relative to the stage, or null.
  let sel = null;
  let dragging = false;
  let dragStart = null;

  const clearSel = () => {
    sel = null;
    if (cropSel) cropSel.classList.add("hidden");
    if (cropSave) cropSave.disabled = true;
  };

  const paintSel = () => {
    if (!cropSel || !sel) return;
    cropSel.classList.remove("hidden");
    cropSel.style.left = `${sel.x}px`;
    cropSel.style.top = `${sel.y}px`;
    cropSel.style.width = `${sel.w}px`;
    cropSel.style.height = `${sel.h}px`;
  };

  const openCrop = (shot) => {
    if (!cropBackdrop || !cropImg) return;
    cropName = shot.name;
    clearSel();
    // Cache-bust so re-opening after a crop shows the latest pixels.
    cropImg.src = `${convertFileSrc(shot.path)}?t=${shot.modified}`;
    cropBackdrop.classList.remove("hidden");
  };
  const closeCrop = () => {
    cropBackdrop?.classList.add("hidden");
    cropName = null;
    clearSel();
  };

  if (cropStage && cropImg && cropSel) {
    const pointFromEvent = (e) => {
      const rect = cropImg.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
      const y = Math.min(Math.max(e.clientY - rect.top, 0), rect.height);
      return { x, y };
    };
    cropStage.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      dragStart = pointFromEvent(e);
      sel = { x: dragStart.x, y: dragStart.y, w: 0, h: 0 };
      paintSel();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging || !dragStart) return;
      const p = pointFromEvent(e);
      sel = {
        x: Math.min(dragStart.x, p.x),
        y: Math.min(dragStart.y, p.y),
        w: Math.abs(p.x - dragStart.x),
        h: Math.abs(p.y - dragStart.y),
      };
      paintSel();
    });
    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      // Treat a tiny drag as no selection (an accidental click).
      if (!sel || sel.w < 5 || sel.h < 5) {
        clearSel();
      } else if (cropSave) {
        cropSave.disabled = false;
      }
    });
  }

  document.getElementById("vault-crop-reset")?.addEventListener("click", clearSel);
  document.getElementById("vault-crop-cancel")?.addEventListener("click", closeCrop);
  cropBackdrop?.addEventListener("click", (e) => {
    if (e.target === cropBackdrop) closeCrop();
  });

  cropSave?.addEventListener("click", async () => {
    if (!cropImg || !cropName || !sel || sel.w < 5 || sel.h < 5) return;
    // Map the display-pixel selection to natural-pixel source coordinates.
    const rect = cropImg.getBoundingClientRect();
    const scaleX = cropImg.naturalWidth / rect.width;
    const scaleY = cropImg.naturalHeight / rect.height;
    const sx = Math.round(sel.x * scaleX);
    const sy = Math.round(sel.y * scaleY);
    const sw = Math.max(1, Math.round(sel.w * scaleX));
    const sh = Math.max(1, Math.round(sel.h * scaleY));
    const canvas = document.createElement("canvas");
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(cropImg, sx, sy, sw, sh, 0, 0, sw, sh);
    const dataUrl = canvas.toDataURL("image/png");
    try {
      await invoke("vault_write_image", { name: cropName, data: dataUrl });
      closeCrop();
      await refresh();
      setHint("Saved the cropped screenshot.", "ok");
    } catch (err) {
      setHint(`Could not save the crop: ${err}`, "error");
    }
  });

  // ---- Settings card ----
  wireSettings(refresh, setHint);

  // ---- Capture events from the backend ----
  listen("vault-captured", () => {
    refresh();
    btn.classList.add("vault-btn-pulse");
    setTimeout(() => btn.classList.remove("vault-btn-pulse"), 700);
    if (!overlay.classList.contains("hidden")) setHint("Captured the active window.", "ok");
  });
  listen("vault-capture-error", (e) => {
    // eslint-disable-next-line no-console
    console.warn("[octiq vault] capture failed:", e.payload);
    if (!overlay.classList.contains("hidden")) setHint(`Capture failed: ${e.payload}`, "error");
  });

  // ---- Boot ----
  // Tell the backend the saved chord (cheap, works whether or not the listener
  // is running). If the user has enabled the hotkey before, restart the listener
  // silently — the OS permission is already granted, so no prompt fires.
  invoke("vault_set_keys", { codes: storedCodes() }).catch(() => {});
  if (hotkeyEnabled()) {
    invoke("vault_start_monitor").catch(() => {});
  }
  // Populate the badge from any shots left over from a previous session.
  refresh();
});

/** Wire the Settings → Screenshot vault card: the chord picker, the
 *  enable-hotkey button, and the test-capture button. Bails quietly if the
 *  controls are absent (e.g. a trimmed build). */
function wireSettings(refresh, setHint) {
  const display = document.getElementById("vault-keys-display");
  const recordBtn = document.getElementById("vault-record");
  const resetBtn = document.getElementById("vault-keys-reset");
  const enableBtn = document.getElementById("vault-enable");
  const testBtn = document.getElementById("vault-test");
  const status = document.getElementById("vault-settings-status");
  const permsBtn = document.getElementById("vault-perms");
  const permsStatus = document.getElementById("vault-perms-status");

  const setStatus = (text, kind) => {
    if (!status) return;
    status.textContent = text || "";
    status.classList.toggle("settings-status-error", kind === "error");
    status.classList.toggle("settings-status-ok", kind === "ok");
  };

  // Show the macOS permission state (Input Monitoring for the hotkey + Screen
  // Recording for the capture). On other platforms nothing needs granting, so
  // hide these controls.
  const refreshPerms = async () => {
    let p;
    try {
      p = await invoke("vault_permissions");
    } catch {
      return;
    }
    if (!p || !p.is_macos) {
      if (permsBtn) permsBtn.style.display = "none";
      if (permsStatus) permsStatus.style.display = "none";
      return;
    }
    if (permsStatus) {
      const mark = (ok) => (ok ? "granted ✓" : "needed ✗");
      permsStatus.textContent = `Input Monitoring: ${mark(p.input_monitoring)} · Screen Recording: ${mark(p.screen_recording)}`;
      permsStatus.classList.toggle("settings-status-error", !(p.input_monitoring && p.screen_recording));
    }
  };

  permsBtn?.addEventListener("click", async () => {
    permsBtn.disabled = true;
    setStatus("Asking macOS for permission — approve it in System Settings.", null);
    try {
      await invoke("vault_request_permissions");
      await refreshPerms();
      setStatus(
        "If you just turned on Input Monitoring, restart OctiqFlow so the hotkey works in every app.",
        "ok",
      );
    } catch (err) {
      setStatus(`Could not request permissions: ${err}`, "error");
    } finally {
      permsBtn.disabled = false;
    }
  });

  refreshPerms();

  // ---- Custom-key recorder ----
  if (display) display.textContent = codesLabel(storedCodes());

  const saveCodes = async (codes) => {
    try {
      await invoke("vault_set_keys", { codes });
      localStorage.setItem(KEYS_KEY, JSON.stringify(codes));
      if (display) display.textContent = codesLabel(codes);
      setStatus(`Hotkey set to ${codesLabel(codes)}.`, "ok");
    } catch (err) {
      setStatus(`Could not save the hotkey: ${err}`, "error");
      if (display) display.textContent = codesLabel(storedCodes());
    }
  };

  if (recordBtn && display) {
    let recording = false;
    let pressed = new Set(); // codes currently held down
    let best = []; // the largest set held at once during the gesture
    let finalizeTimer = null;
    let cancelTimer = null;

    const stopRecording = () => {
      recording = false;
      clearTimeout(finalizeTimer);
      clearTimeout(cancelTimer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      recordBtn.textContent = "Record";
      recordBtn.classList.remove("vault-recording");
    };

    const finalize = () => {
      if (!recording) return;
      const codes = best.slice();
      stopRecording();
      if (codes.length < 2) {
        display.textContent = codesLabel(storedCodes());
        setStatus("Pick at least two keys held together. Try again.", "error");
        return;
      }
      saveCodes(codes);
    };

    const cancel = () => {
      if (!recording) return;
      stopRecording();
      display.textContent = codesLabel(storedCodes());
      setStatus("Recording cancelled — no keys pressed.", null);
    };

    // Block the combo from reaching the app while recording, and accumulate the
    // largest set of keys held at the same time (so order/fumbles do not matter).
    function onKeyDown(e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || !e.code) return;
      pressed.add(e.code);
      if (pressed.size > best.length) best = [...pressed];
      display.textContent = `${codesLabel([...pressed])} …`;
      // Some keyups are dropped while a modifier is held (notably ⌘ on macOS),
      // so also finalize a short time after the last keydown.
      clearTimeout(finalizeTimer);
      finalizeTimer = setTimeout(finalize, 1200);
    }
    function onKeyUp(e) {
      e.preventDefault();
      e.stopPropagation();
      pressed.delete(e.code);
      if (pressed.size === 0) finalize();
    }

    recordBtn.addEventListener("click", () => {
      if (recording) {
        finalize();
        return;
      }
      recording = true;
      pressed = new Set();
      best = [];
      recordBtn.textContent = "Press keys…";
      recordBtn.classList.add("vault-recording");
      display.textContent = "Press your key combination…";
      setStatus("", null);
      window.addEventListener("keydown", onKeyDown, true);
      window.addEventListener("keyup", onKeyUp, true);
      // Safety net: cancel if nothing usable is pressed within a few seconds.
      cancelTimer = setTimeout(cancel, 6000);
    });
  }

  resetBtn?.addEventListener("click", () => saveCodes(defaultCodes()));

  const reflectEnabled = () => {
    if (!enableBtn) return;
    if (hotkeyEnabled()) {
      enableBtn.textContent = "Capture hotkey is on";
      enableBtn.disabled = true;
    } else {
      enableBtn.textContent = "Turn on capture hotkey";
      enableBtn.disabled = false;
    }
  };
  reflectEnabled();

  enableBtn?.addEventListener("click", async () => {
    enableBtn.disabled = true;
    setStatus("Starting the hotkey listener… macOS may ask for Input Monitoring permission.", null);
    try {
      await invoke("vault_start_monitor");
      localStorage.setItem(HOTKEY_ENABLED_KEY, "1");
      reflectEnabled();
      setStatus(
        "Capture hotkey is on. If the first capture is blank, grant Screen Recording in System Settings and restart OctiqFlow.",
        "ok",
      );
    } catch (err) {
      enableBtn.disabled = false;
      setStatus(`Could not start the hotkey: ${err}`, "error");
    } finally {
      refreshPerms();
    }
  });

  testBtn?.addEventListener("click", async () => {
    testBtn.disabled = true;
    setStatus("Capturing the active window…", null);
    try {
      await invoke("vault_capture_now");
      await refresh();
      setStatus("Captured. Open the vault from the camera button in the top bar.", "ok");
    } catch (err) {
      setStatus(`Capture failed: ${err}`, "error");
    } finally {
      testBtn.disabled = false;
    }
  });
}
