import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "./index";
import type { Check, Decision, Finding, Household, Pass, Standing, Thing, VigilEvent } from "./schema";

const { households, things, passes, checks, findings, decisions, standing, events } = schema;

const now = () => Date.now();
const id = (p: string) => `${p}_${nanoid(10)}`;

/* ── households ───────────────────────────────────────────────────────────── */

export function createHousehold(input: { ownerKey: string; name: string; place?: string | null }): Household {
  const row = {
    id: id("hh"),
    ownerKey: input.ownerKey,
    name: input.name,
    place: input.place ?? null,
    watchState: "watching",
    lastPassAt: null,
    createdAt: now(),
    updatedAt: now(),
  } satisfies Household;
  db.insert(households).values(row).run();
  return row;
}

export function getHousehold(hid: string): Household | null {
  return db.select().from(households).where(eq(households.id, hid)).get() ?? null;
}

export function listHouseholds(ownerKey: string): Household[] {
  return db.select().from(households).where(eq(households.ownerKey, ownerKey)).orderBy(desc(households.updatedAt)).all();
}

export function touchHousehold(hid: string, patch: Partial<Pick<Household, "watchState" | "lastPassAt" | "name" | "place">> = {}): void {
  db.update(households).set({ ...patch, updatedAt: now() }).where(eq(households.id, hid)).run();
}

/* ── things ───────────────────────────────────────────────────────────────── */

export interface ThingInput {
  kind: string;
  label: string;
  make?: string | null;
  model?: string | null;
  year?: number | null;
  identifier?: string | null;
  category?: string | null;
  acquiredAt?: number | null;
  secondHand?: boolean;
  note?: string | null;
  confidence?: number;
  unknowns?: string[];
  decoded?: unknown;
  addedVia?: string;
}

export function addThing(hid: string, t: ThingInput): Thing {
  const row = {
    id: id("th"),
    householdId: hid,
    kind: t.kind,
    label: t.label,
    make: t.make ?? null,
    model: t.model ?? null,
    year: t.year ?? null,
    identifier: t.identifier ?? null,
    category: t.category ?? null,
    acquiredAt: t.acquiredAt ?? null,
    secondHand: t.secondHand ?? false,
    note: t.note ?? null,
    confidence: t.confidence ?? 1,
    unknowns: JSON.stringify(t.unknowns ?? []),
    decoded: t.decoded === undefined ? null : JSON.stringify(t.decoded),
    addedVia: t.addedVia ?? "typed",
    addedAt: now(),
    retiredAt: null,
  } satisfies Thing;
  db.insert(things).values(row).run();
  touchHousehold(hid);
  return row;
}

export function listThings(hid: string, opts: { includeRetired?: boolean } = {}): Thing[] {
  const where = opts.includeRetired ? eq(things.householdId, hid) : and(eq(things.householdId, hid), isNull(things.retiredAt));
  return db.select().from(things).where(where).orderBy(things.addedAt).all();
}

export function getThing(tid: string): Thing | null {
  return db.select().from(things).where(eq(things.id, tid)).get() ?? null;
}

export function updateThing(tid: string, patch: Partial<Omit<Thing, "id" | "householdId">>): void {
  db.update(things).set(patch).where(eq(things.id, tid)).run();
}

export function retireThing(tid: string): void {
  db.update(things).set({ retiredAt: now() }).where(eq(things.id, tid)).run();
}

/* ── passes and checks — the record of every question the agent asked ─────── */

export function startPass(hid: string, trigger: string): Pass {
  const row = {
    id: id("pass"),
    householdId: hid,
    trigger,
    status: "running",
    thingsChecked: 0,
    sourcesOk: 0,
    sourcesFailed: 0,
    rowsSeen: 0,
    findingsNew: 0,
    startedAt: now(),
    finishedAt: null,
    context: null,
  } satisfies Pass;
  db.insert(passes).values(row).run();
  return row;
}

export function savePassContext(pid: string, context: unknown): void {
  db.update(passes).set({ context: JSON.stringify(context) }).where(eq(passes.id, pid)).run();
}

export function finishPass(pid: string, status: string): void {
  db.update(passes).set({ status, finishedAt: now() }).where(eq(passes.id, pid)).run();
  const p = db.select().from(passes).where(eq(passes.id, pid)).get();
  if (p) touchHousehold(p.householdId, { lastPassAt: now() });
}

