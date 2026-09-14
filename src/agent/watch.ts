import { AfterInvocationEvent, Agent, InterruptResponseContent, SessionManager, type AgentResult } from "@strands-agents/sdk";
import { Graph, BeforeNodeCallEvent, NodeResultEvent, type MultiAgentStreamEvent } from "@strands-agents/sdk/multiagent";
import { LocalFileStorage } from "@strands-agents/sdk/storage";
import { join } from "node:path";
import {
  answerDecision,
  addStanding,
  finishPass,
  getDecision,
  getHousehold,
  getPass,
  listStanding,
  listThings,
  markResumed,
  logEvent,
  savePassContext,
  recordCheck,
  startPass,
} from "@/lib/db/vigil";
import { cpscRecent, nhtsaComplaintsByVehicle, nhtsaRecallsByVehicle, openFdaEnforcement } from "@/lib/sources";
import type { NhtsaRecallRow } from "@/lib/sources/types";
import type { Thing } from "@/lib/db/schema";
import { makeModel, modelLabel, retryStrategy } from "./model";
import { NothingLeavesTheHouse, VigilGuards } from "./guards";
import { Throttled } from "./throttle";
import { checkKey, closeContext, contextFor, freeze, missingChecks, openContext, thaw, unruled, type PassContext, type PassEmit, type StoredContext } from "./pass-context";
import { recorder } from "./recording";
import {
  askOwner,
  cpscSearch,
  listCandidates,
  listFindings,
  listPlan,
  listThings as listThingsTool,
  nhtsaComplaints,
  nhtsaRecalls,
  openFdaSearch,
  ruleOnCandidateTool,
  ruleOnPattern,
  setPlan,
} from "./tools";

/**
 * THE PASS. What Vigil does at three in the morning when nobody is watching.
 *
 * It is a Strands `Graph`: triage decides which federal source can possibly know about each thing,
 * three lanes then ask those sources in parallel, and a conditional edge sends whatever came back
 * to a match agent — the only genuinely hard piece of thinking here, because a recall notice names
 * a model range and a date window, not your serial number.
 *
 * Two things sit deliberately outside the model's control. Afterwards, code compares what triage
 * PROMISED to check against what was actually asked, and asks the rest itself: a source the agent
 * forgot is a hole in a safety net, so the net closes it. And a question the match agent could not
 * settle is not smoothed over — it becomes a real interrupt, the run genuinely halts, and it stays
 * halted in the database until a human answers it.
 */

const SESSIONS = process.env.VIGIL_SESSION_DIR ?? join(process.cwd(), "var", "sessions");

/** Strands session ids are lowercase, digits, hyphen and underscore only. */
const sessionIdFor = (passId: string) => `pass-${passId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;

const TRIAGE_PROMPT = `You are Vigil's triage. You are given the things in one household and you decide, for each, which US federal safety source could possibly know something about it.

  nhtsa-recalls      vehicles only — needs make, model and model year
  nhtsa-complaints   vehicles only — owner-filed reports, the signal before a recall exists
  cpsc-recalls       consumer products: cots, car seats, strollers, heaters, toys, furniture, appliances
  openfda            anything eaten, swallowed, applied or implanted: food, supplements, medicine, devices

Call list_things, then call set_plan ONCE for every thing. For cpsc-recalls and openfda also give the search
words most likely to appear in an actual recall notice for that object — the brand first, then the product
noun a regulator would use ("child restraint", not "baby chair"). Two to four terms. If a thing cannot be
checked anywhere yet, still include it with an empty source list and say why in one clause.

Be complete. A thing you leave out is a thing nobody is watching.`;

const LANE_PROMPTS: Record<string, string> = {
  vehicle: `You are Vigil's vehicle lane. Call list_plan with lane "vehicle". For every thing listed, call
