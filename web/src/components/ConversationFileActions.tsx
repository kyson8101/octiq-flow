// The small, explicit controls beside a file mentioned in a conversation.
//
// A path itself remains the familiar thing to click. The two named actions
// remove the guesswork, though: "Copy path" puts the canonical server path on
// the clipboard for sharing, and "Open" uses the same viewer that every other
// part of OctiqFlow uses for that file.
import { useState, type ReactNode } from "react";
import { copyText } from "../lib/clipboard";
import { useOpenFile } from "./OpenFileContext";
import { CopyIcon, TickIcon } from "./CopyBit";

export function ConversationFileActions({
  path,
  children,
  code = false,
}: {
  /** The resolved path on the server, rather than the shorter words in the reply. */
  path: string;
  children: ReactNode;
  /** Inline-code paths keep their existing code-chip treatment. */
  code?: boolean;
}) {
  const open = useOpenFile();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    if (!await copyText(path)) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  return (
    <span className="prose-file-actions">
      <button
        className={`prose-path ${code ? "is-code" : ""}`}
        type="button"
        title={path}
        onClick={() => open(path)}
      >
        {children}
      </button>
      <button
        className="prose-file-action"
        type="button"
        title={copied ? "Path copied" : `Copy path: ${path}`}
        aria-label={copied ? "Path copied" : `Copy path: ${path}`}
        onClick={() => void copy()}
      >
        {copied ? <TickIcon /> : <CopyIcon />}
      </button>
      <button
        className="prose-file-action"
        type="button"
        title={`Open in OctiqFlow: ${path}`}
        aria-label={`Open in OctiqFlow: ${path}`}
        onClick={() => open(path)}
      >
        <OpenIcon />
      </button>
    </span>
  );
}

/** An arrow leaving a document: open this file in OctiqFlow's viewer. */
function OpenIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 3h7v7" />
      <path d="m21 3-9 9" />
      <path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
    </svg>
  );
}