export function recordCheck(input: {
  passId: string;
  householdId: string;
  thingId: string;
  source: string;
  endpoint: string;
  ok: boolean;
  rowCount: number;
  latencyMs: number;
  error?: string | null;
}): Check {
  const row = { id: id("chk"), ...input, error: input.error ?? null, at: now() } satisfies Check;
  db.insert(checks).values(row).run();
  db.update(passes)
    .set({
      rowsSeen: sql`${passes.rowsSeen} + ${input.rowCount}`,
      sourcesOk: sql`${passes.sourcesOk} + ${input.ok ? 1 : 0}`,
      sourcesFailed: sql`${passes.sourcesFailed} + ${input.ok ? 0 : 1}`,
    })
    .where(eq(passes.id, input.passId))
    .run();
  return row;
}

export function listPasses(hid: string, limit = 200): Pass[] {
  return db.select().from(passes).where(eq(passes.householdId, hid)).orderBy(desc(passes.startedAt)).limit(limit).all();
}

export function getPass(pid: string): Pass | null {
  return db.select().from(passes).where(eq(passes.id, pid)).get() ?? null;
}

export function listChecks(pid: string): Check[] {
  return db.select().from(checks).where(eq(checks.passId, pid)).orderBy(checks.at).all();
}

/** The most recent check per (thing, source) across all passes — "when was this last looked at". */
export function lastChecked(hid: string): Record<string, number> {
  const rows = db.select().from(checks).where(and(eq(checks.householdId, hid), eq(checks.ok, true))).orderBy(checks.at).all();
  const out: Record<string, number> = {};
  for (const r of rows) out[r.thingId] = r.at;
  return out;
}

/* ── findings ─────────────────────────────────────────────────────────────── */

export interface FindingInput {
  householdId: string;
  thingId: string;
  passId: string;
  kind: string;
  severity?: string;
  source: string;
  sourceId: string;
  sourceUrl?: string | null;
  title: string;
  consequence?: string | null;
  remedy?: string | null;
  component?: string | null;
  unitsAffected?: number | null;
  confidence?: number;
  matchReason?: string | null;
  raw?: unknown;
}

/**
 * Idempotent on (thing, sourceId): the same campaign found on the same cot on the eleventh pass is
 * the same finding, not an eleventh alarm. A watch that runs for years lives or dies on this.
 */
export function recordFinding(f: FindingInput): { finding: Finding; isNew: boolean } {
  const existing = db
    .select()
    .from(findings)
    .where(and(eq(findings.thingId, f.thingId), eq(findings.sourceId, f.sourceId)))
    .get();
  if (existing) return { finding: existing, isNew: false };
  const row = {
    id: id("fnd"),
    householdId: f.householdId,
    thingId: f.thingId,
    passId: f.passId,
    kind: f.kind,
    severity: f.severity ?? "high",
    source: f.source,
    sourceId: f.sourceId,
    sourceUrl: f.sourceUrl ?? null,
    title: f.title,
    consequence: f.consequence ?? null,
    remedy: f.remedy ?? null,
    component: f.component ?? null,
    unitsAffected: f.unitsAffected ?? null,
    confidence: f.confidence ?? 1,
    matchReason: f.matchReason ?? null,
    raw: f.raw === undefined ? null : JSON.stringify(f.raw),
    state: "open",
    resolutionNote: null,
    createdAt: now(),
    resolvedAt: null,
  } satisfies Finding;
  db.insert(findings).values(row).run();
  db.update(passes).set({ findingsNew: sql`${passes.findingsNew} + 1` }).where(eq(passes.id, f.passId)).run();
  return { finding: row, isNew: true };
}

export function listFindings(hid: string): Finding[] {
  return db.select().from(findings).where(eq(findings.householdId, hid)).orderBy(desc(findings.createdAt)).all();
}

export function getFinding(fid: string): Finding | null {
  return db.select().from(findings).where(eq(findings.id, fid)).get() ?? null;
}

export function resolveFinding(fid: string, state: string, note?: string): void {
  db.update(findings).set({ state, resolutionNote: note ?? null, resolvedAt: now() }).where(eq(findings.id, fid)).run();
}

/* ── decisions — persisted Strands interrupts ─────────────────────────────── */

export interface DecisionInput {
  householdId: string;
  passId?: string | null;
  findingId?: string | null;
  thingId?: string | null;
  sourceId?: string | null;
  interruptId?: string | null;
  interruptName?: string | null;
  kind: string;
  question: string;
  context?: string | null;
  options: { value: string; label: string; tone?: string }[];
}

