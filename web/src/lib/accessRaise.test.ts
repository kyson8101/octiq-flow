// Review of b894867 (P3), H8, on the page. The host refuses a raise of a
// chat's access level that it cannot record. The page used to undo that
// refusal: the picker ended the agent and stayed on the raised level, and a
// card with an agent waiting on it told the agent "failed" and went away.
import { describe, expect, it } from "vitest";
// Loaded through Vite's `?raw`, not node:fs: this is a browser tsconfig.
import host from "../../../src-tauri/src/agent_chat.rs?raw";
import { NOT_RAISED, cardAfterRefusal, pickerAfterRefusal, raiseNotRecorded } from "./accessRaise";

const AWAY =
  "The profile folder /Volumes/drive/profiles/default is not available right now: its drive is not connected, or the folder was moved or removed.";
const refused = NOT_RAISED + AWAY;

describe("a raise the host could not record", () => {
  it("is known by the host's own words, which the page and the host share", () => {
    expect(host).toContain(`const NOT_RAISED: &str = ${JSON.stringify(NOT_RAISED)};`);
    expect(raiseNotRecorded(refused)).toBe(true);
    expect(raiseNotRecorded("Full access needs a fresh agent")).toBe(false);
    expect(raiseNotRecorded(AWAY)).toBe(false);
  });

  it("puts the picker back and leaves the agent running", () => {
    expect(pickerAfterRefusal(refused)).toBe("put-back");
  });

  it("still restarts for a level that needs a fresh agent, and for anything else that fails", () => {
    expect(pickerAfterRefusal("Full access needs a fresh agent")).toBe("restart");
    expect(pickerAfterRefusal("'chat_set_access' is not available on this backend")).toBe("restart");
  });

  it("does nothing when the process ended in between", () => {
    expect(pickerAfterRefusal("no such chat")).toBe("nothing");
  });

  it("keeps the card that asked open, whether or not an agent waits on it", () => {
    expect(cardAfterRefusal(refused, true)).toBe("keep");
    expect(cardAfterRefusal(refused, false)).toBe("keep");
  });

  it("tells a waiting agent of any other failure, as before", () => {
    expect(cardAfterRefusal("this chat does not take more input", true)).toBe("tell-agent");
    expect(cardAfterRefusal("this chat does not take more input", false)).toBe("keep");
  });
});