nhtsa_recalls, and call nhtsa_complaints when the plan asks for it. Ask about every thing — never skip one
because another looked similar. Then stop and report, in one line, how many campaigns and complaints came
back. Do not judge whether anything applies; that is the match agent's job.`,
  product: `You are Vigil's consumer-product lane. Call list_plan with lane "product". For every thing listed,
call cpsc_search with the terms in the plan. If the shortlist comes back empty, try ONCE more with broader
terms — the product noun alone. Then stop and report the corpus size and how many records you surfaced.
Do not judge whether anything applies; that is the match agent's job.`,
  ingestible: `You are Vigil's food-and-medicine lane. Call list_plan with lane "ingestible". For every thing
listed, call openfda_search with the right area (food covers supplements). Then stop and report what came
back. Do not judge whether anything applies.`,
};

const MATCH_PROMPT = `You are Vigil's match agent, and you are the reason this product can be trusted.

Call list_candidates. You will see government records that came back this pass, each next to the household
thing it MIGHT be about, and clusters of owner complaints with no recall behind them yet.

For every record, call rule_on_candidate exactly once:
  covers  — this record is about this exact unit. Quote the fields that line up: the model name, the year
            range, the date window, the component.
  clear   — it is not. Say what does not line up.
  unsure  — you cannot tell without knowing something the owner has not told you. This is the RIGHT answer
            whenever a recall names a manufacture-date window, a serial range or a trim the owner has not
            given you. Put the ONE question you would need answered in "missing", in plain words.

Then for every complaint cluster, call rule_on_pattern once. A cluster is real only when the complaints
describe ONE failure, not a grab-bag of unrelated gripes.

Rules you cannot talk your way past, because they are enforced in code:
  · You may only rule on records you were actually shown. There is no other source of truth.
  · A "covers" verdict below 60% confidence is refused. Rule "unsure" and ask instead.
  · "critical" severity is refused unless the record's own words carry it — a do-not-drive flag, or death,
    serious injury, fire or a crash. Do not escalate a tone.
  · Never restate a hazard in your own words when the record has its own. Quote it.

Standing rules from the owner are in list_candidates. Obey them: if they have already told you a thing is
not theirs, do not ask again.`;

const ASK_PROMPT = `You are Vigil at the moment it has to wake somebody up.

You will be told about exactly one government record that could not be settled without asking the owner
one thing. Call rule_on_candidate with that thingId and sourceId, verdict "unsure", and the question in
"missing". Nothing else. Do not explain, do not summarise, do not answer in prose.

The question is answered by tapping one of three buttons: YES, NO, or "I can't tell". So it must be a
yes/no question — never an open one. Not "what is the date on the label?" but "Is the date on the label
under the top panel between 09/2023 and 12/2025?".

One short sentence a tired person can answer while standing in the room, and it must quote the record's own
words about where to look — the label under the top panel, the model number on the back, the date code.
Never ask them to know something the record does not tell them how to find.`;

const BRIEF_PROMPT = `You are Vigil, telling the owner what this pass found.

Call list_findings. Then say, in TWO SENTENCES, in the second person, what you found and what to do about
it. Use the government's own words for the hazard and give the remedy the record gives, including a phone
number if it has one. No preamble, no "I have completed", no lists.

You may only describe findings that list_findings returned. Do not mention a recall that is not in that
list, however sure you are that you saw one — if it is not there, it was not confirmed.

If a confirmed finding is on something other people also have — a thing that was handed down, or shared
with a group — you may call ask_owner with kind "notify_others" and the exact words you would send. You
never send anything yourself.`;

/* ── the graph ────────────────────────────────────────────────────────────── */

function laneAgent(kind: "vehicle" | "product" | "ingestible", passId: string): Agent {
  const tools =
    kind === "vehicle" ? [listPlan, nhtsaRecalls, nhtsaComplaints] : kind === "product" ? [listPlan, cpscSearch] : [listPlan, openFdaSearch];
  return new Agent({
    id: `${kind}_watch`,
    name: `${kind} watch`,
    description: `Asks the federal sources that cover ${kind}s.`,
    model: makeModel("watch").instance,
    systemPrompt: LANE_PROMPTS[kind]!,
    tools,
    retryStrategy: retryStrategy(),
    plugins: [new VigilGuards(), new Throttled()],
    interventions: [new NothingLeavesTheHouse()],
    appState: { passId },
    traceAttributes: { "vigil.node": `${kind}_watch`, "vigil.pass_id": passId },
    printer: false,
  });
}