export function openDecision(d: DecisionInput): Decision {
  const row = {
    id: id("dec"),
    householdId: d.householdId,
    passId: d.passId ?? null,
    findingId: d.findingId ?? null,
    thingId: d.thingId ?? null,
    sourceId: d.sourceId ?? null,
    interruptId: d.interruptId ?? null,
    interruptName: d.interruptName ?? null,
    kind: d.kind,
    question: d.question,
    context: d.context ?? null,
    options: JSON.stringify(d.options),
    answer: null,
    answerNote: null,
    answeredAt: null,
    resumedAt: null,
    createdAt: now(),
  } satisfies Decision;
  db.insert(decisions).values(row).run();
  return row;
}

/** The open or answered question already on record for this exact record. There is only ever one. */
export function findDecisionFor(passId: string, thingId: string, sourceId: string): Decision | null {
  return (
    db
      .select()
      .from(decisions)
      .where(and(eq(decisions.passId, passId), eq(decisions.thingId, thingId), eq(decisions.sourceId, sourceId)))
      .get() ?? null
  );
}

export function answerDecision(did: string, answer: string, note?: string): Decision | null {
  db.update(decisions).set({ answer, answerNote: note ?? null, answeredAt: now() }).where(eq(decisions.id, did)).run();
  return db.select().from(decisions).where(eq(decisions.id, did)).get() ?? null;
}

export function markResumed(did: string): void {
  db.update(decisions).set({ resumedAt: now() }).where(eq(decisions.id, did)).run();
}

export function listDecisions(hid: string): Decision[] {
  return db.select().from(decisions).where(eq(decisions.householdId, hid)).orderBy(desc(decisions.createdAt)).all();
}

export function openDecisions(hid: string): Decision[] {
  return db.select().from(decisions).where(and(eq(decisions.householdId, hid), isNull(decisions.answeredAt))).orderBy(decisions.createdAt).all();
}

export function getDecision(did: string): Decision | null {
  return db.select().from(decisions).where(eq(decisions.id, did)).get() ?? null;
}

/* ── standing rules — what the human answered, kept in their words ────────── */

export function addStanding(input: { householdId: string; thingId?: string | null; text: string; fromDecisionId?: string | null }): Standing {
  const row = {
    id: id("std"),
    householdId: input.householdId,
    thingId: input.thingId ?? null,
    text: input.text,
    fromDecisionId: input.fromDecisionId ?? null,
    createdAt: now(),
  } satisfies Standing;
  db.insert(standing).values(row).run();
  return row;
}

export function listStanding(hid: string): Standing[] {
  return db.select().from(standing).where(eq(standing.householdId, hid)).orderBy(standing.createdAt).all();
}

/* ── the journal ──────────────────────────────────────────────────────────── */

export function logEvent(hid: string, actor: string, kind: string, detail?: string, refId?: string): void {
  db.insert(events).values({ householdId: hid, actor, kind, detail: detail ?? null, refId: refId ?? null, createdAt: now() }).run();
}

export function listEvents(hid: string, limit = 200): VigilEvent[] {
  return db.select().from(events).where(eq(events.householdId, hid)).orderBy(desc(events.createdAt)).limit(limit).all();
}

/* ── the whole board in one read ──────────────────────────────────────────── */

export interface Board {
  household: Household;
  things: Thing[];
  findings: Finding[];
  decisions: Decision[];
  passes: Pass[];
  standing: Standing[];
  lastChecked: Record<string, number>;
}

export function getBoard(hid: string): Board | null {
  const household = getHousehold(hid);
  if (!household) return null;
  return {
    household,
    things: listThings(hid),
    findings: listFindings(hid),
    decisions: listDecisions(hid),
    passes: listPasses(hid, 400),
    standing: listStanding(hid),
    lastChecked: lastChecked(hid),
  };
}

/** Every household the sweep should look at, oldest watch first. */
export function householdsDueForPass(gapHours: number): Household[] {
  const cutoff = now() - gapHours * 3600_000;
  return db
    .select()
    .from(households)
    .where(eq(households.watchState, "watching"))
    .all()
    .filter((h) => (h.lastPassAt ?? 0) < cutoff)
    .sort((a, b) => (a.lastPassAt ?? 0) - (b.lastPassAt ?? 0));
}

export const parseUnknowns = (t: Thing): string[] => {
  try {
    const v = JSON.parse(t.unknowns) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export const parseOptions = (d: Decision): { value: string; label: string; tone?: string }[] => {
  try {
    const v = JSON.parse(d.options) as unknown;
    return Array.isArray(v) ? (v as { value: string; label: string; tone?: string }[]) : [];
  } catch {
    return [];
  }
};
