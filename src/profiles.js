// Profiles settings panel: switch the active profile, create a new one, and
// choose where profiles are stored. The backend (profile.rs) owns the data; this
// module only renders the controls and calls commands. Switching profiles or
// changing the base folder restarts the app, so every store reloads from the new
// data root. DOM-wiring only, matching settings.js: bail quietly if the controls
// are absent (the settings page may not exist in a given build).

const { invoke } = window.__TAURI__.core;

/** Show a status line in the panel: green for ok, red for an error, cleared when
 *  the message is empty. Reuses the settings-status classes from settings.js. */
function setStatus(el, msg, ok) {
  if (!el) return;
  el.textContent = msg || "";
  el.classList.remove("settings-status-error", "settings-status-ok");
  if (msg) el.classList.add(ok ? "settings-status-ok" : "settings-status-error");
}

/** Fill the active-profile <select> with every profile, selecting the current. */
function fillProfiles(select, names, active) {
  select.replaceChildren();
  for (const name of names) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    if (name === active) opt.selected = true;
    select.append(opt);
  }
}

/** Load the config + profile list and paint the panel. Returns the config (so
 *  the caller can track the active name), or null on error. */
async function loadPanel(select, basePathEl) {
  try {
    const [cfg, names] = await Promise.all([
      invoke("get_profile_config"),
      invoke("list_profiles"),
    ]);
    fillProfiles(select, names, cfg.active);
    if (basePathEl) basePathEl.textContent = cfg.base;
    return cfg;
  } catch (err) {
    if (basePathEl) basePathEl.textContent = `Could not load profiles: ${err}`;
    return null;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const select = document.getElementById("profile-active");
  const nameInput = document.getElementById("profile-new-name");
  const createBtn = document.getElementById("profile-create");
  const status = document.getElementById("profile-status");
  const basePathEl = document.getElementById("profile-base-path");
  const pickBaseBtn = document.getElementById("profile-pick-base");
  if (!select) return;

  let current = null;
  loadPanel(select, basePathEl).then((cfg) => {
    current = cfg && cfg.active;
  });

  // Switching restarts the app. Ignore a change back to the already-active value.
  select.addEventListener("change", async () => {
    const name = select.value;
    if (!name || name === current) return;
    setStatus(status, "Switching…", true);
    try {
      await invoke("switch_profile", { name });
      // The app restarts on success, so this point is not reached.
    } catch (err) {
      setStatus(status, `Could not switch: ${err}`, false);
      if (current) select.value = current; // revert the dropdown
    }
  });

  createBtn?.addEventListener("click", async () => {
    const name = (nameInput?.value || "").trim();
    if (!name) {
      setStatus(status, "Give the profile a name.", false);
      return;
    }
    createBtn.disabled = true;
    try {
      const created = await invoke("create_profile", { name });
      if (nameInput) nameInput.value = "";
      await loadPanel(select, basePathEl);
      if (current) select.value = current; // keep showing the active one
      setStatus(status, `Created “${created}”. Pick it above to switch.`, true);
    } catch (err) {
      setStatus(status, `Could not create: ${err}`, false);
    } finally {
      createBtn.disabled = false;
    }
  });

  pickBaseBtn?.addEventListener("click", async () => {
    pickBaseBtn.disabled = true;
    try {
      const folder = await invoke("pick_folder");
      if (!folder) return; // user cancelled the dialog
      setStatus(status, "Changing folder…", true);
      await invoke("set_profile_base", { path: folder });
      // The app restarts on success.
    } catch (err) {
      setStatus(status, `Could not change folder: ${err}`, false);
    } finally {
      pickBaseBtn.disabled = false;
    }
  });
});
