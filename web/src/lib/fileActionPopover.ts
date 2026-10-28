/** The top layer is optional: older WebViews keep the menu in its inline
 * containing block. A detached/closing popover can also reject either call. */
export function showFileActionPopover(popup: HTMLElement): boolean {
  if (typeof popup.showPopover !== "function" || typeof popup.hidePopover !== "function") return false;
  popup.setAttribute("popover", "manual");
  try {
    popup.showPopover();
    return true;
  } catch {
    hideFileActionPopover(popup);
    return false;
  }
}

export function hideFileActionPopover(popup: HTMLElement): void {
  try {
    if (typeof popup.hidePopover === "function") popup.hidePopover();
  } catch {
    // Removing the attribute also leaves the top layer if native hide failed.
  } finally {
    popup.removeAttribute("popover");
  }
}
