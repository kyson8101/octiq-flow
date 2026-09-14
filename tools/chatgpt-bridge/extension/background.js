"use strict";

// Keep the pairing secret in trusted extension contexts, never the page/content script.
const storageReady = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]);
function isChatGPT(url) {
  try { return new URL(url).origin === "https://chatgpt.com"; } catch { return false; }
}
async function request(config, endpoint, body) {
  if (!config || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535 || !/^[a-f0-9]{64}$/.test(config.token)) {
    throw new Error("Enter the port and pairing token from the bridge config.");
  }
  const response = await fetch(`http://127.0.0.1:${config.port}${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: "error",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
async function handle(message, sender) {
  await storageReady;
  if (!message || typeof message.type !== "string") throw new Error("Invalid message.");
  const { config } = await chrome.storage.local.get("config");
  const { attachment } = await chrome.storage.session.get("attachment");
  const fromPopup = sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html") && !sender.tab;
  if (fromPopup) {
    if (message.type === "settings") return { port: config?.port ?? 43189, paired: !!config, attachment: attachment ? { tabId: attachment.tabId } : null };
    if (message.type === "attach") {
      const nextConfig = { port: Number(message.port), token: message.token || config?.token };
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !isChatGPT(tab.url)) throw new Error("Open a ChatGPT tab first, then click the extension.");
      // Same-tab reconnect keeps the lease identity; another tab gets a new identity.
      const next = { tabId: tab.id, client: attachment?.tabId === tab.id ? attachment.client : crypto.randomUUID() };
      await request(nextConfig, "/extension/attach", { client: next.client, url: tab.url });
      await chrome.storage.local.set({ config: nextConfig });
      await chrome.storage.session.set({ attachment: next });
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["adapter.js", "content.js"] });
      } catch (error) {
        await request(nextConfig, "/extension/detach", { client: next.client }).catch(() => {});
        await chrome.storage.session.remove("attachment");
        throw error;
      }
      return { attached: true };
    }
    if (message.type === "detach") {
      if (attachment) {
        // Local detachment remains possible when the daemon is down.
        await chrome.storage.session.remove("attachment");
        await request(config, "/extension/detach", { client: attachment.client }).catch(() => {});
      }
      return { detached: true };
    }
    if (message.type === "status") return await request(config, "/tool", { name: "chatgpt_status" });
    throw new Error("Unknown popup action.");
  }
  if (sender.id !== chrome.runtime.id || sender.frameId !== 0 || !isChatGPT(sender.url) || sender.tab?.id !== attachment?.tabId) {
    throw new Error("Tab not attached. Use the extension popup to attach this ChatGPT tab.");
  }
  if (message.type === "poll") {
    const tab = await chrome.tabs.get(attachment.tabId);
    if (!isChatGPT(tab.url)) throw new Error("The attached tab left ChatGPT.");
    return await request(config, "/extension/poll", {
      client: attachment.client, url: tab.url, ready: message.ready === true,
      busy: message.busy === true, detail: typeof message.detail === "string" ? message.detail.slice(0, 300) : "",
    });
  }
  if (message.type === "result") {
    const tab = await chrome.tabs.get(attachment.tabId);
    if (!isChatGPT(tab.url)) throw new Error("The attached tab left ChatGPT.");
    return await request(config, "/extension/result", {
      client: attachment.client, job_id: message.job_id, status: message.status,
      answer: message.answer, error: message.error, url: tab.url,
    });
  }
  throw new Error("Unknown tab action.");
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message }));
  return true;
});
