import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE LEDGER. Every claim Warden makes in public is read back out of these tables, so the tests are
 * about the arithmetic behind the claims rather than about SQL:
 *
 *   "it has been acting three times on this incident"  → changesMade, which counts acts, not looks
 *   "it was down for ninety seconds"                   → resolveIncident, measured to the READING
 *                                                        that proved it back, not to the fix
 *   "the check has failed twice in a row"              → consecutiveFailures, the run at the head
 *
 * A temp database, built by the real migrations, so nothing here is mocked.
 */

const env = vi.hoisted(() => {
  const dir = `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/warden-ledger-${process.pid}-${Date.now()}`;
  process.env.WARDEN_DB_PATH = `${dir}/warden.db`;
  delete (globalThis as { __wardenDb?: unknown }).__wardenDb;
  return { dir };
});

import { rmSync } from "node:fs";
import {
  addProbe,
  addService,
  changesMade,
  consecutiveFailures,
  findDecisionFor,
  getIncident,
  listActions,
  minutesSinceLastChange,
  openDecision,
  openIncident,
  recordAction,
  recordReading,
  resolveIncident,
} from "../warden";
import type { Probe, Service } from "../schema";
import { DEFAULT_POLICY } from "@/lib/ops/policy";

const T0 = Date.UTC(2026, 8, 14, 3, 0, 0);
const minutes = (n: number) => n * 60_000;

let service: Service;
let probe: Probe;

const newIncident = () => openIncident({ serviceId: service.id, probeId: probe.id, title: "demo: the site is failing", symptom: "expected 200, got 502" });

const action = (over: Partial<Parameters<typeof recordAction>[0]> & { incidentId: string }) =>
  recordAction({
    serviceId: service.id,
    op: "pm2_list",
    risk: "read",
    input: {},
    verdict: "allow",
    rule: "policy-may",
    reason: "your policy grants it",
    ...over,
  });

beforeAll(() => {
  service = addService({ ownerKey: "owner_test", name: "demo", host: "local", repo: "/srv/demo", process: "demo", policy: DEFAULT_POLICY });
  probe = addProbe({ serviceId: service.id, kind: "http", label: "the site answers", spec: { url: "http://127.0.0.1:39999/" } });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  rmSync(env.dir, { recursive: true, force: true });
});

/* ── the audit trail ───────────────────────────────────────────────── */

describe("recordAction", () => {
  it("writes the verdict and the rule that decided it, with the command and what came back", () => {
    const incident = newIncident();
    const row = action({
      incidentId: incident.id,
      op: "pm2_restart",
      risk: "reversible",
      input: { process: "demo" },
      intent: "the process is errored, so start it again",
      verdict: "allow",
      rule: "policy-may",
      reason: "Your policy grants pm2_restart on this service.",
      command: "restart demo",
      ok: true,
      output: "[PM2] restarted",
      exitCode: 0,
      ms: 412,
    });

    const [stored] = listActions(incident.id);
    expect(stored.id).toBe(row.id);
    expect(stored).toMatchObject({
      op: "pm2_restart",
      risk: "reversible",
      verdict: "allow",
      rule: "policy-may",
      command: "restart demo",
      ok: true,
      exitCode: 0,
      ms: 412,
    });
    expect(stored.reason).toContain("grants pm2_restart");
    expect(JSON.parse(stored.input)).toEqual({ process: "demo" });
    expect(stored.at).toBe(T0);
  });

  it("writes a refusal with no command, because nothing ran", () => {
    const incident = newIncident();
    action({ incidentId: incident.id, op: "db_migrate", risk: "forbidden", verdict: "refuse", rule: "forbidden-always", reason: "no policy can turn it on" });
    const [stored] = listActions(incident.id);
    expect(stored).toMatchObject({ verdict: "refuse", rule: "forbidden-always", command: null, ok: null, output: null, exitCode: null });
  });

  it("returns the actions of one incident, oldest first", () => {
    const incident = newIncident();
    action({ incidentId: incident.id, op: "pm2_list" });
    vi.setSystemTime(T0 + minutes(1));
    action({ incidentId: incident.id, op: "pm2_logs" });
    vi.setSystemTime(T0 + minutes(2));
    action({ incidentId: incident.id, op: "git_log" });
    action({ incidentId: newIncident().id, op: "disk_free" });
    expect(listActions(incident.id).map((a) => a.op)).toEqual(["pm2_list", "pm2_logs", "git_log"]);
  });
});

