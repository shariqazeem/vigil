import type { Incident, Service } from "@/lib/db/schema";
import type { Policy } from "@/lib/ops/policy";

/**
 * What one incident knows while Warden is working on it.
 *
 * The agent's nodes do not hand each other prose. They read and write this, through tools, so the
 * evidence Warden cites is the evidence it actually collected, and the count of what it has already
 * changed — which the policy's cap depends on — is kept by the code rather than remembered by a
 * model.
 */

export interface Evidence {
  op: string;
  command: string;
  ok: boolean;
  summary: string;
  ms: number;
  at: number;
}

export interface IncidentContext {
  incidentId: string;
  serviceId: string;
  service: Service;
  incident: Incident;
  policy: Policy;
  standing: string[];
  /** everything Warden has looked at, in order */
  evidence: Evidence[];
  /** the origins this service actually owns — the only ones an http probe may be pointed at */
  allowedOrigins: string[];
  /** its account of the cause, once it commits to one */
  diagnosis: string | null;
  suspect: string | null;
  confidence: number | null;
  /** acts that changed the world, this incident. The cap counts these. */
  changes: number;
  /** decisions raised, so the same question is never asked twice */
  asked: { decisionId: string; interruptId: string | null; op: string }[];
  /** `op:args` signature → the toolUseId that first attempted it. A second, DIFFERENT call with
   *  the same signature is refused; the call that created the entry is not refused by its own entry. */
  attempted: Map<string, string>;
  /** operations refused on this incident — they cannot be re-attempted by another route */
  refused: Set<string>;
  /** set when Warden decides it cannot finish this alone */
  gaveUp: string | null;
  emit: (e: WardenEmit) => void;
}

/** What the console is told, as it happens. Every one is caused by something real. */
export type WardenEmit =
  | { kind: "run.start"; incidentId: string; service: string; title: string; model: string }
  | { kind: "node.start"; node: string; label: string }
  | { kind: "node.done"; node: string; ms: number; status: string }
  | { kind: "probe.start"; serviceId: string; probeId: string; label: string; command: string }
  | { kind: "probe.done"; serviceId: string; probeId: string; label: string; ok: boolean; detail: string; ms: number }
  | { kind: "incident.open"; incidentId: string; serviceId: string; title: string; symptom: string }
  | { kind: "incident.resolved"; incidentId: string; serviceId: string; downSeconds: number; resolution: string }
  | { kind: "sweep.note"; message: string }
  | { kind: "look"; op: string; command: string; why: string }
  | { kind: "looked"; op: string; ok: boolean; summary: string; ms: number }
  | { kind: "diagnosis"; text: string; suspect: string | null; confidence: number }
  | { kind: "policy"; op: string; verdict: "allow" | "ask" | "refuse"; rule: string; reason: string }
  | { kind: "act"; op: string; command: string; why: string }
  | { kind: "acted"; op: string; ok: boolean; summary: string; ms: number }
  | { kind: "verify"; label: string; ok: boolean; detail: string }
  | { kind: "decision"; decisionId: string; question: string; proposal: string | null; because: string | null; interruptId: string | null }
  | { kind: "run.done"; incidentId: string; status: string; downSeconds: number | null; summary: string }
  | { kind: "error"; message: string };

const live = new Map<string, IncidentContext>();

export function openContext(ctx: Omit<IncidentContext, "evidence" | "diagnosis" | "suspect" | "confidence" | "changes" | "asked" | "gaveUp" | "attempted" | "refused">): IncidentContext {
  const full: IncidentContext = { ...ctx, evidence: [], diagnosis: null, suspect: null, confidence: null, changes: 0, asked: [], attempted: new Map(), refused: new Set(), gaveUp: null };
  live.set(ctx.incidentId, full);
  return full;
}

export function contextFor(incidentId: string): IncidentContext {
  const c = live.get(incidentId);
  if (!c) throw new Error(`no live incident ${incidentId}`);
  return c;
}

export const closeContext = (incidentId: string): void => void live.delete(incidentId);
export const hasContext = (incidentId: string): boolean => live.has(incidentId);
