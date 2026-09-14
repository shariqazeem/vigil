import type { Thing } from "@/lib/db/schema";

/**
 * What one pass knows while it is running.
 *
 * The graph's nodes do not hand each other prose. Each node reads and writes THIS, through tools,
 * so nothing important survives only as a sentence in a model's output. Two properties matter:
 *
 *   `candidates` is the ONLY set of rows a finding may be built from. Every row in it came back
 *   from a real HTTP response this pass, with the URL it came from. The record_finding hook
 *   refuses any sourceId that is not in here, which is why the agent cannot invent a recall.
 *
 *   `expected` is what the pass PROMISED to check. After the graph finishes, code compares it to
 *   the checks actually recorded and does the missing ones itself. The agent chooses how to look;
 *   the code guarantees that it looked.
 */

export interface Candidate {
  /** the government's own id: NHTSACampaignNumber, CPSC RecallNumber, odiNumber, openFDA recall_number */
  sourceId: string;
  source: string;
  sourceUrl: string | null;
  thingId: string;
  title: string;
  summary: string;
  consequence: string | null;
  remedy: string | null;
  component: string | null;
  unitsAffected: number | null;
  /** government-set danger flags, when the source has them */
  parkIt?: boolean;
  parkOutSide?: boolean;
  date: string | null;
  raw: unknown;
}

export interface Cluster {
  key: string;
  thingId: string;
  component: string;
  count: number;
  crashes: number;
  fires: number;
  injuries: number;
  deaths: number;
  firstAt: string | null;
  lastAt: string | null;
  odiNumbers: string[];
  quote: string | null;
  quoteOdi: string | null;
  /** one point per real complaint, sorted — the sparkline's only source */
  timeline: number[];
}

export interface ExpectedCheck {
  thingId: string;
  source: string;
}

export interface PassContext {
  passId: string;
  householdId: string;
  things: Thing[];
  standing: string[];
  /** what triage said it would look at */
  expected: ExpectedCheck[];
  /** the search words triage chose per thing — the product lane's real model contribution */
  terms: Map<string, string[]>;
  /** every (thing, source) the tools actually completed */
  done: Set<string>;
  candidates: Candidate[];
  clusters: Cluster[];
  /** every candidate the match agent has ruled on: `thingId::sourceId` → verdict */
  ruled: Map<string, string>;
  /** rulings the match agent could not settle — each one becomes a real halt in the adjudicator */
  held: { thingId: string; sourceId: string; question: string; reason: string; severity: string; confidence: number }[];
  /** findings written this pass, so brief can talk about them without re-reading the DB */
  wrote: { findingId: string; sourceId: string; thingId: string }[];
  /** decisions the agent raised — each one is a real Strands interrupt */
  asked: { decisionId: string; interruptId: string | null; question: string; thingId: string | null; sourceId: string | null }[];
  emit: (e: PassEmit) => void;
}

/** What the board is told, as it happens. Every one of these is caused by something real. */
export type PassEmit =
  | { kind: "pass.start"; passId: string; things: number; model: string }
  | { kind: "node.start"; node: string; label: string }
  | { kind: "node.done"; node: string; ms: number; status: string }
  | { kind: "plan"; thingId: string; sources: string[]; why: string }
  | { kind: "check.start"; thingId: string; source: string; endpoint: string }
  | { kind: "check.done"; thingId: string; source: string; ok: boolean; rows: number; ms: number; endpoint: string; error?: string }
  | { kind: "thinking"; node: string; text: string }
  | { kind: "match"; thingId: string; sourceId: string; verdict: "covers" | "clear" | "unsure"; confidence: number; reason: string }
  | { kind: "finding"; findingId: string; thingId: string; sourceId: string; severity: string; kind2: string; title: string }
  | { kind: "cluster"; thingId: string; component: string; count: number }
  | { kind: "decision"; decisionId: string; question: string; interruptId: string | null }
  | { kind: "pass.done"; passId: string; status: string; findings: number; rows: number; ms: number; unchecked: number }
  | { kind: "error"; message: string };

const live = new Map<string, PassContext>();

export function openContext(ctx: Omit<PassContext, "done" | "candidates" | "clusters" | "wrote" | "asked" | "terms" | "held" | "ruled">): PassContext {
  const full: PassContext = { ...ctx, terms: new Map(), done: new Set(), candidates: [], clusters: [], ruled: new Map(), held: [], wrote: [], asked: [] };
  live.set(ctx.passId, full);
  return full;
}

export function contextFor(passId: string): PassContext {
  const c = live.get(passId);
  if (!c) throw new Error(`no live pass ${passId}`);
  return c;
}

export function closeContext(passId: string): void {
  live.delete(passId);
}

/** The part of a halted pass that has to outlive the process it started in. */
export interface StoredContext {
  standing: string[];
  expected: ExpectedCheck[];
  terms: [string, string[]][];
  done: string[];
  ruled: [string, string][];
  candidates: Candidate[];
  clusters: Cluster[];
  held: PassContext["held"];
  wrote: PassContext["wrote"];
  asked: PassContext["asked"];
}

export function freeze(ctx: PassContext): StoredContext {
  return {
    standing: ctx.standing,
    expected: ctx.expected,
    terms: [...ctx.terms],
    done: [...ctx.done],
    ruled: [...ctx.ruled],
    candidates: ctx.candidates,
    clusters: ctx.clusters,
    held: ctx.held,
    wrote: ctx.wrote,
    asked: ctx.asked,
  };
}

export function thaw(passId: string, householdId: string, things: Thing[], stored: StoredContext, emit: (e: PassEmit) => void): PassContext {
  const ctx: PassContext = {
    passId,
    householdId,
    things,
    standing: stored.standing,
    expected: stored.expected,
    terms: new Map(stored.terms),
    done: new Set(stored.done),
    ruled: new Map(stored.ruled),
    candidates: stored.candidates,
    clusters: stored.clusters,
    held: stored.held,
    wrote: stored.wrote,
    asked: stored.asked,
    emit,
  };
  live.set(passId, ctx);
  return ctx;
}

export const checkKey = (thingId: string, source: string) => `${thingId}::${source}`;

/** Records the agent pulled back and then never ruled on. Silence about one of these is the
 *  failure mode that matters: a recall fetched, seen, and quietly dropped. */
export function unruled(ctx: PassContext): Candidate[] {
  return ctx.candidates.filter((c) => !ctx.ruled.has(`${c.thingId}::${c.sourceId}`));
}

/** What triage promised but the lanes never actually asked. The gap the code closes itself. */
export function missingChecks(ctx: PassContext): ExpectedCheck[] {
  return ctx.expected.filter((e) => !ctx.done.has(checkKey(e.thingId, e.source)));
}
