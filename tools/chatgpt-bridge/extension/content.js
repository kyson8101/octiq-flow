"use strict";
(() => {
  if (globalThis.__localChatGPTBridge) return;
  globalThis.__localChatGPTBridge = true;
  const adapter = globalThis.ChatGPTBridgeAdapter;
  let running = null;
  let pendingResult = null;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "Bridge disconnected.");
    return response.data;
  }
  function assertActive(job) {
    if (job.cancelled || Date.now() >= job.deadline) throw new Error("Job cancelled or timed out. Check the tab before retrying; a question may already have been submitted.");
  }
  async function execute(job) {
    const before = adapter.snapshot(document);
    try {
      assertActive(job);
      adapter.insert(document, job.prompt);
      // Let the editor enable its send control; never press Enter as a fallback.
      let button;
      const sendDeadline = Date.now() + 5000;
      while (Date.now() < sendDeadline) {
        assertActive(job);
        button = adapter.sendButton(document);
        if (button && !button.disabled) break;
        await delay(100);
      }
      if (!button || button.disabled) throw new Error("ChatGPT send button unavailable. Review the unsent draft; the UI adapter may need an update.");
      assertActive(job);
      if (adapter.normalize(adapter.value(adapter.composer(document))) !== adapter.normalize(job.prompt)) {
        throw new Error("Composer changed before submission. Nothing was submitted.");
      }
      button.click();
      let previous = "";
      let stableSince = Date.now();
      while (Date.now() < job.deadline) {
        assertActive(job);
        const result = adapter.inspect(document, before, job.prompt);
        if (!result.complete || result.text !== previous) stableSince = Date.now();
        previous = result.text;
        if (result.complete && Date.now() - stableSince >= 3000) {
          return { type: "result", job_id: job.job_id, status: "completed", answer: result.text };
        }
        await delay(500);
      }
      throw new Error(before.sent
        ? "The question was sent, but a completed answer could not be read before the task deadline. Check the tab; do not resend automatically."
        : "Submission could not be confirmed before the task deadline. The question may already have been answered in ChatGPT. Check the tab; do not resend automatically.");
    } catch (error) {
      return { type: "result", job_id: job.job_id, status: "failed", error: error.message.slice(0, 2000) };
    }
  }
  async function tick() {
    try {
      const status = adapter.state(document);
      const result = await send({ type: "poll", ...status, detail: `${status.detail} [bridge 0.1.1]`, ready: status.ready && !running && !pendingResult, busy: status.busy || !!running || !!pendingResult });
      if (running && result.active_job_id !== running.job_id) running.cancelled = true;
      if (pendingResult) {
        try {
          await send(pendingResult);
          pendingResult = null;
        } catch (error) {
          // A restarted daemon has no old job to receive this answer.
          if (!result.active_job_id) pendingResult = null;
          else throw error;
        }
      }
      if (result.job && !running) {
        running = { ...result.job, cancelled: false };
        execute(running).then(answer => { pendingResult = answer; running = null; });
      }
    } catch {
      // A lost lease must not send a queued draft. Never replay a claimed job.
      if (running) running.cancelled = true;
    } finally { setTimeout(tick, 1000); }
  }
  tick();
})();
