import { describe, expect, it } from "vitest";
import { OPERATION_NAMES } from "@/lib/ops/operations";
import { ALL_WORDS, OP_WORD_NAMES, opWord, riskWord, verdictWord } from "@/lib/words";

const JARGON = /policy|probe|sweep|incident|operation|_/i;

describe("the vocabulary", () => {
  it("has a plain sentence for every operation in the catalogue", () => {
    for (const name of OPERATION_NAMES) {
      expect(OP_WORD_NAMES, `no word for ${name}`).toContain(name);
      expect(opWord(name)).not.toBe(name);
    }
  });

  it("names nothing that is not in the catalogue", () => {
    for (const name of OP_WORD_NAMES) expect(OPERATION_NAMES as string[]).toContain(name);
  });

  it("uses no jargon and no underscores", () => {
    for (const w of ALL_WORDS) expect(w, w).not.toMatch(JARGON);
  });

  it("falls back honestly", () => {
    expect(opWord("some_new_thing")).toBe("some new thing");
    expect(riskWord("read")).toBe("looks only");
    expect(verdictWord("allow")).toBe("did it");
  });
});
