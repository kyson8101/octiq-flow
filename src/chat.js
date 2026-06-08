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
const group = createTerminalGroup(mountEl, "chat");

// "+" spawns another free terminal at HOME (cwd "" -> backend uses HOME),
// no start command. Title is just a running count so tabs are tellable apart.
group.onAdd = () => spawnChatTerminal();

/** Spawn one free terminal in the chat group, cd'd to HOME. */
async function spawnChatTerminal() {
  const n = group.count() + 1;
  await group.newTerminal({ cwd: "", startCmd: null, title: `term ${n}` });
}

// Seed the first terminal once at init so Chat mode is never empty. Switching
// to other modes hides the group (terminals stay alive); coming back shows it.
if (group.count() === 0) spawnChatTerminal();
