import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { CopyIcon, TickIcon } from "./CopyBit";

export function CopyChatIdButton({ chatId }: { chatId: string }) {
  const [result, setResult] = useState<"idle" | "done" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const label = result === "done"
    ? "Chat ID copied"
    : result === "failed"
      ? "Could not copy chat ID"
      : "Copy chat ID";

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  return (
    <button
      className={`icon-btn copy-chat-id is-${result}`}
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => {
        setResult((await copyText(chatId)) ? "done" : "failed");
        if (timer.current !== null) clearTimeout(timer.current);
        timer.current = setTimeout(() => setResult("idle"), 1600);
      }}
    >
      {result === "done" ? <TickIcon /> : <CopyIcon />}
      <span className="topbar-action-label">{label}</span>
    </button>
  );
}
