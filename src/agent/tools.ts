import { ToolStreamEvent, tool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";
import { findDecisionFor, openDecision, parseUnknowns, recordCheck, recordFinding } from "@/lib/db/vigil";
import type { Thing } from "@/lib/db/schema";
import {
  cpscRecent,
  nhtsaComplaintsByVehicle,
  nhtsaRecallByCampaign,
  nhtsaRecallsByVehicle,
  openFdaEnforcement,
} from "@/lib/sources";
import type { CpscRecallRow, NhtsaComplaintRow, SourceResult } from "@/lib/sources/types";
import { checkKey, contextFor, type Candidate, type Cluster, type PassContext } from "./pass-context";

/**
 * The tools. Between them they hold every rule Vigil will not break, because a rule that lives only
 * in a system prompt is a wish. Three matter most:
 *
 *   A source call ALWAYS records a check — success or failure, with the URL and the row count —
 *   before the agent sees a single row. What the agent then does with the rows cannot change the
 *   record of what was asked.
 *
 *   A finding can only be built from a row that came back this pass. `rule_on_candidate` refuses a
 *   sourceId that is not in the candidate set, so the model cannot invent a recall even if it
 *   wants to, and `guards.ts` refuses it a second time at the hook layer.
 *
 *   Speaking to anyone outside this household — other parents, a federal agency — is never a tool
 *   the agent can simply call. It is an interrupt: the run stops and a human decides.
 */

const ctxOf = (c: ToolContext | undefined): PassContext => {
  const passId = (c?.invocationState as { passId?: string } | undefined)?.passId;
  if (!passId) throw new Error("tool called outside a pass");
  return contextFor(passId);
};

const thingOf = (ctx: PassContext, thingId: string): Thing => {
  const t = ctx.things.find((x) => x.id === thingId);
  if (!t) throw new Error(`no thing ${thingId} in this household`);
  return t;
};

const describe = (t: Thing): string =>
  [t.label, [t.year, t.make, t.model].filter(Boolean).join(" "), t.category, t.identifier ? `id ${t.identifier}` : null]
    .filter(Boolean)
    .join(" · ");

/** Every source call goes through here, so no path exists that queries without recording. */
function land<T>(ctx: PassContext, thingId: string, res: SourceResult<T>): void {
  ctx.done.add(checkKey(thingId, res.source));
  recordCheck({
    passId: ctx.passId,
    householdId: ctx.householdId,
    thingId,
    source: res.source,
    endpoint: res.endpoint,
    ok: res.ok,
    rowCount: res.rowCount,
    latencyMs: res.latencyMs,
    error: res.error ?? null,
  });
  ctx.emit({ kind: "check.done", thingId, source: res.source, ok: res.ok, rows: res.rowCount, ms: res.latencyMs, endpoint: res.endpoint, error: res.error });
}

/* ── reading the household ────────────────────────────────────────────────── */

export const listThings = tool({
  name: "list_things",
  description: "The things this household is watching, and the standing rules its owner has already given. Read this first.",
  inputSchema: z.object({}),
  callback: (_input, context) => {
    const ctx = ctxOf(context);
    return {
      things: ctx.things.map((t) => ({
        thingId: t.id,
        kind: t.kind,
        label: t.label,
        make: t.make,
        model: t.model,
        year: t.year,
        category: t.category,
        identifier: t.identifier,
        secondHand: t.secondHand,
        acquired: t.acquiredAt ? new Date(t.acquiredAt).toISOString().slice(0, 10) : null,
        unknown: parseUnknowns(t),
        note: t.note,
      })),
      standingRules: ctx.standing,
    };
  },
});

export const setPlan = tool({
  name: "set_plan",
  description: "Commit to which federal sources you will ask about each thing. Call this ONCE, covering every thing. Vigil holds you to it: any source you promised and did not ask is asked by the system afterwards and reported as a gap.",
  inputSchema: z.object({
    plan: z.array(
      z.object({
        thingId: z.string(),
        sources: z.array(z.enum(["nhtsa-recalls", "nhtsa-complaints", "cpsc-recalls", "openfda"])),
        terms: z.array(z.string()).describe("search words for cpsc-recalls / openfda: brand and product noun first"),
        why: z.string(),
      }),
    ),
  }),
  callback: (input, context) => {
    const ctx = ctxOf(context);
    ctx.expected = [];
    for (const p of input.plan) {
      const t = ctx.things.find((x) => x.id === p.thingId);
      if (!t) continue;
      for (const s of p.sources) ctx.expected.push({ thingId: p.thingId, source: s });
      ctx.terms.set(p.thingId, p.terms);
      ctx.emit({ kind: "plan", thingId: p.thingId, sources: p.sources, why: p.why });
    }
    return { accepted: ctx.expected.length, things: input.plan.length };
  },
});

export const listPlan = tool({
  name: "list_plan",
  description: "What this pass committed to check, for your lane only. Ask every source listed for every thing listed.",
  inputSchema: z.object({ lane: z.enum(["vehicle", "product", "ingestible"]) }),
  callback: (input, context) => {
    const ctx = ctxOf(context);
    const mine = ctx.expected.filter((e) => thingOf(ctx, e.thingId).kind === input.lane);
    const byThing = new Map<string, string[]>();
    for (const e of mine) byThing.set(e.thingId, [...(byThing.get(e.thingId) ?? []), e.source]);
    return {
      lane: input.lane,
      work: [...byThing].map(([thingId, sources]) => ({
        thingId,
        what: describe(thingOf(ctx, thingId)),
        sources,
        terms: ctx.terms.get(thingId) ?? [],
      })),
    };
  },
});

/* ── the sources ──────────────────────────────────────────────────────────── */

export const nhtsaRecalls = tool({
  name: "nhtsa_recalls",
  description: "Ask NHTSA for every open safety recall campaign on a vehicle, by make, model and year. Returns the manufacturer's own consequence and remedy text.",
  inputSchema: z.object({ thingId: z.string() }),
  callback: async function* (input, context) {
    const ctx = ctxOf(context);
    const t = thingOf(ctx, input.thingId);
    if (!t.make || !t.model || !t.year) return { error: "This vehicle has no make, model and year yet. It cannot be checked against NHTSA until it does." };
    yield new ToolStreamEvent({ data: { step: "nhtsa-recalls", thingId: t.id, what: describe(t) } });
    ctx.emit({ kind: "check.start", thingId: t.id, source: "nhtsa-recalls", endpoint: `api.nhtsa.gov/recalls/recallsByVehicle · ${t.year} ${t.make} ${t.model}` });
    const res = await nhtsaRecallsByVehicle({ make: t.make, model: t.model, modelYear: t.year });
    land(ctx, t.id, res);
    if (!res.ok) return { ok: false, error: res.error, note: "NHTSA did not answer. This vehicle is UNCHECKED, not clear." };

    // The units-affected figure only exists on the by-campaign endpoint. Fetch it for what we found
    // rather than leaving a hole a model might fill in.
    for (const r of res.rows) {
      const already = ctx.candidates.find((c) => c.sourceId === r.campaignNumber && c.thingId === t.id);
      if (already) continue;
      let units: number | null = null;
      const detail = await nhtsaRecallByCampaign(r.campaignNumber);
      if (detail.ok && detail.rows[0]?.potentialUnitsAffected != null) units = detail.rows[0].potentialUnitsAffected;
      ctx.candidates.push({
        sourceId: r.campaignNumber,
        source: "nhtsa-recalls",
        sourceUrl: r.sourceUrl,
        thingId: t.id,
        title: `${r.component ?? "Safety recall"} — ${r.manufacturer ?? "manufacturer"}`,
        summary: r.summary ?? "",
        consequence: r.consequence ?? null,
        remedy: r.remedy ?? null,
        component: r.component ?? null,
        unitsAffected: units,
        parkIt: r.parkIt,
        parkOutSide: r.parkOutSide,
        date: r.reportReceivedDate ?? null,
        raw: r.raw,
      });
    }
    return {
      ok: true,
      endpoint: res.endpoint,
      count: res.rowCount,
      campaigns: res.rows.map((r) => ({
        sourceId: r.campaignNumber,
        component: r.component,
        parkIt: r.parkIt,
        parkOutSide: r.parkOutSide,
        reportReceivedDate: r.reportReceivedDate,
        summary: r.summary,
        consequence: r.consequence,
        remedy: r.remedy,
      })),
    };
  },
});

/** Group complaints by the component NHTSA filed them under. Counting is code's job, not a model's. */
/* exported for testing — see src/agent/__tests__/cluster.test.ts */
export function clusterComplaints(thingId: string, rows: NhtsaComplaintRow[]): Cluster[] {
  const by = new Map<string, NhtsaComplaintRow[]>();
  for (const r of rows) {
    const key = (r.components ?? "UNSPECIFIED").split(",")[0]!.trim().toUpperCase();
    by.set(key, [...(by.get(key) ?? []), r]);
  }
  const parse = (d?: string): number | null => {
    if (!d) return null;
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(d);
    return m ? Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
  };
  return [...by]
    .map(([component, rs]) => {
      const dates = rs.map((r) => parse(r.dateOfIncident)).filter((n): n is number => n !== null).sort((a, b) => a - b);
      const withText = rs.find((r) => (r.summary ?? "").length > 60);
      return {
        key: `${thingId}:${component}`,
        thingId,
        component,
        count: rs.length,
        crashes: rs.filter((r) => r.crash).length,
        fires: rs.filter((r) => r.fire).length,
        injuries: rs.reduce((n, r) => n + (r.numberOfInjuries ?? 0), 0),
        deaths: rs.reduce((n, r) => n + (r.numberOfDeaths ?? 0), 0),
        firstAt: dates.length ? new Date(dates[0]!).toISOString().slice(0, 10) : null,
        lastAt: dates.length ? new Date(dates[dates.length - 1]!).toISOString().slice(0, 10) : null,
        odiNumbers: rs.slice(0, 40).map((r) => String(r.odiNumber)),
        quote: withText?.summary?.trim().slice(0, 400) ?? null,
        quoteOdi: withText ? String(withText.odiNumber) : null,
        timeline: dates,
      } satisfies Cluster;
    })
    .sort((a, b) => b.count - a.count);
}

export const nhtsaComplaints = tool({
  name: "nhtsa_complaints",
  description: "Ask NHTSA for owner complaints on a vehicle. These are strangers' own words, filed before any recall exists — the early signal. Vigil clusters them by component for you and counts them itself.",
  inputSchema: z.object({ thingId: z.string() }),
  callback: async function* (input, context) {
    const ctx = ctxOf(context);
    const t = thingOf(ctx, input.thingId);
    if (!t.make || !t.model || !t.year) return { error: "No make, model and year yet." };
    yield new ToolStreamEvent({ data: { step: "nhtsa-complaints", thingId: t.id } });
    ctx.emit({ kind: "check.start", thingId: t.id, source: "nhtsa-complaints", endpoint: `api.nhtsa.gov/complaints/complaintsByVehicle · ${t.year} ${t.make} ${t.model}` });
    const res = await nhtsaComplaintsByVehicle({ make: t.make, model: t.model, modelYear: t.year });
    land(ctx, t.id, res);
    if (!res.ok) return { ok: false, error: res.error, note: "UNCHECKED, not clear." };
    // A pattern is only interesting where NO recall exists yet: that is the whole point of reading
    // complaints. Components already covered by a campaign this pass are dropped, in code.
    const covered = ctx.candidates
      .filter((c) => c.thingId === t.id && c.source === "nhtsa-recalls")
      .map((c) => (c.component ?? "").split(":")[0]!.trim().toUpperCase())
      .filter(Boolean);
    const clusters = clusterComplaints(t.id, res.rows)
      .filter((c) => c.count >= 12 && c.component !== "UNKNOWN OR OTHER" && !covered.some((cv) => cv && c.component.startsWith(cv)))
      .slice(0, 2);
    ctx.clusters.push(...clusters.filter((c) => !ctx.clusters.some((x) => x.key === c.key)));
    for (const c of clusters) ctx.emit({ kind: "cluster", thingId: t.id, component: c.component, count: c.count });
    return {
      ok: true,
      endpoint: res.endpoint,
      complaints: res.rowCount,
      clusters: clusters.map((c) => ({
        clusterKey: c.key,
        component: c.component,
        count: c.count,
        crashes: c.crashes,
        fires: c.fires,
        injuries: c.injuries,
        deaths: c.deaths,
        span: c.firstAt && c.lastAt ? `${c.firstAt} → ${c.lastAt}` : null,
        exampleOdi: c.quoteOdi,
        exampleWords: c.quote,
      })),
    };
  },
});

/** Score a CPSC row against the search terms. Code narrows the corpus; the model judges the shortlist. */
/* exported for testing — see src/agent/__tests__/cluster.test.ts */
export function scoreCpsc(row: CpscRecallRow, terms: string[]): number {
  const hay = [row.title, row.description, ...row.products.map((p) => `${p.name ?? ""} ${p.model ?? ""} ${p.description ?? ""}`), ...row.manufacturers]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const raw of terms) {
    const term = raw.toLowerCase().trim();
    if (!term) continue;
    if (hay.includes(term)) score += term.includes(" ") ? 3 : 2;
    else {
      const words = term.split(/\s+/).filter((w) => w.length > 3);
      score += words.filter((w) => hay.includes(w)).length * 0.5;
    }
  }
  return score;
}

