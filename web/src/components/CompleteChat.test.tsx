// Completing a chat, as it is drawn: the action in the chat's menu, the
// question before anything is sent, the one line on the chat, and the wrap-up's
// own bubble in the transcript.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The dialog's asking half opens the socket the moment it is imported.
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [], on: () => () => {} } }));

import { ChatCompletionLine, CompleteChatButton, CompleteChatConfirm, WrapUpNote } from "./CompleteChat";
import { MessageList } from "./MessageList";
import { conversationMapTurns } from "./ConversationMap";
import { Sidebar } from "./Sidebar";
import {
  chatKindOf,
  completeAction,
  completionLine,
  confirmContent,
  type CompletePreview,
} from "../lib/chatComplete";
import type { Message } from "../lib/chat";
import sheet from "./CompleteChat.css?raw";

const preview: CompletePreview = {
  chatKey: "chat:c1",
  running: true,
  registeredAgent: true,
  workspace: {
    cwd: "/trees/octiq-flow/feature/complete-chat", exists: true, isRepo: true,
    repoRoot: "/trees/octiq-flow/feature/complete-chat", primaryRoot: "/repos/octiq-flow",
    branch: "feature/complete-chat", isWorktree: true, changed: 3, ahead: 0, behind: 0, hasUpstream: false,
  },
  delivery: {
    target: "develop", head: "abc1234", onTarget: false, commits: 2, uncommitted: 3, pushed: false,
    merged: false, mergedRemote: false, released: null, releaseNote: "", stale: false, checkedAt: 1,
  },
  runs: [{ runId: "run_1", status: "running", live: true, mission: true, workersRunning: 2, closeEligible: false }],
};

const nothing = () => {};
const text = "The person is completing this chat. Wrap up now, in this order, and start no new work.\n1. Work: commit any uncommitted work.\n2. Report in at most ten lines.";
const wrapUp = (over: Partial<Message> = {}): Message => ({
  id: "u:octiq-complete-1", turnId: "octiq-complete-1", role: "user", streaming: false,
  blocks: [{ kind: "text", text }], delivery: "queued", ...over,
});

describe("the Complete action", () => {
  const draw = (kind: Parameters<typeof chatKindOf>[0], completing = false, connected = true) => renderToStaticMarkup(
    <CompleteChatButton action={completeAction({ kind: chatKindOf(kind), completing, connected })} onClick={nothing} />,
  );
  const main = { key: "chat:c1", worker: false, frontDesk: false };

  it("is an icon button with a tooltip, and a label for the menu row", () => {
    const html = draw(main);
    expect(html).toContain('class="icon-btn complete-chat"');
    expect(html).toContain('title="Complete this chat"');
    expect(html).toContain('aria-label="Complete this chat"');
    expect(html).toContain('<span class="topbar-action-label">Complete this chat</span>');
    expect(html).not.toContain("disabled");
  });

  it("is not drawn for a worker's chat, a front desk or a room seat", () => {
    expect(draw({ key: "chat:orch-1", worker: true, frontDesk: false })).toBe("");
    expect(draw({ key: "chat:c1", worker: false, frontDesk: true })).toBe("");
    expect(draw({ key: "chat:c1#codex", worker: false, frontDesk: false })).toBe("");
  });

  it("is disabled, and says why, while the chat is already completing", () => {
    const html = draw(main, true);
    expect(html).toContain('disabled=""');
    expect(html).toContain('title="This chat is completing"');
  });

  it("is disabled while the page is not connected", () => {
    expect(draw(main, false, false)).toContain('disabled=""');
  });
});

