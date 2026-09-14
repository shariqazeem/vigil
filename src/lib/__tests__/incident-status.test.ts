import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { statusChip } from "@/lib/incident-status";

/**
 * TWO LISTS THAT MUST AGREE.
 *
 * One list is the set of statuses the agent writes onto an incident. The other is the set the
 * console knows how to say out loud. They were kept apart by hand, and they drifted: `waiting` was
 * written as `escalated` for weeks, so a run that had stopped to ask the owner a question and a run
 * that had given up looked identical on the board.
 *
 * This test reads BOTH lists from their real sources — the first by scanning the code that writes
 * it — so adding a status without giving it words fails here rather than in front of someone.
 */
const SOURCES = ["src/agent/warden.ts", "src/agent/tools.ts", "src/lib/ops/sweep.ts", "src/lib/db/schema.ts"];

function statusesWrittenByTheCode(): string[] {
  const found = new Set<string>();
  for (const file of SOURCES) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/status:\s*"([a-z_]+)"/g)) found.add(m[1]!);
    // the column default, which is what a freshly opened incident gets
    for (const m of src.matchAll(/text\("status"\)[^\n]*default\("([a-z_]+)"\)/g)) found.add(m[1]!);
  }
  return [...found].sort();
}

describe("every status the code can write has words for it", () => {
  const written = statusesWrittenByTheCode();

  it("found the statuses in the source rather than trusting a hand-written list", () => {
    // If this ever goes empty the regex has rotted and the test below would pass vacuously.
    expect(written.length).toBeGreaterThanOrEqual(5);
    expect(written).toContain("waiting");
    expect(written).toContain("escalated");
    expect(written).toContain("resolved");
  });

  it.each(statusesWrittenByTheCode())("says %s in words a person would use", (status) => {
    const chip = statusChip(status);
    // The fallback returns the raw status as its own label. That is the drift this test exists for.
    expect(chip.label, `"${status}" has no words — add it to statusChip`).not.toBe(status);
    expect(chip.label).toMatch(/^[a-z]/);
    // A chip is read at a glance from a card: one or two words, and never the product's own jargon.
    expect(chip.label.split(" ").length).toBeLessThanOrEqual(2);
    expect(chip.label).not.toMatch(/policy|probe|sweep|incident|operation|halt|escalat/);
  });

  it("says the outcomes in the words the console promises", () => {
    expect(statusChip("resolved").label).toBe("fixed");
    expect(statusChip("waiting").label).toBe("needs you");
    expect(statusChip("escalated").label).toBe("handed back");
  });

  it("does not give the two unfinished outcomes the same words", () => {
    expect(statusChip("waiting").label).not.toBe(statusChip("escalated").label);
    expect(statusChip("waiting").tone).toBe("warn");
  });
});