export const cpscSearch = tool({
  name: "cpsc_search",
  description: "Search the CPSC consumer-product recall corpus for a thing. Vigil loads the corpus and narrows it by word overlap; you are shown the closest records in full and you decide whether any of them is actually this object.",
  inputSchema: z.object({ thingId: z.string(), terms: z.array(z.string()).describe("brand and product noun first, e.g. ['graco 4ever', 'car seat', 'child restraint']") }),
  callback: async function* (input, context) {
    const ctx = ctxOf(context);
    const t = thingOf(ctx, input.thingId);
    const since = process.env.VIGIL_CPSC_SINCE ?? "2023-01-01";
    yield new ToolStreamEvent({ data: { step: "cpsc-corpus", thingId: t.id } });
    ctx.emit({ kind: "check.start", thingId: t.id, source: "cpsc-recalls", endpoint: `saferproducts.gov/RestWebServices/Recall · since ${since}` });
    const res = await cpscRecent(since);
    land(ctx, t.id, res);
    if (!res.ok) return { ok: false, error: res.error, note: "CPSC did not answer. UNCHECKED, not clear." };
    const terms = input.terms.length ? input.terms : [t.make, t.model, t.category, t.label].filter((x): x is string => !!x);
    yield new ToolStreamEvent({ data: { step: "cpsc-narrow", corpus: res.rowCount, terms } });
    const shortlist = res.rows
      .map((r) => ({ r, s: scoreCpsc(r, terms) }))
      .filter((x) => x.s >= 2)
      .sort((a, b) => b.s - a.s)
      .slice(0, 8);
    for (const { r } of shortlist) {
      if (ctx.candidates.some((c) => c.sourceId === r.recallNumber && c.thingId === t.id)) continue;
      ctx.candidates.push({
        sourceId: r.recallNumber,
        source: "cpsc-recalls",
        sourceUrl: r.url ?? r.sourceUrl,
        thingId: t.id,
        title: r.title ?? "CPSC recall",
        summary: r.description ?? "",
        consequence: r.hazards.map((h) => h.name).filter(Boolean).join("; ") || null,
        remedy: r.remedies.join("; ") || null,
        component: r.products[0]?.name ?? null,
        unitsAffected: null,
        date: r.recallDate ?? null,
        raw: r.raw,
      });
    }
    return {
      ok: true,
      endpoint: res.endpoint,
      corpusSize: res.rowCount,
      shown: shortlist.length,
      records: shortlist.map(({ r }) => ({
        sourceId: r.recallNumber,
        date: r.recallDate,
        title: r.title,
        description: r.description,
        products: r.products.map((p) => ({ name: p.name, model: p.model, units: p.numberOfUnits })),
        hazards: r.hazards.map((h) => h.name),
        remedies: r.remedies,
        injuries: r.injuries,
        url: r.url,
      })),
    };
  },
});