function buildGraph(passId: string, householdId: string): Graph {
  const triage = new Agent({
    id: "triage",
    name: "Triage",
    description: "Decides which federal source can know about each thing.",
    model: makeModel("triage").instance,
    systemPrompt: TRIAGE_PROMPT,
    tools: [listThingsTool, setPlan],
    retryStrategy: retryStrategy(),
    plugins: [new Throttled()],
    appState: { passId },
    traceAttributes: { "vigil.node": "triage", "vigil.pass_id": passId },
    printer: false,
  });

  const match = new Agent({
    id: "match",
    name: "Match",
    description: "Decides whether a government record is about YOUR unit.",
    model: makeModel("match").instance,
    systemPrompt: MATCH_PROMPT,
    tools: [listCandidates, ruleOnCandidateTool(false), ruleOnPattern],
    retryStrategy: retryStrategy(),
    plugins: [new VigilGuards(), new Throttled()],
    interventions: [new NothingLeavesTheHouse()],
    appState: { passId },
    traceAttributes: { "vigil.node": "match", "vigil.pass_id": passId },
    printer: false,
  });

  /** A lane only runs when triage actually planned work for it — read live, after triage returns. */
  const laneWanted = (kind: string) => () => {
    try {
      const ctx = contextFor(passId);
      return ctx.expected.some((e) => ctx.things.find((t) => t.id === e.thingId)?.kind === kind);
    } catch {
      return false;
    }
  };

  return new Graph({
    id: "vigil-pass",
    nodes: [triage, laneAgent("vehicle", passId), laneAgent("product", passId), laneAgent("ingestible", passId), match],
    edges: [
      { source: "triage", target: "vehicle_watch", handler: laneWanted("vehicle") },
      { source: "triage", target: "product_watch", handler: laneWanted("product") },
      { source: "triage", target: "ingestible_watch", handler: laneWanted("ingestible") },
      // the conditional edge that matters: judgement only runs when there is something to judge
      { source: "vehicle_watch", target: "match", handler: () => hasCandidates(passId) },
      { source: "product_watch", target: "match", handler: () => hasCandidates(passId) },
      { source: "ingestible_watch", target: "match", handler: () => hasCandidates(passId) },
    ],
    maxConcurrency: 3,
    maxSteps: 24,
    timeout: 1_500_000,
    nodeTimeout: 420_000,
    traceAttributes: { "vigil.pass_id": passId, "vigil.household_id": householdId },
  });
}

const hasCandidates = (passId: string): boolean => {
  try {
    const c = contextFor(passId);
    return c.candidates.length > 0 || c.clusters.length > 0;
  } catch {
    return false;
  }
};

const NODE_LABEL: Record<string, string> = {
  triage: "Working out who could know",
  vehicle_watch: "Asking NHTSA",
  product_watch: "Reading the CPSC recall corpus",
  ingestible_watch: "Asking the FDA",
  match: "Deciding whether any of it is yours",
};

function matchAgent(passId: string, householdId: string): Agent {
  return new Agent({
    id: "match",
    name: "Match",
    description: "Decides whether a government record is about YOUR unit.",
    model: makeModel("match").instance,
    systemPrompt: MATCH_PROMPT,
    tools: [listCandidates, ruleOnCandidateTool(false), ruleOnPattern],
    retryStrategy: retryStrategy(),
    plugins: [new VigilGuards(), new Throttled()],
    interventions: [new NothingLeavesTheHouse()],
    appState: { passId },
    traceAttributes: { "vigil.node": "match", "vigil.pass_id": passId, "vigil.household_id": householdId },
    printer: false,
  });
}

/**
 * A record that came back and was never ruled on is the quiet failure this product cannot have:
 * fetched, seen, dropped. Code counts them and sends them back, named, until none are left.
 */
