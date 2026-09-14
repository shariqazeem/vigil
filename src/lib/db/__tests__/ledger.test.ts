/**
 * The ledger properties a watch that runs for years lives or dies on.
 *
 * A pass is not a conversation, it is a record: every question asked is counted whether or not it
 * answered anything, the same recall found on the same cot for the eleventh time is the same
 * finding rather than an eleventh alarm, a question already put to the owner is never opened twice,
 * and a run that halts to ask something can be picked up in a different process days later with its
 * working state intact.
 *
 * A throwaway SQLite file; no network, no model.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

/** The DB path has to be set before anything under src/lib/db is imported, so it is set up here. */
const DB_FILE = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  const path = `${tmp}/vigil-ledger-${process.pid}-${Date.now()}/vigil.db`;
  process.env.VIGIL_DB_PATH = path;
  (globalThis as { __vigilDb?: unknown }).__vigilDb = undefined;
  return path;
});

import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { eq } from "drizzle-orm";
import {
  closeContext,
  contextFor,
  freeze,
  openContext,
  thaw,
  type Candidate,
  type Cluster,
  type StoredContext,
} from "@/agent/pass-context";
import { db, schema } from "../index";
import {
  addThing,
  createHousehold,
  findDecisionFor,
  getPass,
  openDecision,
  recordCheck,
  recordFinding,
  startPass,
} from "../vigil";
import type { Thing } from "../schema";

afterAll(() => {
  rmSync(dirname(DB_FILE), { recursive: true, force: true });
});

const household = createHousehold({ ownerKey: "test:ledger", name: "the test house" });
const cot: Thing = addThing(household.id, { kind: "product", label: "the cot", make: "IKEA", model: "SNIGLAR", category: "cot" });
const car: Thing = addThing(household.id, { kind: "vehicle", label: "the Accord", make: "Honda", model: "Accord", year: 2019 });

const finding = (thingId: string, passId: string, sourceId: string) => ({
  householdId: household.id,
  thingId,
  passId,
  kind: "recall",
  severity: "high",
  source: "cpsc-recalls",
  sourceId,
  sourceUrl: "https://www.cpsc.gov/Recalls/2026/24-321",
  title: "Cots recalled because the mattress support can collapse",
  consequence: "Fall and entrapment hazard.",
  remedy: "Contact IKEA for a free repair kit.",
  component: "cot",
  unitsAffected: 12_000,
  confidence: 0.91,
  matchReason: "the record names SNIGLAR",
  raw: { recallNumber: "24-321" },
});

/* ── findings ─────────────────────────────────────────────────────────────── */

describe("recordFinding is idempotent on (thing, record)", () => {
  it("finds the same campaign on the same cot on a second pass without writing a second row", () => {
    const first = startPass(household.id, "manual");
    const a = recordFinding(finding(cot.id, first.id, "24-321"));
    expect(a.isNew).toBe(true);

    const second = startPass(household.id, "cron");
    const b = recordFinding(finding(cot.id, second.id, "24-321"));
    expect(b.isNew).toBe(false);
    expect(b.finding.id).toBe(a.finding.id);
    // The row still belongs to the pass that first found it.
    expect(b.finding.passId).toBe(first.id);

    const rows = db.select().from(schema.findings).where(eq(schema.findings.sourceId, "24-321")).all();
    expect(rows).toHaveLength(1);
    // Only the pass that actually wrote one counts a new finding.
    expect(getPass(first.id)?.findingsNew).toBe(1);
    expect(getPass(second.id)?.findingsNew).toBe(0);
  });

  it("is idempotent per thing, not per record — the same recall on two things is two findings", () => {
    const pass = startPass(household.id, "manual");
    expect(recordFinding(finding(cot.id, pass.id, "24-777")).isNew).toBe(true);
    expect(recordFinding(finding(car.id, pass.id, "24-777")).isNew).toBe(true);
    expect(db.select().from(schema.findings).where(eq(schema.findings.sourceId, "24-777")).all()).toHaveLength(2);
    expect(getPass(pass.id)?.findingsNew).toBe(2);
  });

  it("keeps the government's fields verbatim and opens the finding", () => {
    const pass = startPass(household.id, "manual");
    const { finding: row } = recordFinding(finding(cot.id, pass.id, "24-888"));
    expect(row.title).toBe("Cots recalled because the mattress support can collapse");
    expect(row.consequence).toBe("Fall and entrapment hazard.");
    expect(row.unitsAffected).toBe(12_000);
    expect(row.state).toBe("open");
    expect(JSON.parse(row.raw ?? "null")).toEqual({ recallNumber: "24-321" });
  });
});