export const openFdaSearch = tool({
  name: "openfda_search",
  description: "Search FDA enforcement (recall) reports for a food, supplement, medicine or medical device. Returns the FDA's own classification and reason for recall.",
  inputSchema: z.object({ thingId: z.string(), terms: z.array(z.string()), area: z.enum(["food", "drug", "device"]).describe("food covers supplements") }),
  callback: async function* (input, context) {
    const ctx = ctxOf(context);
    const t = thingOf(ctx, input.thingId);
    yield new ToolStreamEvent({ data: { step: "openfda", thingId: t.id, area: input.area } });
    ctx.emit({ kind: "check.start", thingId: t.id, source: "openfda", endpoint: `api.fda.gov/${input.area}/enforcement.json · ${input.terms.join(" ")}` });
    const res = await openFdaEnforcement({ area: input.area, terms: input.terms, limit: 15 });
    land(ctx, t.id, res);
    if (!res.ok) return { ok: false, error: res.error, note: "UNCHECKED, not clear." };
    for (const r of res.rows) {
      if (ctx.candidates.some((c) => c.sourceId === r.recallNumber && c.thingId === t.id)) continue;
      ctx.candidates.push({
        sourceId: r.recallNumber,
        source: "openfda",
        sourceUrl: r.sourceUrl,
        thingId: t.id,
        title: r.productDescription?.slice(0, 140) ?? "FDA enforcement report",
        summary: r.productDescription ?? "",
        consequence: r.reasonForRecall ?? null,
        remedy: null,
        component: r.classification ?? null,
        unitsAffected: null,
        date: r.recallInitiationDate ?? null,
        raw: r.raw,
      });
    }
    return {
      ok: true,
      endpoint: res.endpoint,
      count: res.rowCount,
      records: res.rows.map((r) => ({
        sourceId: r.recallNumber,
        classification: r.classification,
        status: r.status,
        firm: r.recallingFirm,
        product: r.productDescription,
        reason: r.reasonForRecall,
        codeInfo: r.codeInfo,
        initiated: r.recallInitiationDate,
      })),
    };
  },
});

