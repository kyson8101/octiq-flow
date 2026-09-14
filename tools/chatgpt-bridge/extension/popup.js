"use strict";
const statusElement = document.getElementById("status");
async function send(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || "Extension unavailable.");
  return response.data;
}
async function refresh() {
  const settings = await send({ type: "settings" });
  document.getElementById("port").value = settings.port;
  document.getElementById("paired").textContent = settings.paired ? "Token saved locally. Leave blank to reuse it." : "Start the local bridge before connecting.";
  if (!settings.paired) { statusElement.textContent = "Not paired."; return; }
  const status = await send({ type: "status" });
  statusElement.textContent = status.ready ? "Connected · ready for Codex questions." : status.connected ? `Connected · ${status.hint || "busy"}` : "Not connected. Attach this tab.";
}
document.getElementById("connect").addEventListener("submit", async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    await send({ type: "attach", port: document.getElementById("port").value, token: document.getElementById("token").value.trim() });
    document.getElementById("token").value = "";
    statusElement.textContent = "Attached. The tab will report ready shortly.";
  } catch (error) { statusElement.textContent = error.message; }
  finally { button.disabled = false; }
});
document.getElementById("disconnect").addEventListener("click", async () => {
  try { await send({ type: "detach" }); statusElement.textContent = "Disconnected."; }
  catch (error) { statusElement.textContent = error.message; }
});
refresh().catch(error => { statusElement.textContent = error.message; });
