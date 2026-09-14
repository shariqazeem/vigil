import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * WARDEN — an autonomous operator for software that is already running.
 *
 * A SERVICE is something someone depends on. PROBES are the questions Warden asks it, and every
 * answer is a READING — including the boring ones, because "it has been fine for nine hours" is a
 * claim that needs a record behind it.
 *
 * When a probe fails, an INCIDENT opens and stays open until the same probe passes again. Inside
 * it, every operation Warden runs is an ACTION carrying the exact command, the policy verdict that
 * allowed it, and what came back. A fix is only a fix when the reading that failed reads clean —
 * and that check is code, not a model.
 *
 * Anything the policy will not let Warden do alone becomes a DECISION: a real halt, held here
 * until a human answers.
 */

export const services = sqliteTable("services", {
  id: text("id").primaryKey(),
  ownerKey: text("owner_key").notNull(),
  name: text("name").notNull(),
  /** one line about what breaks for a human when this is down */
  matters: text("matters"),
  /** "local", or an ssh destination Warden holds a key for */
  host: text("host").notNull().default("local"),
  sshKey: text("ssh_key"),
  /** absolute path to the checkout, when it has one */
  repo: text("repo"),
  /** the pm2 process name, when it is a pm2 service */
  process: text("process"),
  /** the node binary it runs under, when it is not the one on PATH */
  nodeBin: text("node_bin"),
  /** JSON Policy — what Warden may do here without asking */
  policy: text("policy").notNull(),
  /** "watching" | "paused" */
  state: text("state").notNull().default("watching"),
  lastSweptAt: integer("last_swept_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const probes = sqliteTable("probes", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull(),
  /** what it asks: "http" | "process" */
  kind: text("kind").notNull(),
  /** the human name for what this proves: "the site answers", "the worker is up" */
  label: text("label").notNull(),
  /** JSON: the operation input — a url and its expectations, or a process name */
  spec: text("spec").notNull(),
  everySeconds: integer("every_seconds").notNull().default(300),
  /** consecutive failures before an incident opens — one blip is not an outage */
  failuresToOpen: integer("failures_to_open").notNull().default(2),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const readings = sqliteTable("readings", {
  id: text("id").primaryKey(),
  probeId: text("probe_id").notNull(),
  serviceId: text("service_id").notNull(),
  ok: integer("ok", { mode: "boolean" }).notNull(),
  /** what came back, in one line, from the operation itself */
  detail: text("detail").notNull(),
  latencyMs: integer("latency_ms").notNull().default(0),
  /** set when this reading was taken to verify a fix */
  incidentId: text("incident_id"),
  at: integer("at").notNull(),
});

export const incidents = sqliteTable("incidents", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull(),
  probeId: text("probe_id").notNull(),
  title: text("title").notNull(),
  /** "open" | "investigating" | "acting" | "verifying" | "resolved" | "escalated" | "gave_up" */
  status: text("status").notNull().default("open"),
  /** "down" | "degraded" */
  severity: text("severity").notNull().default("down"),
  /** the reading that opened it, verbatim */
  symptom: text("symptom").notNull(),
  /** Warden's account of the cause, citing the evidence it read */
  diagnosis: text("diagnosis"),
  /** the commit, file or process the diagnosis points at */
  suspect: text("suspect"),
  /** how sure it is, 0..1 — below the floor it does not act, it asks */
  confidence: real("confidence"),
  /** what fixed it, or why nobody could */
  resolution: text("resolution"),
  /** the reading that proved it fixed. Without one, an incident is not resolved. */
  verifiedByReadingId: text("verified_by_reading_id"),
  openedAt: integer("opened_at").notNull(),
  resolvedAt: integer("resolved_at"),
  /** seconds actually down: opened → the reading that proved it back */
  downSeconds: integer("down_seconds"),
});

export const actions = sqliteTable("actions", {
  id: text("id").primaryKey(),
  incidentId: text("incident_id").notNull(),
  serviceId: text("service_id").notNull(),
  /** an operation name from the catalogue. There is no other kind of action. */
  op: text("op").notNull(),
  risk: text("risk").notNull(),
  /** JSON arguments, as validated */
  input: text("input").notNull(),
  /** why Warden wanted this, in its own words, before it knew the answer */
  intent: text("intent"),
  /** "allow" | "ask" | "refuse" — the policy's answer */
  verdict: text("verdict").notNull(),
  rule: text("rule").notNull(),
  reason: text("reason").notNull(),
  /** the exact command that ran, printable and checkable by a human */
  command: text("command"),
  ok: integer("ok", { mode: "boolean" }),
  output: text("output"),
  exitCode: integer("exit_code"),
  ms: integer("ms"),
  at: integer("at").notNull(),
});

export const decisions = sqliteTable("decisions", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull(),
  incidentId: text("incident_id"),
  /** the Strands Interrupt this decision IS: the run halts until it is answered */
  interruptId: text("interrupt_id"),
  /** "approve_action" | "choose_fix" | "give_up" */
  kind: text("kind").notNull(),
  question: text("question").notNull(),
  /** what Warden would do, exactly — so a human approves the thing, not a summary of it */
  proposal: text("proposal"),
  /** the policy sentence that made this a question rather than an act */
  because: text("because"),
  /** JSON [{ value, label, tone }] */
  options: text("options").notNull(),
  answer: text("answer"),
  answerNote: text("answer_note"),
  answeredAt: integer("answered_at"),
  resumedAt: integer("resumed_at"),
  createdAt: integer("created_at").notNull(),
});

/** What a human decided, kept in their words, so Warden does not ask the same thing twice. */
export const standing = sqliteTable("standing", {
  id: text("id").primaryKey(),
  serviceId: text("service_id").notNull(),
  text: text("text").notNull(),
  fromDecisionId: text("from_decision_id"),
  createdAt: integer("created_at").notNull(),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  serviceId: text("service_id").notNull(),
  incidentId: text("incident_id"),
  kind: text("kind").notNull(),
  detail: text("detail"),
  /** "sweep" | "investigate" | "fix" | "verify" | "policy" | "human" | "system" */
  actor: text("actor").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type Service = typeof services.$inferSelect;
export type Probe = typeof probes.$inferSelect;
export type Reading = typeof readings.$inferSelect;
export type Incident = typeof incidents.$inferSelect;
export type Action = typeof actions.$inferSelect;
export type Decision = typeof decisions.$inferSelect;
export type Standing = typeof standing.$inferSelect;
export type WardenEvent = typeof events.$inferSelect;
