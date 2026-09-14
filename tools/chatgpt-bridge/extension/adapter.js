"use strict";

// UI-only adapter. No cookies, internal ChatGPT endpoints, or network interception.
// Selectors are intentionally isolated: an unsupported UI must fail visibly.
(() => {
  const normalize = value => value.replace(/\s+/g, " ").trim();
  const visible = element => element && element.getClientRects().length > 0;
  function composer(doc) {
    return [...doc.querySelectorAll('#prompt-textarea, textarea[data-id="root"], [contenteditable="true"][data-placeholder]')].find(visible);
  }
  const value = element => element ? (element.tagName === "TEXTAREA" ? element.value : element.innerText) : "";
  const stopButton = doc => [...doc.querySelectorAll('[data-testid="stop-button"], button[aria-label="Stop answering"], button[aria-label="Stop generating"], button[aria-label="Stop streaming"]')].find(visible);
  const sendButton = doc => [...doc.querySelectorAll('[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]')].find(visible);
  const messages = (doc, role) => [...doc.querySelectorAll(`[data-message-author-role="${role}"]`)];
  const messageKey = element => element.getAttribute("data-message-id") || element;
  function state(doc) {
    const input = composer(doc);
    const busy = !!stopButton(doc);
    const empty = input && !normalize(value(input));
    return { ready: !!input && !input.disabled && !!empty && !busy, busy, detail: !input ? "ChatGPT composer unavailable. Log in or check the page." : !empty ? "Composer contains a draft." : busy ? "ChatGPT is generating." : "Ready." };
  }
  function snapshot(doc) {
    const users = messages(doc, "user");
    return {
      users: new Set(users.map(messageKey)),
      lastUser: users.length ? messageKey(users.at(-1)) : null,
      assistants: new Set(messages(doc, "assistant").map(messageKey)),
      pathname: doc.location?.pathname,
      sent: false,
    };
  }
  function inspect(doc, before, prompt) {
    if (before.pathname?.startsWith("/c/") && doc.location?.pathname !== before.pathname) {
      throw new Error("The conversation changed during the bridge job. Check the tab; no answer was attributed to this question.");
    }
    const users = messages(doc, "user");
    const anchor = users.findLastIndex(element => messageKey(element) === before.lastUser);
    const candidates = users.slice(anchor + 1).filter(element => !before.users.has(messageKey(element)));
    // Virtualized history can shrink or remount without growing the user count.
    // Identity, order and the exact prompt establish attribution, not node count.
    const unique = [...new Map(candidates.map(element => [messageKey(element), element])).values()];
    if (!unique.length) return { sent: before.sent, complete: false, text: "" };
    if (unique.length !== 1 || normalize(unique[0].innerText) !== normalize(prompt)) {
      throw new Error("The conversation changed during the bridge job. Check the tab; no answer was attributed to this question.");
    }
    before.sent = true;
    const user = unique[0];
    const ordered = [...doc.querySelectorAll('[data-message-author-role]')];
    const after = ordered.slice(ordered.indexOf(user) + 1).filter(element => element.getAttribute("data-message-author-role") === "assistant" && !before.assistants.has(messageKey(element)));
    const assistant = after.at(-1);
    if (!assistant) return { sent: true, complete: false, text: "" };
    const text = (assistant.querySelector(".markdown") || assistant).innerText.trim();
    const turn = assistant.closest('[data-turn="assistant"], article') || assistant.parentElement;
    const copy = turn?.querySelector('[data-testid="copy-turn-action-button"]');
    // A new assistant node alone is not enough: wait for completed-turn controls.
    return { sent: true, text, complete: !!text && !stopButton(doc) && !!copy && !copy.disabled };
  }
  function insert(doc, prompt) {
    const input = composer(doc);
    if (!input || normalize(value(input)) || stopButton(doc)) throw new Error("ChatGPT is not ready; existing drafts are never overwritten.");
    input.focus();
    if (input.tagName === "TEXTAREA") {
      const setter = Object.getOwnPropertyDescriptor(doc.defaultView.HTMLTextAreaElement.prototype, "value").set;
      setter.call(input, prompt);
      input.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
    } else {
      // insertText enters plain text via the editor's normal input path.
      if (!doc.execCommand("insertText", false, prompt)) throw new Error("ChatGPT editor rejected text insertion. Nothing was submitted.");
    }
    if (normalize(value(input)) !== normalize(prompt)) throw new Error("Could not verify the composer text. Review the draft in ChatGPT; nothing was submitted.");
  }
  const api = { normalize, composer, value, state, snapshot, inspect, insert, sendButton };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.ChatGPTBridgeAdapter = api;
})();