/* ── judgement ────────────────────────────────────────────────────────────── */

export const listCandidates = tool({
  name: "list_candidates",
  description: "Every government record the lanes pulled back this pass, grouped by the thing it might be about. Work through one thing at a time and rule on every record under it before moving on.",
  inputSchema: z.object({ thingId: z.string().nullable().describe("one thing's records only, or null for all of them") }),
  callback: (input, context) => {
    const ctx = ctxOf(context);
    const wanted = (id: string) => !input.thingId || input.thingId === id;
    const byThing = ctx.things
      .filter((t) => wanted(t.id))
      .map((t) => ({
        thingId: t.id,
        thing: describe(t),
        acquired: t.acquiredAt ? new Date(t.acquiredAt).toISOString().slice(0, 10) : null,
        secondHand: t.secondHand,
        unknown: parseUnknowns(t),
        records: ctx.candidates
          .filter((c) => c.thingId === t.id)
          .map((c) => ({
            sourceId: c.sourceId,
            source: c.source,
            ruled: ctx.ruled.get(`${t.id}::${c.sourceId}`) ?? null,
            title: c.title.slice(0, 160),
            record: c.summary.slice(0, 650),
            consequence: c.consequence?.slice(0, 300) ?? null,
            parkIt: c.parkIt,
            date: c.date,
          })),
        clusters: ctx.clusters
          .filter((c) => c.thingId === t.id)
          .map((c) => ({
            clusterKey: c.key,
            component: c.component,
            count: c.count,
            crashes: c.crashes,
            fires: c.fires,
            injuries: c.injuries,
            deaths: c.deaths,
            span: c.firstAt && c.lastAt ? `${c.firstAt} → ${c.lastAt}` : null,
            exampleWords: c.quote?.slice(0, 300) ?? null,
          })),
      }))
      .filter((t) => t.records.length > 0 || t.clusters.length > 0);
    return { things: byThing, standingRules: ctx.standing, stillUnruled: ctx.candidates.filter((c) => !ctx.ruled.has(`${c.thingId}::${c.sourceId}`)).length };
  },
});

