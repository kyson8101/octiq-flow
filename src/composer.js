// The composer: the chat-style prompt box at the bottom of Project mode.
//
// This is the app's main way to start work, in place of the old "+" tab-strip
// button: type what you want, pick the agent + model, press Enter.
//
//   the picked agent already runs in the terminal you are looking at
//       -> the text is typed into it (the app's pty_write trick), Enter and all
//   anything else (a shell tab, another agent, no terminal at all)
//       -> a NEW terminal opens on that agent with the prompt as its first
//          argument (`claude --model opus '<prompt>'`), so the agent boots
//          straight into it
//
// Passing the prompt as an argument rather than typing it in afterwards is what
// makes the "start a new one" path reliable: writing into a PTY while an agent
// is still painting its first screen loses characters.
//
// With no terminal open, the box moves to the middle of the empty area as a
// greeting screen (the `pc-hero` state) — the same shape a chat app shows
// before the first message.
import { ICONS } from "/icons.js";
import {
  activeTabInfo,
  groupTabCount,
  installedAgentList,
  sendToProjectTerminal,
} from "/terminals.js";
import { launchInProject } from "/project.js";

// --- The model table -------------------------------------------------------
// The ONE place to edit when a model alias changes or a new one ships. `flag`
// is passed verbatim on the agent's command line and never comes from typed
// text. `agent` gates the row on what this machine can actually launch
// (available_agents), except for the shell, which is always there.
const CHOICES = [
  { id: "claude:opus", agent: "claude", bin: "claude", name: "Claude", model: "Opus", flag: "--model opus" },
  { id: "claude:sonnet", agent: "claude", bin: "claude", name: "Claude", model: "Sonnet", flag: "--model sonnet" },
  { id: "claude:haiku", agent: "claude", bin: "claude", name: "Claude", model: "Haiku", flag: "--model haiku" },
  { id: "claude:fable", agent: "claude", bin: "claude", name: "Claude", model: "Fable", flag: "--model fable" },
  { id: "claude:default", agent: "claude", bin: "claude", name: "Claude", model: "Default", flag: "" },
  { id: "codex:default", agent: "codex", bin: "codex", name: "Codex", model: "Default", flag: "" },
  { id: "codex:sol", agent: "codex", bin: "codex", name: "Codex", model: "gpt-5.6-sol", flag: "-m gpt-5.6-sol" },
  // No binary: the prompt is run as a shell command instead.
  { id: "shell", agent: "shell", bin: null, name: "Shell", model: "", flag: "" },
];

const CHOICE_KEY = "octiq.composer.choice";

// --- DOM handles -----------------------------------------------------------
const rootEl = document.querySelector("#project-composer");
const termsEl = document.querySelector(".center-terms");
const greetEl = document.querySelector("#pc-greeting");
const inputEl = document.querySelector("#pc-input");
const pickBtn = document.querySelector("#pc-pick");
const pickLabelEl = document.querySelector("#pc-pick-label");
const sendBtn = document.querySelector("#pc-send");

// --- State -----------------------------------------------------------------
let projectId = null;
let projectName = "";
let choiceId = localStorage.getItem(CHOICE_KEY) || CHOICES[0].id;
// The open model menu, or null. Mounted on <body> like the old add menu, so it
// is never clipped by the composer box.
let menuEl = null;
let menuDismiss = null;

/** The rows this machine can offer: every agent the backend found, plus the
 *  shell. Falls back to the shell alone if the probe found nothing. */
function available() {
  const agents = installedAgentList();
  return CHOICES.filter((c) => c.agent === "shell" || agents.includes(c.agent));
}

function currentChoice() {
  const rows = available();
  return rows.find((c) => c.id === choiceId) || rows[0];
}

function labelFor(c) {
  return c.model ? `${c.name} · ${c.model}` : c.name;
}

// --- Render ----------------------------------------------------------------

function render() {
  const has = !!projectId;
  rootEl.classList.toggle("hidden", !has);
  if (!has) {
    termsEl?.classList.remove("ct-hero");
    return;
  }

  const choice = currentChoice();
  pickLabelEl.textContent = labelFor(choice);
  inputEl.placeholder =
    choice.bin === null
      ? "Run a command…"
      : `Ask ${choice.name} to…`;

  // Nothing open in this project yet: the box takes the middle of the empty
  // area with a greeting over it, the way a chat app opens.
  const empty = groupTabCount(projectId) === 0;
  rootEl.classList.toggle("pc-hero", empty);
  termsEl?.classList.toggle("ct-hero", empty);
  greetEl.textContent = empty ? `What do you want to do in ${projectName}?` : "";
  greetEl.classList.toggle("hidden", !empty);

  sendBtn.disabled = !inputEl.value.trim();
}

