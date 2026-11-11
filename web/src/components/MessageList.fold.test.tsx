import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("./Thumb", () => ({ SentFiles: () => null }));
vi.mock("../lib/bridge", () => ({ bridge: { invoke: async () => [] } }));
vi.mock("../lib/pathStore", () => ({
  knownPath: () => undefined, askPaths: () => {}, subscribePaths: () => () => {},
}));
// Open the real cards so assertions see attached notes as well as their heads.
vi.mock("./ToolCard", async (importOriginal) => {
  const { ToolCard } = await importOriginal<typeof import("./ToolCard")>();
  return { ToolCard: (props: Parameters<typeof ToolCard>[0]) => <ToolCard {...props} open /> };
});

import type { Block, Message } from "../lib/chat";
import { ChatQuestionsContext } from "./InlineQuestions";
import { MessageList } from "./MessageList";

const tool = (id: string, name = "Bash"): Extract<Block, { kind: "tool" }> => ({
  kind: "tool", id, name, args: { command: "pnpm test", skill: "review" }, argsJson: "", state: "done",
});
const text = (text: string): Block => ({ kind: "text", text });
const diagram = '```octiq-diagram\n{"rows":[[{"title":"FINAL DIAGRAM"}]]}\n```';
const media = '```octiq-media\n{"path":"/tmp/photo.png","text":"FINAL MEDIA EXPLANATION"}\n```';
const render = (blocks: Block[], live: boolean, pending = false) => {
  const message: Message = {
    id: "reply", role: "assistant", streaming: false, blocks,
    ...(!live ? { turnEnd: { status: "completed" as const } } : {}),
  };
  return renderToStaticMarkup(
    <ChatQuestionsContext.Provider value={{ questions: pending ? [{ id: "q", chatKey: "chat:c", question: "QUESTION", options: ["A", "B"] }] : [], onDone: () => {} }}>
      <MessageList messages={[message]} busy={live} conversationId="c" />
    </ChatQuestionsContext.Provider>,
  );
};
const work = [text("INTERIM WORK"), tool("one"), tool("two")];

for (const live of [true, false]) {
  describe(live ? "live original grouping" : "settled work fold grouping", () => {
    it.each([["diagram", diagram], ["media", media]])("keeps a pure final %s independent of a retained Skill", (_, final) => {
      const html = render([tool("skill", "Skill"), ...work, text(final)], live);
      expect(html).toContain("review");
      expect(html).not.toContain("tool-note-body");
      if (final === diagram) {
        expect(html.match(/class="dgm"/g)).toHaveLength(1);
        expect(html).toContain("FINAL DIAGRAM");
      } else {
        expect(html).toContain("FINAL MEDIA EXPLANATION");
        expect(html).toContain("media-beside");
      }
      expect(html.includes("INTERIM WORK")).toBe(live);
      expect(html.includes("turn-work-head")).toBe(!live);
    });

    it.each(["pending", "answered"])("keeps a pure final diagram after an %s ask_user", (state) => {
      const ask = { ...tool("ask", "mcp__octiq__ask_user"),
        args: { question: "QUESTION", options: ["A", "B"] },
        state: state === "pending" ? "running" as const : "done" as const,
        ...(state === "answered" ? { result: JSON.stringify({ answers: [{ question: "QUESTION", answer: "A" }] }) } : {}),
      };
      const html = render([ask, ...work, text(diagram)], live, state === "pending");
      expect(html).toContain("QUESTION");
      expect(html.match(/class="dgm"/g)).toHaveLength(1);
      expect(html).toContain("FINAL DIAGRAM");
      expect(html).not.toContain("tool-note-body");
      expect(html.includes("INTERIM WORK")).toBe(live);
      if (state === "pending") expect(html).toContain('role="radiogroup"');
      else expect(html).toContain("qa-said");
    });

    it.each([diagram, media, '```json\n{"answer":42}\n```'])("preserves attachment when the original tool really was adjacent: %s", (fence) => {
      const html = render([tool("earlier"), text("INTERIM WORK"), tool("skill", "Skill"), text(fence)], live);
      expect(html).toContain("tool-note-body");
      expect(html).not.toContain('class="dgm"');
      expect(html).not.toContain("media-beside");
    });

    it("keeps the original single-command row when the final is its attached note", () => {
      const html = render([tool("earlier"), text("INTERIM WORK"), tool("last"), text('```json\n{"answer":42}\n```')], live);
      // ToolGroup itself is closed: its retained header proves the attached
      // final did not disappear with the command selected by the work fold.
      expect(html.match(/title="Show all 1 calls"/g)).toHaveLength(live ? 2 : 1);
      expect(html).not.toContain("&quot;answer&quot;:42");
    });

    it("keeps an originally attached interim note with its retained card", () => {
      const html = render([tool("skill", "Skill"), text('```json\n{"evidence":true}\n```'), ...work, text(diagram)], live);
      expect(html).toContain("tool-note-body");
      expect(html).toContain("&quot;evidence&quot;:true");
      expect(html.match(/class="dgm"/g)).toHaveLength(1);
    });
  });
}