export function ruleOnCandidateTool(canInterrupt: boolean) {
  return tool({
    name: "rule_on_candidate",
    description: canInterrupt
      ? "Your verdict on one government record against one thing. `unsure` STOPS THE RUN and puts your question to the owner; you will get their answer back and can finish the ruling."
      : "Your verdict on one government record against one thing. `covers` writes a finding the owner will see. `unsure` holds the record for the owner to be asked about — use it rather than guessing about a child's car seat.",
    inputSchema: z.object({
      thingId: z.string(),
      sourceId: z.string().describe("must be a record you were actually shown"),
      verdict: z.enum(["covers", "clear", "unsure"]),
      confidence: z.number().min(0).max(1).describe("how sure you are that this record is about THIS unit — not how sure you are of your verdict"),
      reason: z.string().describe("cite the fields you matched on, quoting the record"),
      severity: z.enum(["critical", "high", "watch"]).describe("critical only when the record itself says do-not-drive, fire, or serious injury or death"),
      missing: z.string().nullable().describe("if unsure: the ONE thing the owner would have to tell you"),
    }),
    callback: (input, context) => {
      const ctx = ctxOf(context);
      const cand = ctx.candidates.find((c) => c.sourceId === input.sourceId && c.thingId === input.thingId);
      // THE GATE. A record that did not come back from a real request this pass does not exist.
      if (!cand) {
        return {
          rejected: true,
          error: `No record ${input.sourceId} was returned for ${input.thingId} this pass. Vigil only writes findings from records it actually fetched. Rule on the records you were shown.`,
        };
      }
      const already = ctx.ruled.get(`${input.thingId}::${input.sourceId}`);
      if (already && already !== "unsure") {
        return { rejected: true, error: `${input.sourceId} has already been ruled "${already}" for this thing in this pass. A record gets one verdict. Rule on a record that has none.` };
      }
      ctx.ruled.set(`${input.thingId}::${input.sourceId}`, input.verdict);
      ctx.emit({ kind: "match", thingId: input.thingId, sourceId: input.sourceId, verdict: input.verdict, confidence: input.confidence, reason: input.reason });

      if (input.verdict === "clear") return { recorded: "clear" };

      let verdict = input.verdict;
      if (verdict === "unsure") {
        const question = input.missing?.trim() || `Does recall ${cand.sourceId} cover your ${thingOf(ctx, input.thingId).label}?`;
        if (!canInterrupt) {
          if (!ctx.held.some((h) => h.sourceId === input.sourceId && h.thingId === input.thingId)) {
            ctx.held.push({ thingId: input.thingId, sourceId: input.sourceId, question, reason: input.reason, severity: input.severity, confidence: input.confidence });
          }
          return { recorded: "held — Vigil will ask the owner before it says anything" };
        }
        // One question per record, ever. If it has already been answered, use the answer; if it is
        // still open, interrupt on the SAME decision rather than opening a second one.
        const existing = findDecisionFor(ctx.passId, input.thingId, input.sourceId);
        if (existing?.answer) {
          if (existing.answer !== "yes") return { recorded: "the owner has already said this is not theirs", answer: existing.answer };
          verdict = "covers";
        } else {
          const d =
            existing ??
            openDecision({
              householdId: ctx.householdId,
              passId: ctx.passId,
              thingId: input.thingId,
              sourceId: input.sourceId,
              kind: "identify",
              question,
              context: `${cand.title}\n\n${cand.summary}`.slice(0, 1200),
              options: [
                { value: "yes", label: "Yes", tone: "danger" },
                { value: "no", label: "No", tone: "quiet" },
                { value: "unknown", label: "I can't tell", tone: "quiet" },
              ],
            });
          if (!ctx.asked.some((a) => a.decisionId === d.id)) {
            ctx.asked.push({ decisionId: d.id, interruptId: null, question: d.question, thingId: input.thingId, sourceId: input.sourceId });
            ctx.emit({ kind: "decision", decisionId: d.id, question: d.question, interruptId: null });
          }
          const answer = context!.interrupt<string>({
            name: "identify",
            reason: { decisionId: d.id, question: d.question, thingId: input.thingId, sourceId: cand.sourceId, record: cand.summary.slice(0, 600) },
          });
          if (answer !== "yes") return { recorded: "the owner says it is not theirs", answer };
          verdict = "covers";
        }
      }

      const { finding, isNew } = recordFinding({
        householdId: ctx.householdId,
        thingId: input.thingId,
        passId: ctx.passId,
        kind: "recall",
        severity: cand.parkIt || cand.parkOutSide ? "critical" : input.severity,
        source: cand.source,
        sourceId: cand.sourceId,
        sourceUrl: cand.sourceUrl,
        title: cand.title,
        consequence: cand.consequence,
        remedy: cand.remedy,
        component: cand.component,
        unitsAffected: cand.unitsAffected,
        confidence: input.confidence,
        matchReason: input.reason,
        raw: cand.raw,
      });
      if (isNew) {
        ctx.wrote.push({ findingId: finding.id, sourceId: finding.sourceId, thingId: finding.thingId });
        ctx.emit({ kind: "finding", findingId: finding.id, thingId: finding.thingId, sourceId: finding.sourceId, severity: finding.severity, kind2: finding.kind, title: finding.title });
      }
      return { recorded: isNew ? "new finding" : "already known from an earlier pass", findingId: finding.id, verdict };
    },
  });
}

