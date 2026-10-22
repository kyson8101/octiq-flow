import { createContext, useContext, useRef } from "react";
import { dropHeld } from "../lib/pressGuard";
import { useConfirm, type ConfirmOptions } from "./Confirm";

export type TerminalRun = {
  folder: string;
  run: (command: string) => void;
};

// The transcript only knows this capability. App owns the terminal and socket.
// No provider in a worker, task pane or subagent transcript means no control.
export const TerminalRunContext = createContext<TerminalRun | null>(null);

export function runConfirm(command: string, folder: string): ConfirmOptions {
  return {
    title: "Run this command?",
    command,
    body: `Folder: ${folder.split(/[\\/]/).filter(Boolean).pop() || folder}\n${folder}`,
    confirmLabel: "Run",
    cancelLabel: "Cancel",
  };
}

export function RunCommand({ command }: { command: string }) {
  const terminal = useContext(TerminalRunContext);
  const confirm = useConfirm();
  const asking = useRef(false);
  if (!terminal || !command.trim()) return null;
  return <button className="code-copy code-run" type="button" onKeyDown={dropHeld} onClick={async () => {
    if (asking.current) return;
    asking.current = true;
    try {
      if (await confirm(runConfirm(command, terminal.folder))) terminal.run(command);
    } finally { asking.current = false; }
  }}>Run</button>;
}
