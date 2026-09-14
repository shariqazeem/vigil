import { describe, expect, it } from "vitest";
import { firstSentence } from "@/agent/warden";

/**
 * THE ONE LINE THAT CLOSES AN INCIDENT.
 *
 * It is built from the diagnosis, and it used to be built with `.slice(0, 200)` — which cut a real
 * incident's closing line to "...lastStartedAt: 2026 — fixed and verified.", reading as though the
 * software was broken rather than the service had been. The last sentence on the page is the one a
 * person remembers.
 */
describe("shortening a diagnosis to close an incident", () => {
  it("stops at the first full stop", () => {
    expect(firstSentence("vigil is down because the process is stopped. pm2_list reports more detail.", 220)).toBe(
      "vigil is down because the process is stopped.",
    );
  });

  it("keeps a short diagnosis whole, and gives it a full stop if it had none", () => {
    expect(firstSentence("the process is stopped", 220)).toBe("the process is stopped.");
  });

  it("never cuts in the middle of a word", () => {
    const long = `vigil is down because pm2 shows the process in status stopped with lastStartedAt 2026-09-14T09:28:12 and a restart count of fourteen which is cumulative since it was added rather than evidence of a crash loop`;
    const out = firstSentence(long, 120);
    expect(out.length).toBeLessThanOrEqual(122);
    expect(out.endsWith("…")).toBe(true);
    // the give-away of the old bug: a truncation that lands inside a token
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
    expect(out.slice(0, -1).endsWith(" ")).toBe(false);
  });

  it("ignores everything after the first line", () => {
    expect(firstSentence("the process is stopped\nand here is a second paragraph nobody asked for", 220)).toBe("the process is stopped.");
  });

  it("does not treat a decimal or a version as the end of a sentence", () => {
    // "0.5" and "v1.2" are not sentence endings; the regex wants a space or the end of the string.
    expect(firstSentence("confidence was 0.55 and the cause is clear. More follows.", 220)).toBe("confidence was 0.55 and the cause is clear.");
  });
});
