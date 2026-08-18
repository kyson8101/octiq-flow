// Card 07 — Chat mode: a full area of free terminals, not tied to any project.
//
// Chat owns ONE TerminalGroup (from terminals.js). Each tab is its own real
// terminal that can run a separate claude / codex / shell at the same time,
// all cd'd to HOME (cwd ""). There is no project binding here.
//
// The group already handles tabs, close, keep-alive, and the single pty-output
// listener. We only give it an idPrefix ("chat", so PTY ids stay app-wide
// unique) and an onAdd policy, then seed one terminal so the view is not empty
// when first opened.
import { createTerminalGroup } from "/terminals.js";

const mountEl = document.querySelector("#chat-terminals");
// quickSpawn: the "+" is a dropdown with Terminal / Claude / Codex, exactly like
// Project mode. Chat is where a quick throwaway agent belongs most, so it gets
// the same one-click launch. The agent rows hide themselves when that agent is
// not installed (terminals.js).
const group = createTerminalGroup(mountEl, "chat", { quickSpawn: true });

// Add-menu "Terminal" row: another free terminal at HOME (cwd "" -> backend uses
// HOME), no start command. Title is just a running count so tabs are tellable
// apart.
group.onAdd = () => spawnChatTerminal();
// Add-menu "Claude" / "Codex" rows: a new terminal already running that agent.
group.onQuickSpawn = (agent) => spawnChatAgent(agent);

/** Spawn one free terminal in the chat group, cd'd to HOME. */
async function spawnChatTerminal() {
  const n = group.count() + 1;
  return group.newTerminal({ cwd: "", startCmd: null, title: `term ${n}` });
}

/** Open a new chat terminal and launch an AI agent in it at HOME. The binary is
 *  picked from a fixed allowlist — the agent name from the UI only chooses
 *  between two literal strings, never interpolated. Unlike Project mode there
 *  are no project folders, so Claude gets no `--add-dir` flags. */
async function spawnChatAgent(agent) {
  const bin = agent === "codex" ? "codex" : "claude";
  const title = bin === "codex" ? "Codex" : "Claude";
  return group.newTerminal({ cwd: "", startCmd: bin, title });
}

/** Adopt the chat terminals the SERVER already has (the browser client — see
 *  tauriws.js / web.rs). The machine running OctiqFlow owns them; a remote view
 *  that seeded its own would quietly add a terminal to that machine every time
 *  someone opened the page. Falls back to seeding one only when the server has
 *  no chat terminal at all. */
async function attachChatTerminals() {
  const { invoke } = window.__TAURI__.core;
  const sessions = await invoke("pty_active_sessions").catch(() => []);
  const mine = (sessions || [])
    .filter((s) => s.id.startsWith("chat:"))
    .sort((a, b) => Number(a.id.slice(5)) - Number(b.id.slice(5)));
  if (!mine.length) {
    spawnChatTerminal();
    return;
  }
  for (const s of mine) {
    const text = s.persist_key
      ? (await invoke("load_scrollback", { key: s.persist_key }).catch(() => "")) || ""
      : "";
    await group.newTerminal({
      attachId: s.id,
      persistKey: s.persist_key || undefined,
      restoreScrollback: text,
      cwd: "",
    });
  }
}

// Seed the first terminal once at init so Chat mode is never empty. Switching
// to other modes hides the group (terminals stay alive); coming back shows it.
// In a browser the terminals live on the server, so attach to them instead.
if (group.count() === 0) {
  if (window.OCTIQ_WEB) attachChatTerminals();
  else spawnChatTerminal();
}