describe("the question before a chat is completed", () => {
  const draw = (content = confirmContent(preview), loading = false) => renderToStaticMarkup(
    <CompleteChatConfirm content={content} loading={loading} onCancel={nothing} onConfirm={nothing} />,
  );

  it("says what will happen and shows the host's facts as label and value", () => {
    const html = draw();
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Complete this chat?");
    expect(html).toContain("marked done and its process stops. A new message reopens it.");
    for (const [label, value] of [
      ["Branch", "feature/complete-chat"], ["Folder", "Task worktree"], ["Uncommitted", "3 files"],
      ["Merged", "No, not in develop"], ["Mission", "Running · 2 workers running"],
    ]) {
      expect(html).toContain(`<dt>${label}</dt>`);
      expect(html).toContain(`>${value}</dd>`);
    }
  });

  it("keeps the wrap-up steps behind one disclosure that says how many there are", () => {
    const html = draw();
    expect(html).toContain("<summary>What the agent is asked · 5 steps</summary>");
    // Closed until asked for.
    expect(html).toContain('<details class="complete-ask-steps">');
    expect(html).not.toContain("<details open");
    for (const step of ["Work", "Clean up", "Memory", "Run", "Report"]) expect(html).toContain(`<strong>${step}</strong>`);
    expect(html).toContain("A worktree and its branch go only if merged.");
  });

  it("never shows the agent's instructions or an absolute path", () => {
    const html = draw();
    expect(html).not.toContain("/trees/");
    expect(html).not.toContain("abc1234");
    expect(html).not.toContain("vault_agent_memory_append");
  });

  it("says the wrap-up waits when a reply is running", () => {
    expect(draw(confirmContent(preview, { busy: true }))).toContain("A reply is running. The wrap-up waits behind it.");
    expect(draw()).not.toContain("waits behind it");
  });

  it("is a decision, not a warning and not a deletion", () => {
    const html = draw();
    expect(html).toContain('class="ask-btn is-primary"');
    expect(html).toContain(">Complete</button>");
    expect(html).toContain(">Cancel</button>");
    expect(html).not.toContain("is-danger");
    // The sheet reads the decision colour only.
    expect(sheet).toContain("var(--decide)");
    expect(sheet).not.toMatch(/var\(--(warn|danger|accent)\b/);
  });

  it("shows no facts, and still asks, when the host has none", () => {
    const html = draw(confirmContent({ ...preview, workspace: undefined, delivery: undefined, runs: [] }));
    expect(html).not.toContain("<dl");
    expect(html).toContain(">Complete</button>");
  });

  it("says it is checking while the preview is on its way, and cannot be confirmed until it is in", () => {
    const checking = draw(confirmContent(undefined), true);
    expect(checking).toContain("Checking the workspace…");
    expect(checking).toContain('class="ask-btn is-primary" type="button" disabled=""');
    // No preview at all (an older backend) is no facts, not no completion.
    const none = draw(confirmContent(undefined), false);
    expect(none).not.toContain("Checking the workspace…");
    expect(none).not.toContain('disabled=""');
  });

  it("shows the host's refusal and offers nothing to confirm", () => {
    const html = draw(confirmContent({ ...preview, refusal: "This chat is not in the active chat index." }));
    expect(html).toContain("This chat is not in the active chat index.");
    expect(html).not.toContain(">Complete</button>");
    expect(html).toContain(">Close</button>");
  });
});

describe("the line that says a chat is completing", () => {
  const queued = completionLine({ completing: { turnId: "octiq-complete-1", state: "queued" }, done: false, messages: [wrapUp()] });
  const done = completionLine({ ended: { ok: true, doneAt: 5 }, done: true, messages: [] });
  const failed = completionLine({ ended: { ok: false, reason: "failed" }, done: false, messages: [] });

  it("is not drawn for a chat nothing is completing", () => {
    expect(renderToStaticMarkup(<ChatCompletionLine line={null} />)).toBe("");
  });

  it("is one quiet status line with one moving mark while completing", () => {
    const html = renderToStaticMarkup(<ChatCompletionLine line={queued} onDismiss={nothing} />);
    expect(html).toContain('data-kind="completing"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Completing");
    expect(html).toContain("Waiting for the current reply");
    expect(html.match(/chat-completion-dot/g)).toHaveLength(1);
    // Nothing to press: the wrap-up is taken back from its own bubble.
    expect(html).not.toContain("<button");
  });

  it("says completed, and can be dismissed", () => {
    const html = renderToStaticMarkup(<ChatCompletionLine line={done} onDismiss={nothing} />);
    expect(html).toContain('data-kind="done"');
    expect(html).toContain("Completed");
    expect(html).toContain("A new message reopens it.");
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).not.toContain("chat-completion-dot");
    expect(html).not.toContain("Close mission");
  });

  it("offers Close mission only after completion, and only where the host says it can close", () => {
    const run = { runId: "run_1", status: "stopped", live: false, mission: true, workersRunning: 0, closeEligible: true };
    const offered = renderToStaticMarkup(<ChatCompletionLine line={done} offers={[{ run }]} onCloseMission={nothing} onDismiss={nothing} />);
    expect(offered).toContain(">Close mission</button>");
    // Not while the chat is still completing, and not on a completion that failed.
    expect(renderToStaticMarkup(<ChatCompletionLine line={queued} offers={[{ run }]} onCloseMission={nothing} />)).not.toContain("Close mission");
    expect(renderToStaticMarkup(<ChatCompletionLine line={failed} offers={[{ run }]} onCloseMission={nothing} />)).not.toContain("Close mission");
  });

  it("shows a close in flight, and the host's reason when it is refused", () => {
    const run = { runId: "run_1", status: "stopped", live: false, mission: true, workersRunning: 0, closeEligible: true };
    const closing = renderToStaticMarkup(<ChatCompletionLine line={done} offers={[{ run, closing: true }]} onCloseMission={nothing} />);
    expect(closing).toContain(">Closing…</button>");
    expect(closing).toContain('disabled=""');
    const refused = renderToStaticMarkup(<ChatCompletionLine line={done} offers={[{ run, error: "The mission's branch is not merged." }]} onCloseMission={nothing} />);
    expect(refused).toContain("The mission&#x27;s branch is not merged.");
  });

  it("gives the reason as a notice line, not a warning card", () => {
    const html = renderToStaticMarkup(<ChatCompletionLine line={failed} onDismiss={nothing} />);
    expect(html).toContain('data-kind="not-done"');
    expect(html).toContain("Not completed");
    expect(html).toContain("The wrap-up did not finish cleanly.");
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("ask-card");
  });
});

describe("the wrap-up's bubble", () => {
  const draw = (message: Message, busy = true) => renderToStaticMarkup(
    <MessageList messages={[message]} busy={busy}
      onStartQueued={nothing} onCancelQueued={nothing} onRestoreUnsent={nothing} onDismissUnsent={nothing} />,
  );

  it("reads as the wrap-up, with the host's text behind a disclosure that says how long it is", () => {
    const html = draw(wrapUp());
    expect(html).toContain('<span class="wrap-up-note-label">Wrap-up</span>');
    expect(html).toContain("Completing this chat after the current reply");
    expect(html).toContain("<summary>What the agent is asked · 3 lines</summary>");
    expect(html).not.toContain("<details open");
  });

  it("is an ordinary queued bubble: it can be sent now, and its take-back cancels the completion", () => {
    const html = draw(wrapUp());
    expect(html).toContain(">Queued</span>");
    expect(html).toContain(">Send now</button>");
    expect(html).toContain('title="Stop the current reply and wrap up now"');
    expect(html).toContain('aria-label="Cancel completing this chat"');
    expect(html).toContain(">Cancel</button>");
    // There are no typed words to return to the composer, and none to copy.
    expect(html).not.toContain(">Edit</button>");
    expect(html).not.toContain("Take this queued message back to edit");
    expect(html).not.toContain("Copy this message");
  });

  it("says cancelling, not returning to the composer, while the take-back is in flight", () => {
    const html = draw(wrapUp({ queueAction: "cancel" }));
    expect(html).toContain("Cancelling…");
    expect(html).not.toContain("Returning to composer");
  });

  it("offers no queue action once the agent has it", () => {
    const html = draw(wrapUp({ delivery: "dispatched", echo: "e1" }));
    expect(html).toContain("Completing this chat");
    expect(html).not.toContain("after the current reply");
    expect(html).not.toContain("Send this queued message now");
    expect(html).not.toContain("Cancel completing this chat");
  });

  it("never offers to restore a lost wrap-up's text to the composer", () => {
    const html = draw(wrapUp({ delivery: "unknown" }));
    expect(html).not.toContain("Restore to composer");
  });

  it("leaves a message the person typed exactly as it was", () => {
    const html = draw({ ...wrapUp(), id: "m1", turnId: "u-1", blocks: [{ kind: "text", text: "do the thing" }] });
    expect(html).toContain(">Edit</button>");
    expect(html).toContain("do the thing");
    expect(html).not.toContain("wrap-up-note");
  });

  it("is named on the conversation map, not quoted", () => {
    expect(conversationMapTurns([[wrapUp()]])[0].prompt).toBe("Wrap-up");
  });

  it("draws the note without a disclosure when there is no text to open", () => {
    const html = renderToStaticMarkup(<WrapUpNote label="Wrap-up" detail="Completing this chat" text="" />);
    expect(html).toContain("Wrap-up");
    expect(html).not.toContain("<details");
  });
});

describe("the chat's row while it completes", () => {
  const row = (completing: Set<string>) => renderToStaticMarkup(
    <Sidebar
      projects={[{ id: "p1", name: "octiq-flow" }]} shelved={[]}
      conversations={[{ id: "c1", projectId: "p1", title: "Upload retry", messages: [], createdAt: 1, updatedAt: 1 }]}
      currentConversation={null} running={new Set(["c1"])} busy={new Set(["c1"])} completing={completing}
      onPickConversation={nothing} onNewChat={nothing} onDelete={nothing}
      onPin={nothing} onToggleDone={nothing} onRename={nothing}
    />,
  );

  it("says completing to a screen reader and adds no second indicator to the row", () => {
    const html = row(new Set(["c1"]));
    expect(html).toContain("is-completing");
    expect(html).toContain(", working, completing");
    // The logo's ring is the row's one indicator; completing draws no other.
    expect(html.match(/chat-badge"/g)).toHaveLength(row(new Set()).match(/chat-badge"/g)!.length);
  });

  it("says nothing of it for a chat that is not completing", () => {
    const html = row(new Set());
    expect(html).not.toContain("is-completing");
    expect(html).not.toContain(", completing");
  });
});