export const listHeld = tool({
  name: "list_held",
  description: "The records the match agent could not settle without asking the owner something. Ask about each one.",
  inputSchema: z.object({}),
  callback: (_input, context) => {
    const ctx = ctxOf(context);
    return {
      held: ctx.held.map((h) => {
        const cand = ctx.candidates.find((c) => c.sourceId === h.sourceId && c.thingId === h.thingId);
        return {
          thingId: h.thingId,
          thing: describe(thingOf(ctx, h.thingId)),
          sourceId: h.sourceId,
          question: h.question,
          why: h.reason,
          severity: h.severity,
          confidence: h.confidence,
          record: cand?.summary?.slice(0, 900),
          hazard: cand?.consequence,
        };
      }),
    };
  },
});

export const ruleOnPattern = tool({
  name: "rule_on_pattern",
  description: "Your verdict on a cluster of owner complaints with no recall behind it yet. `real` writes an amber finding — strangers describing the same failure on the owner's exact model.",
  inputSchema: z.object({
    clusterKey: z.string(),
    real: z.boolean().describe("true only when the complaints describe ONE failure mode, not a grab-bag"),
    failure: z.string().describe("the failure in plain words, drawn from the complaints themselves"),
    severity: z.enum(["critical", "high", "watch"]),
    reason: z.string(),
  }),
  callback: (input, context) => {
    const ctx = ctxOf(context);
    const cl = ctx.clusters.find((c) => c.key === input.clusterKey);
    if (!cl) return { rejected: true, error: `No cluster ${input.clusterKey} exists this pass.` };
    if (!input.real) return { recorded: "not a pattern" };
    const { finding, isNew } = recordFinding({
      householdId: ctx.householdId,
      thingId: cl.thingId,
      passId: ctx.passId,
      kind: "pattern",
      severity: input.severity,
      source: "nhtsa-complaints",
      sourceId: cl.key,
      sourceUrl: "https://www.nhtsa.gov/vehicle-safety/complaints",
      title: input.failure,
      consequence: `${cl.count} owner complaints filed with NHTSA${cl.crashes ? `, ${cl.crashes} involving a crash` : ""}${cl.fires ? `, ${cl.fires} involving fire` : ""}${cl.injuries ? `, ${cl.injuries} reported injuries` : ""}.`,
      remedy: null,
      component: cl.component,
      unitsAffected: null,
      confidence: 0.8,
      matchReason: input.reason,
      raw: cl,
    });
    if (isNew) {
      ctx.wrote.push({ findingId: finding.id, sourceId: finding.sourceId, thingId: finding.thingId });
      ctx.emit({ kind: "finding", findingId: finding.id, thingId: finding.thingId, sourceId: finding.sourceId, severity: finding.severity, kind2: finding.kind, title: finding.title });
    }
    return { recorded: isNew ? "new pattern" : "already known", findingId: finding.id };
  },
});