/* ── what counts as a change ───────────────────────────────────────── */

describe("changesMade — the number the policy's cap reads", () => {
  it("counts only the acts that were allowed AND changed something", () => {
    const incident = newIncident();
    action({ incidentId: incident.id, op: "pm2_list", risk: "read", verdict: "allow" });
    action({ incidentId: incident.id, op: "pm2_logs", risk: "read", verdict: "allow" });
    action({ incidentId: incident.id, op: "pm2_restart", risk: "reversible", verdict: "refuse", rule: "policy-never" });
    action({ incidentId: incident.id, op: "redeploy_previous", risk: "disruptive", verdict: "ask", rule: "policy-ask" });
    expect(changesMade(incident.id)).toBe(0);

    action({ incidentId: incident.id, op: "pm2_restart", risk: "reversible", verdict: "allow" });
    expect(changesMade(incident.id)).toBe(1);
    action({ incidentId: incident.id, op: "redeploy_previous", risk: "disruptive", verdict: "allow" });
    expect(changesMade(incident.id)).toBe(2);
  });

  it("is scoped to one incident", () => {
    const a = newIncident();
    const b = newIncident();
    action({ incidentId: a.id, op: "pm2_restart", risk: "reversible", verdict: "allow" });
    expect(changesMade(a.id)).toBe(1);
    expect(changesMade(b.id)).toBe(0);
  });

  it("is zero for an incident nothing has happened on", () => {
    expect(changesMade(newIncident().id)).toBe(0);
  });
});

/* ── how long since Warden last touched this service ───────────────── */

describe("minutesSinceLastChange — what the cooldown reads", () => {
  it("is null until Warden has actually changed something", () => {
    const fresh = addService({ ownerKey: "owner_test", name: "fresh", host: "local", policy: DEFAULT_POLICY });
    expect(minutesSinceLastChange(fresh.id)).toBeNull();

    const incident = openIncident({ serviceId: fresh.id, probeId: probe.id, title: "t", symptom: "s" });
    recordAction({ incidentId: incident.id, serviceId: fresh.id, op: "pm2_list", risk: "read", input: {}, verdict: "allow", rule: "policy-may", reason: "r" });
    recordAction({ incidentId: incident.id, serviceId: fresh.id, op: "pm2_logs", risk: "read", input: {}, verdict: "allow", rule: "policy-may", reason: "r" });
    expect(minutesSinceLastChange(fresh.id), "looking at something is not touching it").toBeNull();
  });

  it("ignores an act that was refused or turned into a question", () => {
    const s = addService({ ownerKey: "owner_test", name: "asked-only", host: "local", policy: DEFAULT_POLICY });
    const incident = openIncident({ serviceId: s.id, probeId: probe.id, title: "t", symptom: "s" });
    recordAction({ incidentId: incident.id, serviceId: s.id, op: "pm2_restart", risk: "reversible", input: {}, verdict: "refuse", rule: "policy-never", reason: "r" });
    recordAction({ incidentId: incident.id, serviceId: s.id, op: "redeploy_previous", risk: "disruptive", input: {}, verdict: "ask", rule: "policy-ask", reason: "r" });
    expect(minutesSinceLastChange(s.id)).toBeNull();
  });

  it("measures from the newest change, in whole minutes", () => {
    const s = addService({ ownerKey: "owner_test", name: "restarted", host: "local", policy: DEFAULT_POLICY });
    const incident = openIncident({ serviceId: s.id, probeId: probe.id, title: "t", symptom: "s" });

    vi.setSystemTime(T0);
    recordAction({ incidentId: incident.id, serviceId: s.id, op: "pm2_restart", risk: "reversible", input: {}, verdict: "allow", rule: "policy-may", reason: "r" });

    vi.setSystemTime(T0 + minutes(30));
    expect(minutesSinceLastChange(s.id)).toBe(30);

    // A read taken since then does not reset it.
    recordAction({ incidentId: incident.id, serviceId: s.id, op: "pm2_list", risk: "read", input: {}, verdict: "allow", rule: "policy-may", reason: "r" });
    vi.setSystemTime(T0 + minutes(31));
    expect(minutesSinceLastChange(s.id)).toBe(31);

    // A second restart does.
    recordAction({ incidentId: incident.id, serviceId: s.id, op: "pm2_start", risk: "reversible", input: {}, verdict: "allow", rule: "policy-may", reason: "r" });
    vi.setSystemTime(T0 + minutes(33));
    expect(minutesSinceLastChange(s.id)).toBe(2);
  });

  it("rounds down, so a cooldown is never cut short by a rounding", () => {
    const s = addService({ ownerKey: "owner_test", name: "rounding", host: "local", policy: DEFAULT_POLICY });
    const incident = openIncident({ serviceId: s.id, probeId: probe.id, title: "t", symptom: "s" });
    vi.setSystemTime(T0);
    recordAction({ incidentId: incident.id, serviceId: s.id, op: "pm2_restart", risk: "reversible", input: {}, verdict: "allow", rule: "policy-may", reason: "r" });
    vi.setSystemTime(T0 + minutes(9) + 59_000);
    expect(minutesSinceLastChange(s.id)).toBe(9);
  });

  it("is per service, not global", () => {
    const a = addService({ ownerKey: "owner_test", name: "a", host: "local", policy: DEFAULT_POLICY });
    const b = addService({ ownerKey: "owner_test", name: "b", host: "local", policy: DEFAULT_POLICY });
    const incident = openIncident({ serviceId: a.id, probeId: probe.id, title: "t", symptom: "s" });
    recordAction({ incidentId: incident.id, serviceId: a.id, op: "pm2_restart", risk: "reversible", input: {}, verdict: "allow", rule: "policy-may", reason: "r" });
    expect(minutesSinceLastChange(a.id)).toBe(0);
    expect(minutesSinceLastChange(b.id)).toBeNull();
  });
});

