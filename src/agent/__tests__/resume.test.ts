import { describe, expect, it } from "vitest";
import { interruptToAnswer } from "@/agent/warden";

/**
 * PICKING A HALTED RUN BACK UP.
 *
 * "It stops and asks, and the run can be picked up hours later from a different process" is one of
 * the two things this product claims. It was not true: the Strands interrupt id was held only in
 * the memory of the process that raised it — the sweep's, which exits — so every answer that
 * arrived from the web app later resumed with a plain prompt instead, and the SDK threw
 * "Agent is in an interrupted state". This ran on the live fleet and failed exactly that way.
 *
 * The fix is a precedence, and this is it: whatever the restored session says it is still holding
 * beats whatever was written down earlier, and the in-memory note is a last resort.
 */
describe("which interrupt an answer is for", () => {
  it("believes the restored session over a row written by an older run", () => {
    expect(interruptToAnswer({ restoredFromSession: "int_live", onDecision: "int_stale", inMemory: "int_older" })).toBe("int_live");
  });

  it("falls back to the decision row when the session is gone", () => {
    expect(interruptToAnswer({ restoredFromSession: undefined, onDecision: "int_filed" })).toBe("int_filed");
  });

  it("uses the in-memory note only when nothing was persisted — the same-process case", () => {
    expect(interruptToAnswer({ inMemory: "int_mem" })).toBe("int_mem");
  });

  it("returns null when there is nothing to resume, so the caller prompts instead of throwing", () => {
    expect(interruptToAnswer({})).toBeNull();
    expect(interruptToAnswer({ onDecision: null, restoredFromSession: null, inMemory: null })).toBeNull();
  });

  it("treats an empty id as absent and keeps looking", () => {
    // A column that was set and then cleared reads back as "" out of SQLite. Resuming with "" is
    // not a resume, it is the same throw one step later — so it must fall through, not win.
    expect(interruptToAnswer({ onDecision: "", restoredFromSession: "", inMemory: "int_mem" })).toBe("int_mem");
    expect(interruptToAnswer({ onDecision: "", restoredFromSession: "" })).toBeNull();
  });
});
