// Card 81 — how big a conversation is, said in the width a rule has for it.
import { describe, expect, it } from "vitest";

import { roughTokens } from "./tokens";

describe("the size of a conversation", () => {
  it("is said in whole thousands", () => {
    // The difference between 168k and 21k is the whole point of the line. The
    // digits under it are not, and each one costs width the row has not got.
    expect(roughTokens(168_345)).toBe("168k");
    expect(roughTokens(21_400)).toBe("21k");
  });

  it("keeps a small number exactly", () => {
    expect(roughTokens(940)).toBe("940");
    expect(roughTokens(0)).toBe("0");
  });

  it("says a million as a million", () => {
    // `1100k` is both wider and harder to read than `1.1M`, on the one row in
    // the app that ran out of width. A million-token context is ordinary now.
    expect(roughTokens(1_100_000)).toBe("1.1M");
    expect(roughTokens(1_000_000)).toBe("1.0M");
    expect(roughTokens(2_450_000)).toBe("2.5M");
  });

  it("does not round a large-but-not-million count up into one", () => {
    // 999_600 rounds to 1000k, which reads as a million without being one.
    expect(roughTokens(999_600)).toBe("1.0M");
    expect(roughTokens(950_000)).toBe("950k");
  });
});
