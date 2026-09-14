import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * VIGIL — the agent that keeps watch over the things you own.
 *
 * A HOUSEHOLD is a place with THINGS in it: a car, a cot, a heater, a bottle of supplements.
 * On a schedule the agent runs a PASS over them, and every question it asks a government API is
 * recorded as a CHECK — including the ones that answered nothing, because "we looked and it was
 * quiet" is the product's most common true statement and it must be provable.
 *
 * When a check turns something up the agent writes a FINDING, and every field on it is lifted
 * verbatim from the source that carries the sourceId. A finding it cannot resolve alone becomes a
 * DECISION — a real Strands interrupt, persisted here so it survives the browser closing. What the
 * human answers becomes STANDING: a rule in their own words, so the agent never asks it twice.
 */

export const households = sqliteTable("households", {
  id: text("id").primaryKey(),
  ownerKey: text("owner_key").notNull(),
  name: text("name").notNull(),
  /** free text the owner gave about the place — feeds the intake agent, never displayed as fact */
  place: text("place"),
  /** "idle" | "watching" — watching means the sweep will pick it up */
  watchState: text("watch_state").notNull().default("watching"),
  lastPassAt: integer("last_pass_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const things = sqliteTable("things", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull(),
  /** what kind of watch applies: "vehicle" | "product" | "ingestible" */
  kind: text("kind").notNull(),
  /** what the owner calls it — "Ayesha's car seat", not a SKU */
  label: text("label").notNull(),
  make: text("make"),
  model: text("model"),
  year: integer("year"),
  /** VIN, serial, lot or model number — whatever identifies THIS unit */
  identifier: text("identifier"),
  /** the government's own taxonomy word when we have one: "child restraint", "crib", "space heater" */
  category: text("category"),
  /** when they got it — decides whether a date-windowed recall covers this unit */
  acquiredAt: integer("acquired_at"),
  /** second-hand goods are invisible to every manufacturer's owner list; that is the point */
  secondHand: integer("second_hand", { mode: "boolean" }).notNull().default(false),
  note: text("note"),
  /** the intake agent's own confidence in what it read, 0..1 — below the floor it asks */
  confidence: real("confidence").notNull().default(1),
  /** JSON string[]: what it could not read. A thing with unknowns is watched, not guessed at. */
  unknowns: text("unknowns").notNull().default("[]"),
  /** the vPIC decode, verbatim, when the identifier was a VIN */
  decoded: text("decoded"),
  /** "photo" | "typed" | "receipt" | "vin" */
  addedVia: text("added_via").notNull().default("typed"),
  addedAt: integer("added_at").notNull(),
  retiredAt: integer("retired_at"),
});

export const passes = sqliteTable("passes", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull(),
  /** "manual" | "cron" | "new_thing" — why the agent woke up */
  trigger: text("trigger").notNull().default("manual"),
  /** "running" | "clean" | "found" | "interrupted" | "failed" */
  status: text("status").notNull().default("running"),
  thingsChecked: integer("things_checked").notNull().default(0),
  sourcesOk: integer("sources_ok").notNull().default(0),
  sourcesFailed: integer("sources_failed").notNull().default(0),
  /** how many government rows the agent actually read this pass */
  rowsSeen: integer("rows_seen").notNull().default(0),
  findingsNew: integer("findings_new").notNull().default(0),
  startedAt: integer("started_at").notNull(),
  finishedAt: integer("finished_at"),
  /**
   * The pass's own working state, written when it halts on a question. A run that stops to ask
   * someone something may wait days; the process it started in will not. This is what lets the
   * same run be picked up after a restart instead of starting over.
   */
  context: text("context"),
});

export const checks = sqliteTable("checks", {
  id: text("id").primaryKey(),
  passId: text("pass_id").notNull(),
  householdId: text("household_id").notNull(),
  thingId: text("thing_id").notNull(),
  /** "nhtsa-recalls" | "nhtsa-complaints" | "nhtsa-vpic" | "cpsc-recalls" | "openfda" */
  source: text("source").notNull(),
  /** the exact URL called, so anyone can curl the same thing and get the same answer */
  endpoint: text("endpoint").notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  rowCount: integer("row_count").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  error: text("error"),
  at: integer("at").notNull(),
});

export const findings = sqliteTable("findings", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull(),
  thingId: text("thing_id").notNull(),
  passId: text("pass_id").notNull(),
  /** "recall" (published, confirmed) | "pattern" (strangers reporting the same failure) | "advisory" */
  kind: text("kind").notNull(),
  /** "critical" (park it / injury / death) | "high" | "watch" */
  severity: text("severity").notNull().default("high"),
  source: text("source").notNull(),
  /** the campaign number, recall number or cluster key — the thing a judge can look up */
  sourceId: text("source_id").notNull(),
  sourceUrl: text("source_url"),
  title: text("title").notNull(),
  /** the government's own words. Never the model's. */
  consequence: text("consequence"),
  remedy: text("remedy"),
  component: text("component"),
  unitsAffected: integer("units_affected"),
  /** the match agent's confidence that this row is about THIS unit, 0..1 */
  confidence: real("confidence").notNull().default(1),
  /** in the agent's words: why this row covers this thing, citing the fields it matched on */
  matchReason: text("match_reason"),
  /** the untouched source row */
  raw: text("raw"),
  /** "open" | "acknowledged" | "scheduled" | "dismissed" | "held" */
  state: text("state").notNull().default("open"),
  resolutionNote: text("resolution_note"),
  createdAt: integer("created_at").notNull(),
  resolvedAt: integer("resolved_at"),
});

export const decisions = sqliteTable("decisions", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull(),
  passId: text("pass_id"),
  findingId: text("finding_id"),
  thingId: text("thing_id"),
  /** the government record this question is about, so the same question is never opened twice */
  sourceId: text("source_id"),
  /** the Strands Interrupt this decision IS — the run is genuinely halted until it is answered */
  interruptId: text("interrupt_id"),
  interruptName: text("interrupt_name"),
  /** "confirm_match" | "notify_others" | "file_report" | "identify" | "dismissable" */
  kind: text("kind").notNull(),
  question: text("question").notNull(),
  context: text("context"),
  /** JSON [{ value, label, tone }] */
  options: text("options").notNull(),
  answer: text("answer"),
  answerNote: text("answer_note"),
  answeredAt: integer("answered_at"),
  resumedAt: integer("resumed_at"),
  createdAt: integer("created_at").notNull(),
});

/** What the human decided, kept as a rule in their own words, so the agent never asks twice. */
export const standing = sqliteTable("standing", {
  id: text("id").primaryKey(),
  householdId: text("household_id").notNull(),
  /** the thing it applies to, or null for the whole household */
  thingId: text("thing_id"),
  text: text("text").notNull(),
  fromDecisionId: text("from_decision_id"),
  createdAt: integer("created_at").notNull(),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  householdId: text("household_id").notNull(),
  kind: text("kind").notNull(),
  detail: text("detail"),
  /** which part did it: "intake" | "watch" | "match" | "brief" | "human" | "system" */
  actor: text("actor").notNull(),
  refId: text("ref_id"),
  createdAt: integer("created_at").notNull(),
});

export type Household = typeof households.$inferSelect;
export type Thing = typeof things.$inferSelect;
export type Pass = typeof passes.$inferSelect;
export type Check = typeof checks.$inferSelect;
export type Finding = typeof findings.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type Standing = typeof standing.$inferSelect;
export type VigilEvent = typeof events.$inferSelect;
