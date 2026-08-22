// A project's saved commands (card 68).
//
// A project is a folder you keep coming back to, and the things you run in it
// are the same three or four every day: `pnpm dev`, `cargo test`, `git pull`.
// Typing them into a fresh shell each time is the part worth removing — so a
// project carries a short list of named commands, and one click opens a
// terminal in that project's folder with the command already running.
//
// The list belongs to the BACKEND, not to this browser. It rides along with the
// project on `list_workspaces` (the `actions` field, which the vanilla desktop
// UI has written for a long time), and is edited through `add_action` /
// `update_action` / `delete_action`. That is deliberate: the folder these run in
// is the server's, so the phone that opens the project on the sofa should offer
// the same list as the laptop that wrote it.
//
// This module is the model alone — reading that list and checking a draft.
// Opening the terminal is the drawer's job, and what a tab does with a command
// is `terminals.ts`.

/** One saved command: what the chip says, and what the shell is given. */
export type Command = { id: string; label: string; command: string };

/** One row of the backend's list, if it is a row we can draw and run.
 *
 *  Everything is trimmed here rather than at the call sites, because the same
 *  value is compared against a form field, written into a tab name, and sent to
 *  a shell — three places that would each have to remember to do it. */
function asCommand(value: unknown): Command | null {
  if (!value || typeof value !== "object") return null;
  const { id, label, command } = value as {
    id?: unknown;
    label?: unknown;
    command?: unknown;
  };
  if (typeof id !== "string" || typeof label !== "string" || typeof command !== "string") {
    return null;
  }
  const row = { id: id.trim(), label: label.trim(), command: command.trim() };
  // A chip with no label is a blank button; one with no command does nothing
  // when pressed. Neither is worth drawing, and an id-less row could not be
  // edited or deleted afterwards.
  return row.id && row.label && row.command ? row : null;
}

/** The commands a project has, from whatever `list_workspaces` sent.
 *
 *  A project written before this feature existed has no list at all, and one
 *  written by an older build may have rows this one cannot use. Both mean the
 *  same thing to the drawer — no chips — so neither throws. */
export function parseCommands(value: unknown): Command[] {
  if (!Array.isArray(value)) return [];
  const rows: Command[] = [];
  for (const entry of value) {
    const row = asCommand(entry);
    if (row) rows.push(row);
  }
  return rows;
}

/** Whether the add / edit form has enough to save. Both fields are required —
 *  the backend refuses a blank one, and a disabled button says so earlier and
 *  more quietly than an error under the form. */
export function isReady(label: string, command: string): boolean {
  return Boolean(label.trim()) && Boolean(command.trim());
}

/** Whether the form still holds exactly what it was opened with. Saving that
 *  would write the store to disk and reload every project to change nothing. */
export function sameCommand(row: Command, label: string, command: string): boolean {
  return row.label === label.trim() && row.command === command.trim();
}
