import { and, desc, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "./index";
import type { Action, Decision, Incident, Probe, Reading, Service, Standing, WardenEvent } from "./schema";
import { parsePolicy, type Policy } from "@/lib/ops/policy";
import type { Target } from "@/lib/ops/operations";

const { services, probes, readings, incidents, actions, decisions, standing, events } = schema;

const now = () => Date.now();
const id = (p: string) => `${p}_${nanoid(10)}`;

/* ── services ─────────────────────────────────────────────────────── */

export interface ServiceInput {
  ownerKey: string;
  name: string;
  matters?: string | null;
  host?: string;
  sshKey?: string | null;
  repo?: string | null;
  process?: string | null;
  nodeBin?: string | null;
  policy: Policy;
}

export function addService(s: ServiceInput): Service {
  const row = {
    id: id("svc"),
    ownerKey: s.ownerKey,
    name: s.name,
    matters: s.matters ?? null,
    host: s.host ?? "local",
    sshKey: s.sshKey ?? null,
    repo: s.repo ?? null,
    process: s.process ?? null,
    nodeBin: s.nodeBin ?? null,
    policy: JSON.stringify(s.policy),
    state: "watching",
    lastSweptAt: null,
    createdAt: now(),
    updatedAt: now(),
  } satisfies Service;
  db.insert(services).values(row).run();
  return row;
}

export const getService = (sid: string): Service | null => db.select().from(services).where(eq(services.id, sid)).get() ?? null;
export const listServices = (ownerKey: string): Service[] =>
  db.select().from(services).where(eq(services.ownerKey, ownerKey)).orderBy(services.createdAt).all();
export const allServices = (): Service[] => db.select().from(services).orderBy(services.createdAt).all();

export function touchService(sid: string, patch: Partial<Pick<Service, "state" | "lastSweptAt" | "policy" | "matters">> = {}): void {
  db.update(services).set({ ...patch, updatedAt: now() }).where(eq(services.id, sid)).run();
}

/** Everything an operation needs to reach this service. */
export const targetOf = (s: Service): Target => ({ host: s.host, sshKey: s.sshKey, repo: s.repo, process: s.process, nodeBin: s.nodeBin });
export const policyOf = (s: Service): Policy => parsePolicy(s.policy);

/* ── probes and readings ──────────────────────────────────────────── */

export function addProbe(p: { serviceId: string; kind: string; label: string; spec: unknown; everySeconds?: number; failuresToOpen?: number }): Probe {
  const row = {
    id: id("prb"),
    serviceId: p.serviceId,
    kind: p.kind,
    label: p.label,
    spec: JSON.stringify(p.spec),
    everySeconds: p.everySeconds ?? 300,
    failuresToOpen: p.failuresToOpen ?? 2,
    enabled: true,
    createdAt: now(),
  } satisfies Probe;
  db.insert(probes).values(row).run();
  return row;
}

export const listProbes = (sid: string): Probe[] => db.select().from(probes).where(and(eq(probes.serviceId, sid), eq(probes.enabled, true))).all();
export const getProbe = (pid: string): Probe | null => db.select().from(probes).where(eq(probes.id, pid)).get() ?? null;

export function recordReading(r: { probeId: string; serviceId: string; ok: boolean; detail: string; latencyMs: number; incidentId?: string | null }): Reading {
  const row = { id: id("rd"), ...r, incidentId: r.incidentId ?? null, at: now() } satisfies Reading;
  db.insert(readings).values(row).run();
  return row;
}

export const listReadings = (sid: string, limit = 300): Reading[] =>
  db.select().from(readings).where(eq(readings.serviceId, sid)).orderBy(desc(readings.at)).limit(limit).all();

export const readingsFor = (probeId: string, limit = 200): Reading[] =>
  db.select().from(readings).where(eq(readings.probeId, probeId)).orderBy(desc(readings.at)).limit(limit).all();

/** Consecutive failures at the head of a probe's history. What decides an incident opens. */
export function consecutiveFailures(probeId: string): number {
  const rows = readingsFor(probeId, 20);
  let n = 0;
  for (const r of rows) {
    if (r.ok) break;
    n += 1;
  }
  return n;
}

/* ── incidents ────────────────────────────────────────────────────── */

export function openIncident(i: { serviceId: string; probeId: string; title: string; symptom: string; severity?: string }): Incident {
  const row = {
    id: id("inc"),
    serviceId: i.serviceId,
    probeId: i.probeId,
    title: i.title,
    status: "open",
    severity: i.severity ?? "down",
    symptom: i.symptom,
    diagnosis: null,
    suspect: null,
    confidence: null,
    resolution: null,
    verifiedByReadingId: null,
    openedAt: now(),
    resolvedAt: null,
    downSeconds: null,
  } satisfies Incident;
  db.insert(incidents).values(row).run();
  return row;
}

export const getIncident = (iid: string): Incident | null => db.select().from(incidents).where(eq(incidents.id, iid)).get() ?? null;

/** The one open incident for a probe, if any. A probe has at most one at a time. */
export const openIncidentFor = (probeId: string): Incident | null =>
  db
    .select()
    .from(incidents)
    .where(and(eq(incidents.probeId, probeId), isNull(incidents.resolvedAt)))
    .orderBy(desc(incidents.openedAt))
    .get() ?? null;

export const openIncidents = (sid?: string): Incident[] =>
  db
    .select()
    .from(incidents)
    .where(sid ? and(eq(incidents.serviceId, sid), isNull(incidents.resolvedAt)) : isNull(incidents.resolvedAt))
    .orderBy(desc(incidents.openedAt))
    .all();

export const listIncidents = (sid: string, limit = 60): Incident[] =>
  db.select().from(incidents).where(eq(incidents.serviceId, sid)).orderBy(desc(incidents.openedAt)).limit(limit).all();

export const recentIncidents = (limit = 40): Incident[] => db.select().from(incidents).orderBy(desc(incidents.openedAt)).limit(limit).all();

export function updateIncident(iid: string, patch: Partial<Omit<Incident, "id" | "serviceId">>): void {
  db.update(incidents).set(patch).where(eq(incidents.id, iid)).run();
}

/**
 * An incident is resolved by a READING, never by an opinion. The caller passes the reading that
 * came back clean; this records it and works out how long the thing was actually down.
 */
export function resolveIncident(iid: string, reading: Reading, resolution: string): void {
  const inc = getIncident(iid);
  if (!inc) return;
  db.update(incidents)
    .set({
      status: "resolved",
      resolution,
      verifiedByReadingId: reading.id,
      resolvedAt: reading.at,
      downSeconds: Math.max(0, Math.round((reading.at - inc.openedAt) / 1000)),
    })
    .where(eq(incidents.id, iid))
    .run();
}

/* ── actions ──────────────────────────────────────────────────────── */

export function recordAction(a: {
  incidentId: string;
  serviceId: string;
  op: string;
  risk: string;
  input: unknown;
  intent?: string | null;
  verdict: string;
  rule: string;
  reason: string;
  command?: string | null;
  ok?: boolean | null;
  output?: string | null;
  exitCode?: number | null;
  ms?: number | null;
}): Action {
  const row = {
    id: id("act"),
    incidentId: a.incidentId,
    serviceId: a.serviceId,
    op: a.op,
    risk: a.risk,
    input: JSON.stringify(a.input ?? {}),
    intent: a.intent ?? null,
    verdict: a.verdict,
    rule: a.rule,
    reason: a.reason,
    command: a.command ?? null,
    ok: a.ok ?? null,
    output: a.output ?? null,
    exitCode: a.exitCode ?? null,
    ms: a.ms ?? null,
    at: now(),
  } satisfies Action;
  db.insert(actions).values(row).run();
  return row;
}

export const listActions = (iid: string): Action[] => db.select().from(actions).where(eq(actions.incidentId, iid)).orderBy(actions.at).all();

/** Acts that actually changed something, this incident. Reads do not count against the cap. */
export function changesMade(iid: string): number {
  const rows = db.select().from(actions).where(and(eq(actions.incidentId, iid), eq(actions.verdict, "allow"))).all();
  return rows.filter((r) => r.risk !== "read").length;
}

/** Minutes since Warden last changed anything on this service, or null if it never has. */
export function minutesSinceLastChange(sid: string): number | null {
  const row = db
    .select()
    .from(actions)
    .where(and(eq(actions.serviceId, sid), eq(actions.verdict, "allow")))
    .orderBy(desc(actions.at))
    .all()
    .find((r) => r.risk !== "read");
  return row ? Math.floor((now() - row.at) / 60_000) : null;
}

/* ── decisions ────────────────────────────────────────────────────── */

export function openDecision(d: {
  serviceId: string;
  incidentId?: string | null;
  interruptId?: string | null;
  kind: string;
  question: string;
  proposal?: string | null;
  because?: string | null;
  options: { value: string; label: string; tone?: string }[];
}): Decision {
  const row = {
    id: id("dec"),
    serviceId: d.serviceId,
    incidentId: d.incidentId ?? null,
    interruptId: d.interruptId ?? null,
    kind: d.kind,
    question: d.question,
    proposal: d.proposal ?? null,
    because: d.because ?? null,
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

export const getDecision = (did: string): Decision | null => db.select().from(decisions).where(eq(decisions.id, did)).get() ?? null;

export const pendingDecisions = (sid?: string): Decision[] =>
  db
    .select()
    .from(decisions)
    .where(sid ? and(eq(decisions.serviceId, sid), isNull(decisions.answeredAt)) : isNull(decisions.answeredAt))
    .orderBy(decisions.createdAt)
    .all();

export const decisionsFor = (iid: string): Decision[] => db.select().from(decisions).where(eq(decisions.incidentId, iid)).orderBy(decisions.createdAt).all();

export function answerDecision(did: string, answer: string, note?: string): Decision | null {
  db.update(decisions).set({ answer, answerNote: note ?? null, answeredAt: now() }).where(eq(decisions.id, did)).run();
  return getDecision(did);
}

export const markResumed = (did: string): void => void db.update(decisions).set({ resumedAt: now() }).where(eq(decisions.id, did)).run();

/** An open question about this exact operation on this incident — so it is never asked twice. */
export function findDecisionFor(incidentId: string, op: string): Decision | null {
  return (
    db
      .select()
      .from(decisions)
      .where(eq(decisions.incidentId, incidentId))
      .all()
      .find((d) => (d.proposal ?? "").startsWith(`${op}\n`)) ?? null
  );
}

/* ── standing rules and the journal ───────────────────────────────── */

export function addStanding(s: { serviceId: string; text: string; fromDecisionId?: string | null }): Standing {
  const row = { id: id("std"), serviceId: s.serviceId, text: s.text, fromDecisionId: s.fromDecisionId ?? null, createdAt: now() } satisfies Standing;
  db.insert(standing).values(row).run();
  return row;
}
export const listStanding = (sid: string): Standing[] => db.select().from(standing).where(eq(standing.serviceId, sid)).orderBy(standing.createdAt).all();

export function logEvent(serviceId: string, actor: string, kind: string, detail?: string, incidentId?: string | null): void {
  db.insert(events).values({ serviceId, actor, kind, detail: detail ?? null, incidentId: incidentId ?? null, createdAt: now() }).run();
}
export const listEvents = (sid: string, limit = 120): WardenEvent[] =>
  db.select().from(events).where(eq(events.serviceId, sid)).orderBy(desc(events.createdAt)).limit(limit).all();

/* ── the console, in one read ─────────────────────────────────────── */

export interface ServiceView {
  service: Service;
  probes: Probe[];
  /** the newest reading per probe */
  latest: Record<string, Reading | undefined>;
  open: Incident[];
  incidents: Incident[];
  pending: Decision[];
  standing: Standing[];
  /** uptime over the readings we hold, per probe */
  health: { probeId: string; ok: number; total: number };
}

export function serviceView(sid: string): ServiceView | null {
  const service = getService(sid);
  if (!service) return null;
  const ps = listProbes(sid);
  const latest: Record<string, Reading | undefined> = {};
  let ok = 0;
  let total = 0;
  for (const p of ps) {
    const rs = readingsFor(p.id, 200);
    latest[p.id] = rs[0];
    ok += rs.filter((r) => r.ok).length;
    total += rs.length;
  }
  return {
    service,
    probes: ps,
    latest,
    open: openIncidents(sid),
    incidents: listIncidents(sid),
    pending: pendingDecisions(sid),
    standing: listStanding(sid),
    health: { probeId: "", ok, total },
  };
}

export const parseOptions = (d: Decision): { value: string; label: string; tone?: string }[] => {
  try {
    const v = JSON.parse(d.options) as unknown;
    return Array.isArray(v) ? (v as { value: string; label: string; tone?: string }[]) : [];
  } catch {
    return [];
  }
};

export const parseSpec = (p: Probe): Record<string, unknown> => {
  try {
    return JSON.parse(p.spec) as Record<string, unknown>;
  } catch {
    return {};
  }
};
