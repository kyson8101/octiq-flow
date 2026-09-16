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