/* ── checks ───────────────────────────────────────────────────────────────── */

describe("recordCheck counts every question the pass asked", () => {
  const check = (passId: string, p: { source: string; ok: boolean; rowCount: number; error?: string | null }) => ({
    passId,
    householdId: household.id,
    thingId: cot.id,
    endpoint: `https://example.test/${p.source}`,
    latencyMs: 12,
    error: p.error ?? null,
    ...p,
  });

  it("adds up rows seen, sources that answered and sources that did not", () => {
    const pass = startPass(household.id, "manual");
    expect(getPass(pass.id)).toMatchObject({ rowsSeen: 0, sourcesOk: 0, sourcesFailed: 0 });

    recordCheck(check(pass.id, { source: "cpsc-recalls", ok: true, rowCount: 4_312 }));
    expect(getPass(pass.id)).toMatchObject({ rowsSeen: 4_312, sourcesOk: 1, sourcesFailed: 0 });

    recordCheck(check(pass.id, { source: "openfda", ok: true, rowCount: 3 }));
    recordCheck(check(pass.id, { source: "nhtsa-recalls", ok: false, rowCount: 0, error: "HTTP 503" }));
    expect(getPass(pass.id)).toMatchObject({ rowsSeen: 4_315, sourcesOk: 2, sourcesFailed: 1 });
  });

  it("keeps the failure inspectable — a source that failed is not a source that was clean", () => {
    const pass = startPass(household.id, "manual");
    recordCheck(check(pass.id, { source: "nhtsa-complaints", ok: false, rowCount: 0, error: "fetch timed out" }));
    const row = db.select().from(schema.checks).where(eq(schema.checks.passId, pass.id)).get();
    expect(row?.ok).toBe(false);
    expect(row?.error).toBe("fetch timed out");
    expect(row?.rowCount).toBe(0);
    expect(row?.endpoint).toBe("https://example.test/nhtsa-complaints");
    expect(getPass(pass.id)?.sourcesOk).toBe(0);
  });

  it("counts a pass's checks only against that pass", () => {
    const mine = startPass(household.id, "manual");
    const theirs = startPass(household.id, "manual");
    recordCheck(check(mine.id, { source: "openfda", ok: true, rowCount: 7 }));
    expect(getPass(mine.id)?.rowsSeen).toBe(7);
    expect(getPass(theirs.id)?.rowsSeen).toBe(0);
  });
});

/* ── decisions ────────────────────────────────────────────────────────────── */

describe("findDecisionFor — one question per record, ever", () => {
  it("hands back the same decision for the same (pass, thing, record)", () => {
    const pass = startPass(household.id, "manual");
    const opened = openDecision({
      householdId: household.id,
      passId: pass.id,
      thingId: cot.id,
      sourceId: "24-321",
      kind: "identify",
      question: "Is the date code under your cot's mattress support between 1901 and 2003?",
      options: [
        { value: "yes", label: "Yes — it matches", tone: "danger" },
        { value: "no", label: "No — it doesn't", tone: "quiet" },
      ],
    });
    expect(findDecisionFor(pass.id, cot.id, "24-321")?.id).toBe(opened.id);
    expect(findDecisionFor(pass.id, cot.id, "24-321")?.question).toBe(opened.question);
  });

  it("does not confuse it with another record, another thing or another pass", () => {
    const pass = startPass(household.id, "manual");
    const other = startPass(household.id, "manual");
    openDecision({ householdId: household.id, passId: pass.id, thingId: cot.id, sourceId: "24-654", kind: "identify", question: "which unit?", options: [] });
    expect(findDecisionFor(pass.id, cot.id, "24-654")).not.toBeNull();
    expect(findDecisionFor(pass.id, cot.id, "24-999")).toBeNull();
    expect(findDecisionFor(pass.id, car.id, "24-654")).toBeNull();
    expect(findDecisionFor(other.id, cot.id, "24-654")).toBeNull();
  });
});

/* ── freeze / thaw ────────────────────────────────────────────────────────── */

