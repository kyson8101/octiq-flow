// Shared right-click context menu. One menu is open at a time, app-wide; the
// caller passes the cursor position and a list of items. Used by the project
// sidebar (workspaces.js) and the command rows (commands.js) so both menus
// look and behave identically (.ctx-menu styles in styles.css).
//
// Item shape: { label, danger?, confirm?, onClick }
// - danger: red styling (.ctx-item-danger).
// - confirm: two-click confirm — the first click swaps the label to this text
//   and keeps the menu open; the second click runs onClick. Matches the
//   delete pattern used across the app (no native dialogs).

let menuEl = null;

export function closeCtxMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  document.removeEventListener("click", closeCtxMenu);
  document.removeEventListener("contextmenu", onDocContextMenu, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("blur", closeCtxMenu);
  window.removeEventListener("resize", closeCtxMenu);
}

// A right-click outside the open menu closes it (a new one may open after).
function onDocContextMenu(e) {
  if (menuEl && !menuEl.contains(e.target)) closeCtxMenu();
}

function onKeydown(e) {
  if (e.key === "Escape") closeCtxMenu();
}

export function openCtxMenu(x, y, items) {
  closeCtxMenu();

  const menu = document.createElement("div");
  menu.className = "ctx-menu";

  for (const it of items) {
    const b = document.createElement("button");
    b.className = "ctx-item" + (it.danger ? " ctx-item-danger" : "");
    b.textContent = it.label;
    let armed = false;
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (it.confirm && !armed) {
        armed = true;
        b.textContent = it.confirm;
        return;
      }
      closeCtxMenu();
      it.onClick();
    });
    menu.append(b);
  }

  document.body.append(menu);
  menuEl = menu;

  // Keep the menu inside the viewport.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`;

  // Defer wiring the close listeners so the opening event does not close it.
  setTimeout(() => {
    document.addEventListener("click", closeCtxMenu);
    document.addEventListener("contextmenu", onDocContextMenu, true);
    document.addEventListener("keydown", onKeydown);
    window.addEventListener("blur", closeCtxMenu);
    window.addEventListener("resize", closeCtxMenu);
  }, 0);
}