/* ── only a reading closes an incident ─────────────────────────────── */

describe("resolveIncident — the clock stops at the reading, not at the fix", () => {
  it("takes downSeconds and resolvedAt from the verifying reading, and stores which reading it was", () => {
    vi.setSystemTime(T0);
    const incident = newIncident();

    vi.setSystemTime(T0 + 90_000);
    const reading = recordReading({ probeId: probe.id, serviceId: service.id, ok: true, detail: "200 in 41ms", latencyMs: 41, incidentId: incident.id });

    // Time passes between the reading and the bookkeeping. The claim is about the reading.
    vi.setSystemTime(T0 + minutes(45));
    resolveIncident(incident.id, reading, "The probe that failed came back clean.");

    const after = getIncident(incident.id);
    expect(after).toMatchObject({
      status: "resolved",
      resolution: "The probe that failed came back clean.",
      verifiedByReadingId: reading.id,
      resolvedAt: T0 + 90_000,
      downSeconds: 90,
    });
  });

  it("rounds downSeconds to the nearest second", () => {
    vi.setSystemTime(T0);
    const incident = newIncident();
    vi.setSystemTime(T0 + 2_600);
    const reading = recordReading({ probeId: probe.id, serviceId: service.id, ok: true, detail: "ok", latencyMs: 1, incidentId: incident.id });
    resolveIncident(incident.id, reading, "back");
    expect(getIncident(incident.id)?.downSeconds).toBe(3);
  });

  it("never reports a negative outage, however the clocks disagree", () => {
    vi.setSystemTime(T0);
    const incident = newIncident();
    vi.setSystemTime(T0 - minutes(5));
    const reading = recordReading({ probeId: probe.id, serviceId: service.id, ok: true, detail: "ok", latencyMs: 1, incidentId: incident.id });
    resolveIncident(incident.id, reading, "back");
    expect(getIncident(incident.id)?.downSeconds).toBe(0);
  });

  it("does nothing, quietly, for an incident that is not there", () => {
    const reading = recordReading({ probeId: probe.id, serviceId: service.id, ok: true, detail: "ok", latencyMs: 1 });
    expect(() => resolveIncident("inc_does_not_exist", reading, "back")).not.toThrow();
  });
});