describe("freeze and thaw carry a halted pass across a process boundary", () => {
  const candidate: Candidate = {
    sourceId: "24-321",
    source: "cpsc-recalls",
    sourceUrl: "https://www.cpsc.gov/Recalls/2026/24-321",
    thingId: "th_cot",
    title: "Cots recalled",
    summary: "The mattress support can collapse.",
    consequence: "Fall hazard.",
    remedy: "Free repair kit.",
    component: "cot",
    unitsAffected: 12_000,
    parkIt: false,
    date: "2026-02-01",
    raw: { recallNumber: "24-321" },
  };

  const cluster: Cluster = {
    key: "th_car:STEERING",
    thingId: "th_car",
    component: "STEERING",
    count: 14,
    crashes: 2,
    fires: 0,
    injuries: 3,
    deaths: 0,
    firstAt: "2023-01-01",
    lastAt: "2025-12-20",
    odiNumbers: ["1", "2", "3"],
    quote: "THE STEERING WENT LIGHT AT SPEED.",
    quoteOdi: "3",
    timeline: [1, 2, 3],
  };

  function halted() {
    const ctx = openContext({
      passId: "pass_frozen",
      householdId: household.id,
      things: [cot, car],
      standing: ["Never ask me about the toaster again."],
      expected: [
        { thingId: "th_cot", source: "cpsc-recalls" },
        { thingId: "th_car", source: "nhtsa-recalls" },
      ],
      emit: () => {},
    });
    ctx.terms.set("th_cot", ["ikea sniglar", "cot"]);
    ctx.terms.set("th_car", ["honda accord"]);
    ctx.done.add("th_cot::cpsc-recalls");
    ctx.done.add("th_car::nhtsa-recalls");
    ctx.ruled.set("th_cot::24-321", "unsure");
    ctx.ruled.set("th_car::20V314000", "covers");
    ctx.candidates.push(candidate);
    ctx.clusters.push(cluster);
    ctx.held.push({ thingId: "th_cot", sourceId: "24-321", question: "which unit?", reason: "date code unknown", severity: "high", confidence: 0.5 });
    ctx.wrote.push({ findingId: "fnd_1", sourceId: "20V314000", thingId: "th_car" });
    ctx.asked.push({ decisionId: "dec_1", interruptId: null, question: "which unit?", thingId: "th_cot", sourceId: "24-321" });
    return ctx;
  }

  it("round-trips through JSON with the Maps and Sets intact", () => {
    const before = halted();
    // Exactly what the code does: freeze, JSON into the passes table, JSON back out, thaw.
    const stored = JSON.parse(JSON.stringify(freeze(before))) as StoredContext;
    closeContext(before.passId);

    const after = thaw("pass_frozen", household.id, [cot, car], stored, () => {});

    expect(after.terms).toBeInstanceOf(Map);
    expect(after.done).toBeInstanceOf(Set);
    expect(after.ruled).toBeInstanceOf(Map);
    expect([...after.terms]).toEqual([...before.terms]);
    expect(after.terms.get("th_cot")).toEqual(["ikea sniglar", "cot"]);
    expect([...after.done]).toEqual([...before.done]);
    expect(after.done.has("th_car::nhtsa-recalls")).toBe(true);
    expect([...after.ruled]).toEqual([...before.ruled]);
    expect(after.ruled.get("th_cot::24-321")).toBe("unsure");

    expect(after.candidates).toEqual(before.candidates);
    expect(after.clusters).toEqual(before.clusters);
    expect(after.held).toEqual(before.held);
    expect(after.wrote).toEqual(before.wrote);
    expect(after.asked).toEqual(before.asked);
    expect(after.standing).toEqual(before.standing);
    expect(after.expected).toEqual(before.expected);
    expect(after.householdId).toBe(household.id);
    expect(after.things.map((t) => t.id)).toEqual([cot.id, car.id]);

    closeContext(after.passId);
  });

  it("puts the thawed pass back on the register, so the tools can find it again", () => {
    const before = halted();
    const stored = JSON.parse(JSON.stringify(freeze(before))) as StoredContext;
    closeContext(before.passId);
    expect(() => contextFor("pass_frozen")).toThrow(/no live pass/);

    const after = thaw("pass_frozen", household.id, [cot, car], stored, () => {});
    expect(contextFor("pass_frozen")).toBe(after);
    closeContext("pass_frozen");
    expect(() => contextFor("pass_frozen")).toThrow(/no live pass/);
  });

  it("a frozen context is plain JSON — nothing survives as a live object by accident", () => {
    const stored = freeze(halted());
    expect(Array.isArray(stored.terms)).toBe(true);
    expect(Array.isArray(stored.done)).toBe(true);
    expect(Array.isArray(stored.ruled)).toBe(true);
    expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
    closeContext("pass_frozen");
  });
});
