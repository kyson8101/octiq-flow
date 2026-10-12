import { describe, expect, it, vi } from "vitest";
import { PartialQuestionSubmission, submitQuestionAnswers } from "./submitQuestionAnswers";

const answers = [{ id: "q1", answer: "SQLite" }, { id: "q2", answer: "Asia" }];

describe("question submission receipts", () => {
  it("submits the complete card in one atomic request", async () => {
    const invoke = vi.fn().mockResolvedValue({ saved: true });
    await submitQuestionAnswers(invoke, answers);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("question_answer_batch", { answers });
  });

  it.each([false, undefined, null, {}, { saved: false }])("rejects an unconfirmed receipt: %j", async (receipt) => {
    await expect(submitQuestionAnswers(vi.fn().mockResolvedValue(receipt), answers)).rejects.toThrow("did not confirm");
  });

  // Review of b894867 (P3), H9. With the profile folder away the host hands
  // the answers to the agent and cannot write them down. It used to answer
  // `{ saved: true, recorded: false }` so that this function would not throw,
  // and the card said "Answers saved". It says what happened now, and so
  // does the receipt the card is given.
  it("takes a delivered and unsaved receipt as that, never as saved", async () => {
    const why = "The profile folder /Volumes/drive/profiles/default is not available right now.";
    const invoke = vi.fn().mockResolvedValue({ saved: false, delivered: true, unsaved: why });
    await expect(submitQuestionAnswers(invoke, answers)).resolves.toEqual({ unsaved: why });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("does not take the old half-true receipt as saved", async () => {
    const invoke = vi.fn().mockResolvedValue({ saved: true, recorded: false });
    await expect(submitQuestionAnswers(invoke, answers)).resolves.not.toBe("saved");
  });

  it("surfaces disconnection and storage errors instead of closing the card", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("Disconnected"));
    await expect(submitQuestionAnswers(invoke, answers)).rejects.toThrow("Disconnected");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("keeps working while a newer client is connected to the old backend", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error("question_answer_batch is not available on this backend")).mockResolvedValue(true);
    await expect(submitQuestionAnswers(invoke, answers)).resolves.toBe("delivered");
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("never closes the unaccepted half of a legacy submission", async () => {
    const invoke = vi.fn().mockRejectedValueOnce(new Error("question_answer_batch is not available on this backend"))
      .mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    try {
      await submitQuestionAnswers(invoke, answers);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(PartialQuestionSubmission);
      expect((error as PartialQuestionSubmission).deliveredIds).toEqual(["q1"]);
    }
  });
});