/* ── the two things Vigil may never do alone ──────────────────────────────── */

export const askOwner = tool({
  name: "ask_owner",
  description: "Stop the run and put one question to the owner. Use this — and only this — before anything leaves this household: telling other people who have the same object, or preparing a report to a federal agency. Never send, never file, never guess.",
  inputSchema: z.object({
    kind: z.enum(["notify_others", "file_report"]),
    findingId: z.string().nullable(),
    question: z.string().describe("one sentence, in plain words, that a tired person can answer"),
    context: z.string().describe("what you would send or file, verbatim, so they can see exactly what they are approving"),
  }),
  callback: (input, context) => {
    const ctx = ctxOf(context);
    const d = openDecision({
      householdId: ctx.householdId,
      passId: ctx.passId,
      findingId: input.findingId,
      kind: input.kind,
      question: input.question,
      context: input.context,
      options:
        input.kind === "notify_others"
          ? [
              { value: "send", label: "Send it", tone: "primary" },
              { value: "no", label: "Not now", tone: "quiet" },
            ]
          : [
              { value: "prepare", label: "Prepare the report for me", tone: "primary" },
              { value: "no", label: "No", tone: "quiet" },
            ],
    });
    const answer = context!.interrupt<string>({
      name: input.kind,
      reason: { decisionId: d.id, question: input.question, draft: input.context },
    });
    ctx.asked.push({ decisionId: d.id, interruptId: null, question: input.question, thingId: null, sourceId: null });
    ctx.emit({ kind: "decision", decisionId: d.id, question: input.question, interruptId: null });
    return { answer, note: answer === "send" || answer === "prepare" ? "The owner approved. Vigil prepares it for them to send; Vigil never sends it itself." : "The owner declined." };
  },
});

export const listFindings = tool({
  name: "list_findings",
  description: "What this pass found, so you can say it plainly.",
  inputSchema: z.object({}),
  callback: (_input, context) => {
    const ctx = ctxOf(context);
    return {
      found: ctx.wrote.length,
      findings: ctx.wrote.map((w) => {
        const c = ctx.candidates.find((x) => x.sourceId === w.sourceId);
        return { sourceId: w.sourceId, thing: describe(thingOf(ctx, w.thingId)), title: c?.title, consequence: c?.consequence, remedy: c?.remedy };
      }),
      checked: ctx.done.size,
      things: ctx.things.length,
    };
  },
});
