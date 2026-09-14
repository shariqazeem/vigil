import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE CEILING ON UNATTENDED WORK.
 *
 * The sweep hands every new incident straight to the agent with nobody present, which is the whole
 * reason Warden is an operator rather than a button. It is also, now that anyone can register a
 * service from a browser, a way to spend the fleet owner's model budget: point Warden at a URL that
 * is always down and it will investigate it every ten minutes forever.
 *
 * The bound is per owner per day. Past it the incident still opens and still waits on the board —
 * only the part that happens while nobody is looking stops.
 */
const env = vi.hoisted(() => {
  const dir = `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/warden-ceiling-${process.pid}-${Date.now()}`;
  process.env.WARDEN_DB_PATH = `${dir}/warden.db`;
  delete (globalThis as { __wardenDb?: unknown }).__wardenDb;
  return { dir };
});

import { rmSync } from "node:fs";
import { addService, autoRunsToday, logEvent } from "@/lib/db/warden";
import { OBSERVE_ONLY } from "@/lib/ops/policy";

afterAll(() => rmSync(env.dir, { recursive: true, force: true }));

let n = 0;
const owner = () => `anon:ceiling-${(n += 1)}`;

describe("counting what Warden has taken on by itself", () => {
  it("is zero for an owner with nothing registered", () => {
    expect(autoRunsToday(owner())).toBe(0);
  });

  it("counts a run on any of that owner's services, and none of anybody else's", () => {
    const me = owner();
    const you = owner();
    const a = addService({ ownerKey: me, name: "a", host: "local", policy: OBSERVE_ONLY });
    const b = addService({ ownerKey: me, name: "b", host: "local", policy: OBSERVE_ONLY });
    const theirs = addService({ ownerKey: you, name: "theirs", host: "local", policy: OBSERVE_ONLY });

    logEvent(a.id, "investigate", "run.start", "one");
    logEvent(b.id, "investigate", "run.start", "two");
    logEvent(theirs.id, "investigate", "run.start", "not mine");

    expect(autoRunsToday(me)).toBe(2);
    expect(autoRunsToday(you)).toBe(1);
  });

  it("counts runs, not incidents — a second attempt at the same one costs the same as the first", () => {
    const me = owner();
    const s = addService({ ownerKey: me, name: "s", host: "local", policy: OBSERVE_ONLY });
    logEvent(s.id, "investigate", "run.start", "attempt", "inc_same");
    logEvent(s.id, "investigate", "run.start", "attempt", "inc_same");
    expect(autoRunsToday(me)).toBe(2);
  });

  it("ignores everything that is not a run starting", () => {
    const me = owner();
    const s = addService({ ownerKey: me, name: "s", host: "local", policy: OBSERVE_ONLY });
    for (const kind of ["resolved", "halted", "policy.changed", "probe.added", "notified"]) logEvent(s.id, "system", kind, kind);
    expect(autoRunsToday(me)).toBe(0);
  });
});