/** Grow the box with its text, up to a few lines, then scroll inside it. */
function autoGrow() {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 176)}px`;
}

// --- The model menu --------------------------------------------------------

function closeMenu() {
  if (!menuEl) return;
  if (menuDismiss) {
    document.removeEventListener("mousedown", menuDismiss, true);
    document.removeEventListener("keydown", menuDismiss, true);
    menuDismiss = null;
  }
  menuEl.remove();
  menuEl = null;
  pickBtn.setAttribute("aria-expanded", "false");
}

function openMenu() {
  if (menuEl) return;
  const menu = document.createElement("div");
  menu.className = "pc-menu";
  menu.setAttribute("role", "menu");

  for (const c of available()) {
    const item = document.createElement("button");
    item.className = "pc-menu-item" + (c.id === choiceId ? " pc-menu-item-on" : "");
    item.setAttribute("role", "menuitem");
    const name = document.createElement("span");
    name.className = "pc-menu-name";
    name.textContent = c.name;
    const model = document.createElement("span");
    model.className = "pc-menu-model";
    model.textContent = c.model || "plain terminal";
    item.append(name, model);
    item.addEventListener("click", () => {
      choiceId = c.id;
      localStorage.setItem(CHOICE_KEY, choiceId);
      closeMenu();
      render();
      inputEl.focus();
    });
    menu.append(item);
  }

  document.body.append(menu);
  menuEl = menu;
  pickBtn.setAttribute("aria-expanded", "true");

  // Above the button (the composer sits at the bottom of the window), clamped
  // to the viewport so it can never open off screen.
  const r = pickBtn.getBoundingClientRect();
  const top = Math.max(8, r.top - menu.offsetHeight - 6);
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 8 - menu.offsetWidth)))}px`;

  menuDismiss = (ev) => {
    if (ev.type === "keydown") {
      if (ev.key === "Escape") closeMenu();
      return;
    }
    if (menu.contains(ev.target) || pickBtn.contains(ev.target)) return;
    closeMenu();
  };
  document.addEventListener("mousedown", menuDismiss, true);
  document.addEventListener("keydown", menuDismiss, true);
}

// --- Sending ---------------------------------------------------------------

/** Which agent binary a tab is running, from what it was launched with or the
 *  first command typed into it. "" for a plain shell. */
function tabBin(tab) {
  const cmd = (tab.startCmd || tab.firstCmd || "").trim();
  const first = cmd.split(/\s+/)[0] || "";
  if (first === "claude" || first === "codex") return first;
  return "";
}

/** True when the terminal in front of the user can take this text as it is. */
function canReuse(tab, choice) {
  if (!tab || tab.content) return false;
  const running = tabBin(tab);
  // A plain shell command goes to a plain shell — never into an agent's prompt.
  if (choice.bin === null) return running === "" && !tab.agent;
  return running === choice.bin;
}

async function send() {
  const text = inputEl.value.trim();
  if (!text || !projectId) return;
  const choice = currentChoice();

  if (canReuse(activeTabInfo(projectId), choice)) {
    sendToProjectTerminal(projectId, text, true);
  } else {
    await launchInProject(projectId, {
      bin: choice.bin,
      flag: choice.flag,
      prompt: text,
      title: choice.bin ? choice.name : null,
    });
  }

  inputEl.value = "";
  autoGrow();
  render();
}

// --- Wiring ----------------------------------------------------------------

inputEl.addEventListener("input", () => {
  autoGrow();
  sendBtn.disabled = !inputEl.value.trim();
});

inputEl.addEventListener("keydown", (e) => {
  // Enter sends, Shift+Enter (and the usual Cmd/Ctrl+Enter) makes a new line —
  // the shape every agent chat box uses.
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

sendBtn.addEventListener("click", () => send());
sendBtn.innerHTML = ICONS.arrowUp(15);

pickBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (menuEl) closeMenu();
  else openMenu();
});

// The selected project decides where a send goes, and its name greets the user
// on the empty screen.
window.addEventListener("project-selected", (e) => {
  const detail = e.detail;
  projectId = detail?.id || null;
  projectName = detail?.name || "this project";
  closeMenu();
  render();
});

// A terminal opened or closed: the greeting screen appears / gets out of the
// way. (tg-tabs-change also covers activation, which decides reuse.)
for (const ev of ["tg-tabs-change", "tg-terminals-change"]) {
  window.addEventListener(ev, render);
}

render();
