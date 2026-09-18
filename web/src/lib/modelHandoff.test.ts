import { describe, expect, it } from "vitest";

import type { Message } from "./chat";
import { modelHandoff, type ModelHandoffTurn } from "./modelHandoff";

function message(role: Message["role"], text: string): Message {
  return {
    id: `${role}:${text}`,
    role,
    blocks: [{ kind: "text", text }],
    streaming: false,
  };
}

describe("model handoff", () => {
  it("keeps role boundaries when another provider takes the next turn", () => {
    const handoff = modelHandoff([
      message("user", "Use the older Opus model."),
      message("assistant", "Understood."),
    ]);

    expect(JSON.parse(handoff!) as ModelHandoffTurn[]).toEqual([
      { role: "user", text: "Use the older Opus model." },
      { role: "assistant", text: "Understood." },
    ]);
  });

  it("leaves tool internals and subagent streams out of provider context", () => {
    const top = message("assistant", "The user-visible answer.");
    top.blocks.push({ kind: "thinking", text: "private reasoning" });
    const subagent = { ...message("assistant", "worker details"), parent: "tool-1" };

    expect(modelHandoff([top, subagent])).toBe(
      JSON.stringify([{ role: "assistant", text: "The user-visible answer." }]),
    );
  });
});
