import {
  consecutiveFailures,
  getProbe,
  listProbes,
  logEvent,
  openIncident,
  openIncidentFor,
  parseSpec,
  recordReading,
  resolveIncident,
  targetOf,
  touchService,
} from "@/lib/db/warden";
import type { Incident, Probe, Reading, Service } from "@/lib/db/schema";
import { execute, type OperationName } from "./operations";

/**
 * THE SWEEP. Asking every service whether it is alright, on a clock, with no model involved.
 *
 * Nothing here reasons. A probe is a question with a right answer, and the answer is written down
 * whether or not anybody is watching — which is the point, because the claim Warden makes most
 * often is "it has been fine", and that claim needs a row behind it.
 *
 * An incident opens when a probe has failed `failuresToOpen` times in a row, so one blip is not an
 * outage. It closes when the SAME probe comes back clean, and only then: a fix that nobody
 * re-checked is a story, not a fix.
 */

export type SweepEmit =
  | { kind: "probe.start"; serviceId: string; probeId: string; label: string; command: string }
  | { kind: "probe.done"; serviceId: string; probeId: string; label: string; ok: boolean; detail: string; ms: number }
  | { kind: "incident.open"; incidentId: string; serviceId: string; title: string; symptom: string }
  | { kind: "incident.resolved"; incidentId: string; serviceId: string; downSeconds: number; resolution: string }
  | { kind: "sweep.note"; message: string };

const noop = () => {};

/** The operation a probe runs, and the arguments it runs with. */
function operationFor(probe: Probe, service: Service): { op: OperationName; input: Record<string, unknown> } {
  const spec = parseSpec(probe);
  if (probe.kind === "http") return { op: "http_probe", input: spec };
  if (probe.kind === "process") return { op: "pm2_list", input: {} };
  throw new Error(`unknown probe kind "${probe.kind}" on ${service.name}`);
}

/** For a process probe, the answer is in the jlist: is the named process online? */
function readProcess(probe: Probe, data: unknown): { ok: boolean; detail: string } {
  const want = String(parseSpec(probe).process ?? "");
  const rows = Array.isArray(data) ? (data as { name: string; status: string; restarts: number }[]) : [];
  const row = rows.find((r) => r.name === want);
  if (!row) return { ok: false, detail: `pm2 has no process called "${want}"` };
  return {
    ok: row.status === "online",
    detail: row.status === "online" ? `online, ${row.restarts} restart${row.restarts === 1 ? "" : "s"} since deploy` : `pm2 says "${row.status}"`,
  };
}

/** Ask one probe once, and write down what it said. */
export async function runProbe(service: Service, probe: Probe, opts: { incidentId?: string; emit?: (e: SweepEmit) => void } = {}): Promise<Reading> {
  const emit = opts.emit ?? noop;
  const { op, input } = operationFor(probe, service);
  const target = targetOf(service);

  emit({ kind: "probe.start", serviceId: service.id, probeId: probe.id, label: probe.label, command: probe.kind === "http" ? String(input.url ?? "") : `pm2 · ${service.process ?? ""}` });

  const res = await execute(op, input, target);
  const verdict =
    probe.kind === "process"
      ? res.ok
        ? readProcess(probe, res.data)
        : { ok: false, detail: res.error ?? "pm2 did not answer" }
      : { ok: res.ok, detail: res.ok ? res.stdout || "ok" : res.stdout || res.error || "no answer" };

  const reading = recordReading({
    probeId: probe.id,
    serviceId: service.id,
    ok: verdict.ok,
    detail: verdict.detail.slice(0, 400),
    latencyMs: res.ms,
    incidentId: opts.incidentId ?? null,
  });

  emit({ kind: "probe.done", serviceId: service.id, probeId: probe.id, label: probe.label, ok: reading.ok, detail: reading.detail, ms: res.ms });
  return reading;
}

/**
 * Re-ask exactly the question that failed. This is the only thing that closes an incident, and it
 * is deliberately not a model's judgement — it is the same probe, the same expectation, run again.
 */
export async function verifyIncident(service: Service, incident: Incident, emit?: (e: SweepEmit) => void): Promise<Reading | null> {
  const probe = getProbe(incident.probeId);
  if (!probe) return null;
  return runProbe(service, probe, { incidentId: incident.id, emit });
}

export interface SweepResult {
  readings: Reading[];
  opened: Incident[];
  resolved: Incident[];
}

/** One pass over one service: every enabled probe, then the incident bookkeeping. */
export async function sweepService(service: Service, emit: (e: SweepEmit) => void = noop): Promise<SweepResult> {
  const out: SweepResult = { readings: [], opened: [], resolved: [] };
  const ps = listProbes(service.id);
  if (ps.length === 0) {
    emit({ kind: "sweep.note", message: `${service.name} has no probes, so there is nothing Warden can honestly say about it.` });
    return out;
  }

  for (const probe of ps) {
    const reading = await runProbe(service, probe, { emit });
    out.readings.push(reading);
    const existing = openIncidentFor(probe.id);

    if (reading.ok) {
      if (existing) {
        // It is back. Only a clean reading of the same probe can say so.
        resolveIncident(existing.id, reading, "The probe that failed came back clean.");
        logEvent(service.id, "verify", "incident.resolved", `${probe.label}: ${reading.detail}`, existing.id);
        const downSeconds = Math.max(0, Math.round((reading.at - existing.openedAt) / 1000));
        emit({ kind: "incident.resolved", incidentId: existing.id, serviceId: service.id, downSeconds, resolution: reading.detail });
        out.resolved.push(existing);
      }
      continue;
    }

    if (existing) continue; // already being handled

    const failures = consecutiveFailures(probe.id);
    if (failures < probe.failuresToOpen) {
      emit({ kind: "sweep.note", message: `${probe.label} failed (${failures}/${probe.failuresToOpen}). One blip is not an outage; waiting for the next look.` });
      continue;
    }

    const incident = openIncident({
      serviceId: service.id,
      probeId: probe.id,
      title: `${service.name}: ${probe.label} is failing`,
      symptom: reading.detail,
      severity: probe.kind === "http" ? "down" : "down",
    });
    logEvent(service.id, "sweep", "incident.open", `${probe.label}: ${reading.detail}`, incident.id);
    emit({ kind: "incident.open", incidentId: incident.id, serviceId: service.id, title: incident.title, symptom: reading.detail });
    out.opened.push(incident);
  }

  touchService(service.id, { lastSweptAt: Date.now() });
  return out;
}