async function closeTheVerdicts(ctx: PassContext, householdId: string, send: (e: PassEmit) => void): Promise<number> {
  const total = unruled(ctx).length;
  for (let round = 0; round < 3; round += 1) {
    const left = unruled(ctx);
    if (left.length === 0) break;
    const byThing = new Map<string, typeof left>();
    for (const c of left) byThing.set(c.thingId, [...(byThing.get(c.thingId) ?? []), c]);
    send({ kind: "node.start", node: "match", label: `${left.length} record${left.length === 1 ? "" : "s"} still unruled — asking again, one thing at a time` });
    const t = Date.now();
    await Promise.all(
      [...byThing].map(async ([thingId, records]) => {
        const thing = ctx.things.find((x) => x.id === thingId);
        const list = records
          .map((c) => `- sourceId ${c.sourceId} · ${c.title.slice(0, 140)}\n  ${c.summary.slice(0, 650)}`)
          .join("\n");
        try {
          await matchAgent(ctx.passId, householdId).invoke(
            `Rule on these records against ONE thing: ${thing?.label} (${[thing?.year, thing?.make, thing?.model].filter(Boolean).join(" ")}).\n` +
              `Call rule_on_candidate once for EACH record below, with thingId "${thingId}" and the sourceId given. Rule on all ${records.length}. Nothing else.\n\n${list}`,
            { invocationState: { passId: ctx.passId, householdId } },
          );
        } catch (e) {
          send({ kind: "error", message: `Could not get a ruling on ${thing?.label}: ${e instanceof Error ? e.message : String(e)}` });
        }
      }),
    );
    send({ kind: "node.done", node: "match", ms: Date.now() - t, status: "COMPLETED" });
  }

  // Whatever is still unruled is HELD, never dropped. Silence about a fetched record is the one
  // outcome this product may not have.
  for (const c of unruled(ctx)) {
    const label = ctx.things.find((t) => t.id === c.thingId)?.label ?? "this thing";
    send({ kind: "match", thingId: c.thingId, sourceId: c.sourceId, verdict: "unsure", confidence: 0, reason: "Vigil could not get a ruling on this record, so it is held for you rather than dropped." });
    if (!ctx.held.some((h) => h.sourceId === c.sourceId && h.thingId === c.thingId)) {
      ctx.held.push({ thingId: c.thingId, sourceId: c.sourceId, question: `Vigil could not decide whether ${c.sourceId} is about your ${label}. Is it?`, reason: "no ruling", severity: "high", confidence: 0 });
    }
  }
  return total;
}

/* ── the adjudicator: the part that stops ─────────────────────────────────── */

/**
 * The agent that asks. It gets ONE tool, so the only thing it can do with a held record is put the
 * question to a human — and an `AfterInvocationEvent.resume` hook means it cannot end its turn
 * without doing so. A model that forgets to ask is a person who never gets woken up, so forgetting
 * is not one of the available outcomes.
 */
function askAgent(passId: string, expect: { thingId: string; sourceId: string }): Agent {
  const agent = new Agent({
    id: "adjudicator",
    name: "Adjudicator",
    description: "Puts the question Vigil cannot answer to the person whose house it is.",
    model: makeModel("brief").instance,
    systemPrompt: ASK_PROMPT,
    tools: [ruleOnCandidateTool(true)],
    retryStrategy: retryStrategy(),
    plugins: [new VigilGuards(), new Throttled()],
    interventions: [new NothingLeavesTheHouse()],
    appState: { passId },
    sessionManager: new SessionManager({ sessionId: sessionIdFor(passId), storage: new LocalFileStorage(SESSIONS), saveLatestOn: "message" }),
    traceAttributes: { "vigil.node": "adjudicator", "vigil.pass_id": passId },
    printer: false,
  });
  let nudges = 0;
  agent.addHook(AfterInvocationEvent, (e) => {
    const ctx = (() => { try { return contextFor(passId); } catch { return null; } })();
    if (!ctx) return;
    const asked = ctx.asked.some((a) => a.sourceId === expect.sourceId && a.thingId === expect.thingId);
    if (asked || nudges >= 2) return;
    nudges += 1;
    e.resume = `You ended without asking. Call rule_on_candidate NOW with thingId "${expect.thingId}", sourceId "${expect.sourceId}", verdict "unsure", confidence, reason, severity, and the question in "missing". That is the only acceptable next action.`;
  });
  return agent;
}

