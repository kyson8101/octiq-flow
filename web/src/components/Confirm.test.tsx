// An action that stops or starts work is never fired by the key or the
// press that brought it on screen.
//
// The shared question (`Confirm`) and the one before a chat is completed
// put the keyboard on the safe answer, so a second Enter or Space cancels;
// a key held down answers nothing; and a pointer press that repeats the one
// that opened the question, in the same spot, does not confirm it. The same
// guard is on the run panel's start controls. What can only be seen in a
// browser (where focus lands, what a second Enter sends) is in the evidence
// of the change; here are the rules it is built from.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("../lib/bridge", () => ({
  bridge: { invoke: async () => null, on: () => () => {}, onState: () => () => {} },
}));

import { STRAY_MS, STRAY_RADIUS } from "../lib/cardFold";
import { confirmContent } from "../lib/chatComplete";
import { heldKey, strayAnswer } from "../lib/pressGuard";
import { stopConfirm } from "../lib/taskReopened";
import { ConfirmDialog } from "./Confirm";
import { CompleteChatConfirm } from "./CompleteChat";
import panelSource from "./OrchestrationPanel.tsx?raw";
import noteSource from "./ReopenedNote.tsx?raw";

const sources = import.meta.glob("../**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[^<]*<\/button>/g)].map((match) => match[0]);

describe("where the keyboard is put when a question opens", () => {
  it("is the safe answer, for a question that stops something", () => {
    const html = renderToStaticMarkup(<ConfirmDialog options={stopConfirm({ title: "Implement" })} onAnswer={() => {}} />);
    const [cancel, confirm] = buttons(html);
    expect(cancel).toContain(">Keep it running</button>");
    expect(cancel).toContain('autofocus=""');
    expect(confirm).toContain(">Stop worker</button>");
    expect(confirm).not.toContain("autofocus");
    expect(confirm).toContain("is-danger");
  });

  it("is the safe answer for every other question too", () => {
    const html = renderToStaticMarkup(<ConfirmDialog options={{ title: "Close this mission?", confirmLabel: "Close mission" }} onAnswer={() => {}} />);
    const [cancel, confirm] = buttons(html);
    expect(cancel).toContain(">Cancel</button>");
    expect(cancel).toContain('autofocus=""');
    expect(confirm).not.toContain("autofocus");
  });

  it("is Cancel before a chat is completed, whether or not the host has answered", () => {
    for (const loading of [true, false]) {
      const html = renderToStaticMarkup(<CompleteChatConfirm content={confirmContent(undefined)} loading={loading} onCancel={() => {}} onConfirm={() => {}} />);
      const all = buttons(html);
      const cancel = all.find((button) => button.includes(">Cancel</button>"))!;
      const complete = all.find((button) => button.includes("Complete"))!;
      expect(cancel).toContain('autofocus=""');
      expect(complete).not.toContain("autofocus");
    }
  });
});

describe("a key held down", () => {
  it("answers nothing: the repeats of Enter and Space are dropped", () => {
    expect(heldKey({ key: "Enter", repeat: true })).toBe(true);
    expect(heldKey({ key: " ", repeat: true })).toBe(true);
    expect(heldKey({ key: "Spacebar", repeat: true })).toBe(true);
  });

  it("is not a key pressed again, and no other key is held back", () => {
    expect(heldKey({ key: "Enter", repeat: false })).toBe(false);
    expect(heldKey({ key: " ", repeat: false })).toBe(false);
    expect(heldKey({ key: "Tab", repeat: true })).toBe(false);
    expect(heldKey({ key: "Escape", repeat: true })).toBe(false);
  });
});

describe("a pointer press on the confirming answer", () => {
  const opener = { x: 640, y: 400, at: 1000 };

  it("is dropped when it repeats the press that opened the question, in the same spot", () => {
    expect(strayAnswer(opener, { detail: 1, x: 640, y: 400, at: 1150 })).toBe(true);
    expect(strayAnswer(opener, { detail: 2, x: 640 + STRAY_RADIUS, y: 400, at: 1000 + STRAY_MS })).toBe(true);
  });

  it("goes through once the pointer has moved, or the person has had time to read", () => {
    expect(strayAnswer(opener, { detail: 1, x: 640 + STRAY_RADIUS + 1, y: 400, at: 1150 })).toBe(false);
    expect(strayAnswer(opener, { detail: 1, x: 640, y: 400, at: 1000 + STRAY_MS + 1 })).toBe(false);
  });

  it("is never a key: Tab to the answer and Enter is an answer", () => {
    expect(strayAnswer(opener, { detail: 0, x: 0, y: 0, at: 1001 })).toBe(false);
    expect(strayAnswer(null, { detail: 1, x: 640, y: 400, at: 1001 })).toBe(false);
  });
});

describe("who asks through the shared question", () => {
  it("is this list, and a new caller is added to it", () => {
    const callers = Object.entries(sources)
      .filter(([path, source]) => !/\.test\.tsx?$/.test(path) && !path.endsWith("/Confirm.tsx") && /\buseConfirm\(\)/.test(source))
      // As paths under `src`: the glob's keys are relative to this folder.
      .map(([path]) => path.replace(/^\.\.\//, "").replace(/^\.\//, "components/")).sort();
    expect(callers).toEqual([
      "App.tsx",                       // Close a mission after its chat was completed
      "components/EditorMode.tsx",     // Discard changes, Reload from disk, Overwrite
      "components/FilePanel.tsx",      // Discard changes
      "components/ProjectSettings.tsx", // Delete a project
      "components/ReopenedNote.tsx",   // Stop a task's worker
      "components/TerminalDrawer.tsx", // Delete a saved command
    ]);
  });

  it("no page asks with the browser's own confirm", () => {
    const native = Object.entries(sources)
      .filter(([path, source]) => !/\.test\.tsx?$/.test(path) && /window\.confirm\(/.test(source)).map(([path]) => path);
    expect(native).toEqual([]);
  });
});

describe("the controls that start or stop a worker", () => {
  it("drop a held key and are behind the stray-press guard of what opens them", () => {
    // One component draws every start, and it drops the repeats of a key.
    expect(panelSource).toMatch(/function StartButton\([\s\S]*?onKeyDown=\{dropHeld\}/);
    // Each disclosure of the panel that can bring a start under the pointer
    // is remembered by the guard the cards use (`lib/pressGuard.notePress`).
    for (const control of ["orch-task-expand", "run-group-head", "run-group-more", "orch-task-more-summary"]) {
      expect(panelSource, control).toMatch(new RegExp(`className="${control}"[^>]*?onClick=\\{\\(event\\) => \\{\\s*notePress\\(event\\)`));
    }
    expect(noteSource).toMatch(/className="reopened-note-stop"[^>]*onKeyDown=\{dropHeld\}/);
  });
});
