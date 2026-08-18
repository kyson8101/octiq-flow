// Copy text to the clipboard, including where the modern API does not exist.
//
// `navigator.clipboard` needs a SECURE CONTEXT. On the desktop that is fine —
// the app is served from 127.0.0.1, which browsers treat as secure. But the
// whole point of v2 is reaching it from a phone, and that is
// `http://192.168.x.x:1421`: a plain-http origin, where `navigator.clipboard`
// is simply undefined. A copy button that only works at the desk is not much of
// a copy button.
//
// So there is a fallback to the deprecated `execCommand("copy")`, which has no
// such requirement. It needs a real element holding the text and a real
// selection, and iOS needs its own version of that — hence the contentEditable
// branch, which is the only way to get a selection onto a textarea there.

/** True when the modern API is actually usable, not merely present. */
function haveAsyncClipboard(): boolean {
  return !!navigator.clipboard?.writeText && window.isSecureContext;
}

/** Select `el`'s contents on iOS, where `select()` on a textarea does nothing. */
function selectOnIOS(el: HTMLTextAreaElement, length: number): void {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  el.setSelectionRange(0, length);
}

/** Copy `text`. Resolves to whether it actually landed, so a caller can say so
 *  rather than showing "copied" over a clipboard that never changed. */
export async function copyText(text: string): Promise<boolean> {
  if (haveAsyncClipboard()) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied, or the page was not focused. Fall through and try the old way.
    }
  }

  const holder = document.createElement("textarea");
  holder.value = text;
  holder.setAttribute("readonly", "");
  holder.contentEditable = "true";
  // Off-screen would stop the selection working on some browsers, and scrolling
  // to it would move the page under the reader. Fixed and invisible instead.
  holder.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;";
  document.body.appendChild(holder);

  try {
    const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    if (iOS) selectOnIOS(holder, text.length);
    else holder.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    holder.remove();
  }
}