/* ── one blip is not an outage ─────────────────────────────────────── */

describe("consecutiveFailures — the unbroken run at the head", () => {
  /** Write a probe's history oldest-first, a minute apart, and return its id. */
  function history(...oks: boolean[]): string {
    const p = addProbe({ serviceId: service.id, kind: "http", label: "history", spec: {} });
    oks.forEach((ok, i) => {
      vi.setSystemTime(T0 + minutes(i));
      recordReading({ probeId: p.id, serviceId: service.id, ok, detail: ok ? "200" : "502", latencyMs: 1 });
    });
    return p.id;
  }

  it("is zero for a probe that has never been asked", () => {
    expect(consecutiveFailures(addProbe({ serviceId: service.id, kind: "http", label: "unasked", spec: {} }).id)).toBe(0);
  });

  it("is zero the moment the newest reading is clean", () => {
    expect(consecutiveFailures(history(false, false, false, true))).toBe(0);
  });

  it("counts only the run at the head, not every failure in the history", () => {
    expect(consecutiveFailures(history(false, false, true, false, false, false))).toBe(3);
  });

  it("counts a run that goes all the way back", () => {
    expect(consecutiveFailures(history(false, false))).toBe(2);
  });

  it("is the number an incident opens on: one blip is 1, two in a row is 2", () => {
    expect(consecutiveFailures(history(true, true, false))).toBe(1);
    expect(consecutiveFailures(history(true, true, false, false))).toBe(2);
  });

  it("is per probe — a service's other check failing does not count", () => {
    const quiet = history(true, true);
    history(false, false, false);
    expect(consecutiveFailures(quiet)).toBe(0);
  });
});

/* ── never asking the same question twice ──────────────────────────── */

describe("findDecisionFor — matching a question to the operation it is about", () => {
  const ask = (incidentId: string, proposal: string | null) =>
    openDecision({
      serviceId: service.id,
      incidentId,
      kind: "approve_action",
      question: "Approve?",
      proposal,
      options: [{ value: "approve", label: "Approve" }],
    });

  it("finds the open question about this operation", () => {
    const incident = newIncident();
    const d = ask(incident.id, `redeploy_previous\n{"process":"demo"}\n\nrolling back the deploy that broke it`);
    expect(findDecisionFor(incident.id, "redeploy_previous")?.id).toBe(d.id);
  });

  it("returns null when nothing has been asked about it", () => {
    const incident = newIncident();
    ask(incident.id, `redeploy_previous\n{}\n\nwhy`);
    expect(findDecisionFor(incident.id, "pm2_restart")).toBeNull();
  });

  it("matches on the whole operation name — a shorter name is not a prefix of a longer one", () => {
    const incident = newIncident();
    ask(incident.id, `pm2_restart\n{"process":"demo"}\n\nwhy`);
    // The newline in the proposal is what stops "pm2_start" or "pm2_res" matching "pm2_restart".
    expect(findDecisionFor(incident.id, "pm2_start")).toBeNull();
    expect(findDecisionFor(incident.id, "pm2_res")).toBeNull();
    expect(findDecisionFor(incident.id, "pm2_restart")?.proposal).toContain("pm2_restart");
  });

  it("is scoped to one incident — the same question on another one is a different question", () => {
    const a = newIncident();
    const b = newIncident();
    ask(a.id, `redeploy_previous\n{}\n\nwhy`);
    expect(findDecisionFor(a.id, "redeploy_previous")).not.toBeNull();
    expect(findDecisionFor(b.id, "redeploy_previous")).toBeNull();
  });

  it("ignores a decision that carries no proposal", () => {
    const incident = newIncident();
    ask(incident.id, null);
    expect(findDecisionFor(incident.id, "redeploy_previous")).toBeNull();
  });

  it("finds the question whether or not it has been answered, so it is never asked twice", () => {
    const incident = newIncident();
    const d = ask(incident.id, `redeploy_previous\n{}\n\nwhy`);
    expect(findDecisionFor(incident.id, "redeploy_previous")?.id).toBe(d.id);
    expect(findDecisionFor(incident.id, "redeploy_previous")?.answer).toBeNull();
  });
});
