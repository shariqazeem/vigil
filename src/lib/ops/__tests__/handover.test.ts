import { describe, expect, it } from "vitest";
import { handoverVerdict } from "../handover";

/**
 * A URL is enough for the operator to work, not just watch. Every new incident is handed to the
 * agent; the one thing that stops it is the daily ceiling per owner.
 */
const URL_ONLY = { host: "local", repo: null, process: null, hookUrl: null };
const HOOKED = { ...URL_ONLY, hookUrl: "https://api.render.com/deploy/srv?key=x" };
const MACHINE = { host: "local", repo: "/srv/app", process: "app", hookUrl: null };

describe("handoverVerdict", () => {
  it("hands a URL-only service over, saying it will diagnose and hand back", () => {
    const v = handoverVerdict(URL_ONLY, 0, 100);
    expect(v.hand).toBe(true);
    expect(v.note).toContain("network only and no hook");
  });

  it("hands a hooked service over, noting the one act it has", () => {
    const v = handoverVerdict(HOOKED, 0, 100);
    expect(v.hand).toBe(true);
    expect(v.note).toContain("deploy hook");
  });

  it("hands a service with a machine over with nothing to remark on", () => {
    expect(handoverVerdict(MACHINE, 0, 100)).toEqual({ hand: true, note: null });
  });

  it("stops at the daily ceiling, whatever the service is", () => {
    for (const s of [URL_ONLY, HOOKED, MACHINE]) {
      const v = handoverVerdict(s, 100, 100);
      expect(v.hand).toBe(false);
      if (!v.hand) expect(v.rule).toBe("auto.capped");
    }
    expect(handoverVerdict(MACHINE, 99, 100).hand).toBe(true);
  });

  it("never mentions the hook URL itself", () => {
    expect(JSON.stringify(handoverVerdict(HOOKED, 0, 100))).not.toContain("key=x");
  });
});