/** The agent that writes the note. It can see what was found and nothing else. */
function briefAgent(passId: string): Agent {
  return new Agent({
    id: "brief",
    name: "Brief",
    description: "Says what the pass found, in the owner's terms.",
    model: makeModel("brief").instance,
    systemPrompt: BRIEF_PROMPT,
    tools: [listFindings, askOwner],
    retryStrategy: retryStrategy(),
    plugins: [new VigilGuards(), new Throttled()],
    interventions: [new NothingLeavesTheHouse()],
    appState: { passId },
    traceAttributes: { "vigil.node": "brief", "vigil.pass_id": passId },
    printer: false,
  });
}

/* ── the completeness gate ────────────────────────────────────────────────── */

/** Ask whatever triage promised and the lanes never got to. The agent chooses how to look; this makes sure it looked. */
async function closeTheGaps(ctx: PassContext, send: (e: PassEmit) => void): Promise<number> {
  const missing = missingChecks(ctx);
  for (const m of missing) {
    const t = ctx.things.find((x) => x.id === m.thingId);
    if (!t) continue;
    send({ kind: "check.start", thingId: t.id, source: m.source, endpoint: `${m.source} · closing a gap the agent left` });
    try {
      const res =
        m.source === "nhtsa-recalls" && t.make && t.model && t.year
          ? await nhtsaRecallsByVehicle({ make: t.make, model: t.model, modelYear: t.year })
          : m.source === "nhtsa-complaints" && t.make && t.model && t.year
            ? await nhtsaComplaintsByVehicle({ make: t.make, model: t.model, modelYear: t.year })
            : m.source === "cpsc-recalls"
              ? await cpscRecent(process.env.VIGIL_CPSC_SINCE ?? "2023-01-01")
              : m.source === "openfda"
                ? await openFdaEnforcement({ area: "food", terms: ctx.terms.get(t.id) ?? [t.label], limit: 15 })
                : null;
      if (!res) continue;
      ctx.done.add(checkKey(t.id, m.source));
      // Rows fetched by the gap closer are candidates like any others. Fetching a recall and
      // throwing it away would be a worse failure than never asking.
      absorb(ctx, t, m.source, res);
      recordCheck({
        passId: ctx.passId,
        householdId: ctx.householdId,
        thingId: t.id,
        source: res.source,
        endpoint: res.endpoint,
        ok: res.ok,
        rowCount: res.rowCount,
        latencyMs: res.latencyMs,
        error: res.error ?? null,
      });
      send({ kind: "check.done", thingId: t.id, source: res.source, ok: res.ok, rows: res.rowCount, ms: res.latencyMs, endpoint: res.endpoint, error: res.error });
    } catch (e) {
      send({ kind: "check.done", thingId: t.id, source: m.source, ok: false, rows: 0, ms: 0, endpoint: m.source, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return missing.length;
}

/** Turn a gap-closing fetch into candidates, exactly as the lane tools would have done. */
function absorb(ctx: PassContext, t: Thing, source: string, res: { ok: boolean; rows: unknown[] }): void {
  if (!res.ok) return;
  if (source === "nhtsa-recalls") {
    for (const row of res.rows as NhtsaRecallRow[]) {
      if (ctx.candidates.some((c) => c.sourceId === row.campaignNumber && c.thingId === t.id)) continue;
      ctx.candidates.push({
        sourceId: row.campaignNumber,
        source: "nhtsa-recalls",
        sourceUrl: row.sourceUrl,
        thingId: t.id,
        title: `${row.component ?? "Safety recall"} — ${row.manufacturer ?? "manufacturer"}`,
        summary: row.summary ?? "",
        consequence: row.consequence ?? null,
        remedy: row.remedy ?? null,
        component: row.component ?? null,
        unitsAffected: null,
        parkIt: row.parkIt,
        parkOutSide: row.parkOutSide,
        date: row.reportReceivedDate ?? null,
        raw: row.raw,
      });
    }
  }
}

/* ── running one pass ─────────────────────────────────────────────────────── */

export interface PassOutcome {
  passId: string;
  status: string;
  findings: number;
  questions: number;
  summary: string;
}

export async function runPass(householdId: string, trigger: string, emit: (e: PassEmit) => void): Promise<PassOutcome> {
  const household = getHousehold(householdId);
  if (!household) throw new Error("no such household");
  const things = listThings(householdId);
  const pass = startPass(householdId, trigger);
  const t0 = Date.now();
  // Every pass records itself, so what it did can be watched again without running it again.
  const tape = recorder(pass.id, householdId, modelLabel());
  const send = (e: PassEmit) => {
    tape.note(e);
    emit(e);
  };
  const ctx = openContext({
    passId: pass.id,
    householdId,
    things,
    standing: listStanding(householdId).map((s) => s.text),
    expected: [],
    emit: send,
  });

  send({ kind: "pass.start", passId: pass.id, things: things.length, model: modelLabel() });
  logEvent(householdId, "system", "pass.start", `${things.length} things`, pass.id);

  let status = "clean";
  let summary = "";
  try {
    if (things.length === 0) {
      summary = "Nothing to watch yet.";
    } else {
      // The graph is the agent's own run, and it can fail: a node can time out, a provider can have
      // a bad ten minutes. That must not take the safety net down with it — the gates below are
      // exactly what a half-finished watch needs, so a graph failure is reported and stepped over.
      try {
        const graph = buildGraph(pass.id, householdId);
        graph.addHook(BeforeNodeCallEvent, (e) => {
          send({ kind: "node.start", node: e.nodeId, label: NODE_LABEL[e.nodeId] ?? e.nodeId });
        });

        const brief = things.map((t) => `${t.label} — ${[t.year, t.make, t.model].filter(Boolean).join(" ") || t.kind}`).join("\n");
        const stream = graph.stream(`This household is watching:\n${brief}\n\nRun the pass.`, {
          invocationState: { passId: pass.id, householdId },
        }) as AsyncGenerator<MultiAgentStreamEvent>;
        for await (const ev of stream) {
          if (ev instanceof NodeResultEvent) {
            send({ kind: "node.done", node: ev.nodeId, ms: ev.result.duration ?? 0, status: String(ev.result.status) });
            const said = ev.result.content?.map((b) => (b.type === "textBlock" ? b.text : "")).join("").trim();
            if (said) send({ kind: "thinking", node: ev.nodeId, text: said.slice(0, 600) });
          }
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        send({ kind: "error", message: `The agent's own run did not finish (${why.slice(0, 140)}). Vigil is asking the rest itself.` });
        logEvent(householdId, "system", "graph.failed", why, pass.id);
      }

      const unchecked = await closeTheGaps(ctx, send);
      if (unchecked > 0) logEvent(householdId, "system", "gap.closed", `${unchecked} source(s) the agent planned but did not ask`, pass.id);
      const unjudged = await closeTheVerdicts(ctx, householdId, send);
      if (unjudged > 0) logEvent(householdId, "system", "verdicts.closed", `${unjudged} record(s) the agent fetched but did not rule on`, pass.id);

      // Anything left unsettled becomes a real halt.
      if (ctx.wrote.length > 0 || ctx.held.length > 0) {
        try {
          const result = await runAdjudicator(pass.id, send);
          summary = result.summary;
          if (result.halted) status = "interrupted";
        } catch (e) {
          // A findings list that exists is worth more than a sentence about it. Say so and go on.
          send({ kind: "error", message: `Vigil found things but could not write its note: ${e instanceof Error ? e.message : String(e)}` });
        }
      }
      if (!summary) summary = describePass(ctx);
      if (status !== "interrupted") status = ctx.wrote.length > 0 ? "found" : "clean";
    }
  } catch (e) {
    status = "failed";
    summary = e instanceof Error ? e.message : String(e);
    send({ kind: "error", message: summary });
    logEvent(householdId, "system", "pass.failed", summary, pass.id);
  }

  // A pass that stopped to ask something has to be able to wait longer than this process lives.
  if (status === "interrupted") savePassContext(pass.id, freeze(ctx));
  finishPass(pass.id, status);
  send({
    kind: "pass.done",
    passId: pass.id,
    status,
    findings: ctx.wrote.length,
    rows: ctx.candidates.length,
    ms: Date.now() - t0,
    unchecked: missingChecks(ctx).length,
  });
  logEvent(householdId, "system", `pass.${status}`, summary, pass.id);
  tape.save();
  const outcome = { passId: pass.id, status, findings: ctx.wrote.length, questions: ctx.asked.length, summary };
  if (status !== "interrupted") closeContext(pass.id);
  return outcome;
}

function describePass(ctx: PassContext): string {
  if (ctx.wrote.length === 0) return `Looked at ${ctx.things.length} thing${ctx.things.length === 1 ? "" : "s"} across ${ctx.done.size} federal sources. Nothing new.`;
  return `${ctx.wrote.length} thing${ctx.wrote.length === 1 ? "" : "s"} in this house ${ctx.wrote.length === 1 ? "needs" : "need"} your attention.`;
}

async function runAdjudicator(passId: string, send: (e: PassEmit) => void): Promise<{ summary: string; halted: boolean }> {
  const ctx = contextFor(passId);
  const state = { invocationState: { passId, householdId: ctx.householdId } };

  // One held record, one invocation, one halt. The agent decides HOW to ask; this loop decides THAT
  // every held record gets asked about.
  for (const h of ctx.held) {
    if (ctx.asked.some((a) => a.sourceId === h.sourceId && a.thingId === h.thingId)) continue;
    const thing = ctx.things.find((t) => t.id === h.thingId);
    send({ kind: "node.start", node: "adjudicator", label: `Asking you about ${thing?.label ?? "one thing"}` });
    const t = Date.now();
    let result: AgentResult;
    try {
      result = await askAgent(passId, h).invoke(
        `Held record. thingId "${h.thingId}", sourceId "${h.sourceId}", on: ${thing?.label}. ` +
          `The match agent could not settle it because: ${h.reason}. The question it wanted answered was: ${h.question}`,
        state,
      );
    } catch (e) {
      send({ kind: "error", message: `Could not put the question about ${h.sourceId} to you: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }
    send({ kind: "node.done", node: "adjudicator", ms: Date.now() - t, status: String(result.stopReason) });

    if (result.stopReason === "interrupt" && result.interrupts?.length) {
      for (const i of result.interrupts) {
        const reason = i.reason as { decisionId?: string; question?: string } | undefined;
        if (reason?.decisionId) {
          const rec = ctx.asked.find((a) => a.decisionId === reason.decisionId);
          if (rec) rec.interruptId = i.id;
          send({ kind: "decision", decisionId: reason.decisionId, question: reason.question ?? i.name, interruptId: i.id });
        }
      }
      // The run is genuinely stopped. Everything still held waits with it.
      return { summary: "Vigil stopped and is waiting on you.", halted: true };
    }
  }

  send({ kind: "node.start", node: "brief", label: "Writing what it found" });
  const t = Date.now();
  try {
    const result = await briefAgent(passId).invoke("Tell the owner what you found.", state);
    send({ kind: "node.done", node: "brief", ms: Date.now() - t, status: String(result.stopReason) });
    return { summary: result.toString().trim().slice(0, 400), halted: false };
  } catch (e) {
    send({ kind: "error", message: `Vigil found things but could not write its note: ${e instanceof Error ? e.message : String(e)}` });
    return { summary: describePass(ctx), halted: false };
  }
}

export async function resumeWithAnswer(decisionId: string, answer: string, note: string | undefined, send: (e: PassEmit) => void): Promise<PassOutcome> {
  const decision = answerDecision(decisionId, answer, note);
  if (!decision) throw new Error("no such decision");
  const passId = decision.passId;
  if (!passId) throw new Error("this decision is not attached to a pass");

  // What they said becomes a rule in their words, so the same question is never asked twice.
  if (decision.kind === "identify") {
    addStanding({
      householdId: decision.householdId,
      thingId: decision.thingId,
      text: `${decision.question} — you answered "${answer}"${note ? `: ${note}` : ""}.`,
      fromDecisionId: decision.id,
    });
  }
  logEvent(decision.householdId, "human", "decision.answered", `${decision.question} → ${answer}`, decision.id);

  let ctx: PassContext;
  try {
    ctx = contextFor(passId);
    ctx.emit = send;
  } catch {
    // The process restarted while the question waited. Pick the same run back up off disk.
    const stored = getPass(passId)?.context;
    if (!stored) {
      send({ kind: "error", message: "That pass is no longer running. Your answer is saved and stands as a rule from the next watch on." });
      return { passId, status: "answered", findings: 0, questions: 0, summary: "Answer saved." };
    }
    ctx = thaw(passId, decision.householdId, listThings(decision.householdId), JSON.parse(stored) as StoredContext, send);
  }

  const asked = ctx.asked.find((a) => a.decisionId === decisionId);
  const held = ctx.held.find((h) => h.sourceId === asked?.sourceId && h.thingId === asked?.thingId) ?? ctx.held[0];
  const agent = askAgent(passId, held ? { thingId: held.thingId, sourceId: held.sourceId } : { thingId: "", sourceId: "" });
  const d = getDecision(decisionId);
  const interruptId = ctx.asked.find((a) => a.decisionId === decisionId)?.interruptId;
  markResumed(decisionId);
  send({ kind: "node.start", node: "adjudicator", label: "Picking up where it stopped" });
  const t0 = Date.now();

  let result: AgentResult;
  if (interruptId) {
    result = await agent.invoke([new InterruptResponseContent({ interruptId, response: answer })], {
      invocationState: { passId, householdId: decision.householdId },
    });
  } else {
    result = await agent.invoke(`The owner answered "${answer}"${note ? ` (${note})` : ""} to: ${d?.question ?? ""}. Finish the ruling and report.`, {
      invocationState: { passId, householdId: decision.householdId },
    });
  }

  // Any further question is a further halt, honestly reported.
  while (result.stopReason === "interrupt" && result.interrupts?.length) {
    for (const i of result.interrupts) {
      const reason = i.reason as { decisionId?: string; question?: string } | undefined;
      if (reason?.decisionId) {
        const rec = ctx.asked.find((a) => a.decisionId === reason.decisionId);
        if (rec) rec.interruptId = i.id;
        send({ kind: "decision", decisionId: reason.decisionId, question: reason.question ?? i.name, interruptId: i.id });
      }
    }
    send({ kind: "node.done", node: "adjudicator", ms: Date.now() - t0, status: "interrupt" });
    savePassContext(passId, freeze(ctx));
    return { passId, status: "interrupted", findings: ctx.wrote.length, questions: ctx.asked.length, summary: "Vigil has one more question." };
  }

  send({ kind: "node.done", node: "adjudicator", ms: Date.now() - t0, status: String(result.stopReason) });
  // Anything still held keeps the run open; only a pass with nothing left to ask is finished.
  const remaining = ctx.held.filter((h) => !ctx.asked.some((a) => a.sourceId === h.sourceId && a.thingId === h.thingId));
  if (remaining.length > 0) {
    const more = await runAdjudicator(passId, send);
    if (more.halted) {
      savePassContext(passId, freeze(ctx));
      return { passId, status: "interrupted", findings: ctx.wrote.length, questions: ctx.asked.length, summary: more.summary };
    }
  }
  const status = ctx.wrote.length > 0 ? "found" : "clean";
  finishPass(passId, status);
  send({ kind: "pass.done", passId, status, findings: ctx.wrote.length, rows: ctx.candidates.length, ms: Date.now() - t0, unchecked: 0 });
  closeContext(passId);
  return { passId, status, findings: ctx.wrote.length, questions: ctx.asked.length, summary: result.toString().trim().slice(0, 400) };
}
