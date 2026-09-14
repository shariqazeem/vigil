import { AfterInvocationEvent, Agent, InterruptResponseContent, SessionManager, SlidingWindowConversationManager, type AgentResult } from "@strands-agents/sdk";
import { Graph, BeforeNodeCallEvent, NodeResultEvent, type MultiAgentStreamEvent } from "@strands-agents/sdk/multiagent";
import { LocalFileStorage } from "@strands-agents/sdk/storage";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  addStanding,
  listProbes,
  parseSpec,
  answerDecision,
  changesMade,
  getDecision,
  getIncident,
  getProbe,
  getService,
  listStanding,
  logEvent,
  markResumed,
  policyOf,
  resolveIncident,
  updateIncident,
} from "@/lib/db/warden";
import { verifyIncident } from "@/lib/ops/sweep";
import { makeModel, modelLabel, retryStrategy } from "./model";
import { Throttled } from "./throttle";
import { WardenGuards } from "./guards";
import { closeContext, contextFor, hasContext, openContext, type IncidentContext, type WardenEmit } from "./incident-context";
import { act, giveUp, listTried, look, readIncident, recordDiagnosis } from "./tools";

/**
 * HANDLING ONE INCIDENT.
 *
 * A Strands `Graph`: `investigate` gathers evidence and commits to a cause, and a conditional edge
 * sends it to `remedy` only when there is a cause to act on. Around the graph sits the part that is
 * deliberately not the model's to decide —
 *
 *   the POLICY decides whether an act happens, is refused, or stops the run and asks you;
 *   the PROBE decides whether it worked.
 *
 * That second one is the whole product. Warden does not get to say it fixed something. It re-runs
 * the exact check that failed, and if that check does not come back clean the fix did not happen,
 * however confident the model was and however plausible its account of the cause.
 */

const SESSIONS = process.env.WARDEN_SESSION_DIR ?? join(process.cwd(), "var", "sessions");
const sessionIdFor = (incidentId: string) => `inc-${incidentId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;

/**
 * The session exists so a run that STOPS to ask a human can be picked back up hours later with the
 * conversation intact. It must not survive into a fresh attempt at the same incident: an agent that
 * reads its own earlier "I could not do anything here" simply says it again, which is exactly what
 * happened the first time this was built.
 */
function forgetSession(incidentId: string): void {
  const id = sessionIdFor(incidentId);
  // LocalFileStorage nests its snapshots under a `session/` directory; clear both spellings so
  // this keeps working if that layout changes.
  for (const dir of [join(SESSIONS, "session", id), join(SESSIONS, id)]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a session that will not delete is not a reason to refuse to start */
    }
  }
}

const INVESTIGATE_PROMPT = `You are Warden, investigating one failure on one service, at an hour when nobody is awake.

Call read_incident first. It tells you what failed, what you may do here, and everything already tried.

Then LOOK — but sparingly. You get TEN looks and most incidents are answered in two or three. The
service is down while you read, so go in this order and stop as soon as you can name a cause:

  1. pm2_list. Is the process even running? If pm2 says "stopped" or "errored", that IS the finding —
     you do not need to read the source code to explain why a stopped process is not serving.
  2. pm2_logs. The last hundred lines, then the error stream. A stack trace ends the investigation.
  3. git_log, and git_show on anything that landed near the time this started failing.
  4. Only then, a specific file — and only one the log or the diff actually pointed you at.

Never go fishing through a codebase. Reading twelve files you had no reason to open is how an
investigation takes five minutes and arrives nowhere.

One trap worth naming, because it has caught this agent before: pm2's restart count is CUMULATIVE
since the process was added, and an ordinary deploy bumps it. Four restarts is not a crash loop.
What tells you whether something is looping is "thisCheckOverTime" in read_incident — Warden's own
record of this exact check — and "lastStartedAt" from pm2. A check that passed forty times and
started failing four minutes ago is not a long-standing problem.

Two habits that separate a diagnosis from a guess:
  · Line up TIMES. A failure that starts eight minutes after a deploy is about that deploy. One that
    starts at no particular moment is usually not.
  · Quote what you actually read. "the log says TypeError: Cannot read properties of undefined
    (reading 'id') at line 42 of route.ts" is a diagnosis. "there seems to be an error" is not.

You MUST call record_diagnosis before you finish — that is the only output of this step and the run
cannot continue without it. Call it exactly once. Name a cause and a suspect if the evidence supports one, and
say honestly how sure you are. A confident wrong answer here becomes an act on a production system,
so under-claiming is cheap and over-claiming is not.

Do not act in this step. You have no tools that could.`;

const REMEDY_PROMPT = `You are Warden, deciding what to actually do about a failure you have just diagnosed.

Call read_incident, then list_tried. Then choose the SMALLEST act that would fix the cause you named.

The policy for this service decides what happens when you call act. It will either do it, or refuse
it and tell you which rule refused it, or stop the run and put the question to the owner. You cannot
tell which in advance, and you must not phrase your act to get a different answer — reaching a
forbidden end by another route is the one thing that would make this product unusable.

After an act, Warden re-runs the exact probe that failed. You do not decide whether it worked.

If the evidence does not support any act you are permitted to make, or if what you tried did not
work, call give_up and say plainly what you found, what you tried, and what a human needs to do. An
honest escalation at 3am is a good night's work. Guessing at someone's production is not.

Never restart something twice hoping for a different answer.

One thing worth being plain about, because an earlier version of this agent got it wrong: a process
that pm2 reports as "stopped" is not crash-looping. It is stopped. If Warden's own history shows the
check was passing before it stopped, starting it is the smallest correct act and there is nothing
clever to work out. pm2's cumulative restart count is not evidence against that.`;

const NODE_LABEL: Record<string, string> = {
  investigate: "Looking at it",
  remedy: "Deciding what to do",
};

/* ── the agents ───────────────────────────────────────────────────── */

function investigator(incidentId: string): Agent {
  const agent = new Agent({
    id: "investigate",
    name: "Investigate",
    description: "Gathers evidence about a failure and commits to a cause.",
    model: makeModel("investigate").instance,
    systemPrompt: INVESTIGATE_PROMPT,
    tools: [readIncident, look, recordDiagnosis],
    retryStrategy: retryStrategy(),
    // Logs and diffs are large, and an investigation that reads six of them will overrun the
    // context and die mid-thought. The window keeps the brief and the most recent evidence; what
    // falls out of it is already in the evidence list, which read_incident hands back on demand.
    conversationManager: new SlidingWindowConversationManager({ windowSize: 16, pinFirst: 1 }),
    plugins: [new WardenGuards(), new Throttled()],
    traceAttributes: { "warden.node": "investigate", "warden.incident_id": incidentId },
    printer: false,
  });
  // An investigation that ends without a conclusion is not an investigation. It gets one nudge,
  // then the conditional edge stops the run and the incident is escalated with the evidence.
  let nudges = 0;
  agent.addHook(AfterInvocationEvent, (e) => {
    if (!hasContext(incidentId) || nudges >= 1) return;
    if (contextFor(incidentId).diagnosis) return;
    nudges += 1;
    e.resume = "You ended without a diagnosis. Call record_diagnosis now with what you have already read — name the most likely cause, and set confidence low if the evidence is thin. Do not look at anything else.";
  });
  return agent;
}

function remedy(incidentId: string): Agent {
  const agent = new Agent({
    id: "remedy",
    name: "Remedy",
    description: "Chooses and performs the smallest act that would fix the diagnosed cause.",
    model: makeModel("remedy").instance,
    systemPrompt: REMEDY_PROMPT,
    tools: [readIncident, listTried, act, giveUp],
    retryStrategy: retryStrategy(),
    plugins: [new WardenGuards(), new Throttled()],
    // An incident that stops to ask a human may wait hours. The conversation has to outlive the
    // process it started in, or the answer comes back to nobody.
    sessionManager: new SessionManager({ sessionId: sessionIdFor(incidentId), storage: new LocalFileStorage(SESSIONS), saveLatestOn: "message" }),
    traceAttributes: { "warden.node": "remedy", "warden.incident_id": incidentId },
    printer: false,
  });
  // It may not end a turn having neither acted nor said why it cannot. Silence at 3am is the one
  // outcome that helps nobody.
  let nudges = 0;
  agent.addHook(AfterInvocationEvent, (e) => {
    if (!hasContext(incidentId) || nudges >= 1) return;
    const ctx = contextFor(incidentId);
    if (ctx.gaveUp || ctx.changes > 0 || ctx.asked.length > 0) return;
    nudges += 1;
    e.resume = "You have neither acted nor explained why you cannot. Do one of them now: call act with the smallest fix your diagnosis supports, or call give_up and say what a human needs to do.";
  });
  return agent;
}

function buildGraph(incidentId: string, serviceId: string): Graph {
  return new Graph({
    id: "warden-incident",
    nodes: [investigator(incidentId), remedy(incidentId)],
    edges: [
      // The conditional edge that matters: Warden does not get to act on a hunch. If investigate
      // could not name a cause, remedy never runs and the incident is escalated with the evidence.
      {
        source: "investigate",
        target: "remedy",
        handler: () => {
          try {
            const c = contextFor(incidentId);
            return Boolean(c.diagnosis) && (c.confidence ?? 0) >= CONFIDENCE_TO_ACT;
          } catch {
            return false;
          }
        },
      },
    ],
    maxSteps: 12,
    timeout: 900_000,
    nodeTimeout: 420_000,
    traceAttributes: { "warden.incident_id": incidentId, "warden.service_id": serviceId },
  });
}

/**
 * The addresses this service actually owns, taken from its own probes. An http probe may only be
 * pointed at one of these — otherwise "look at a URL" is a request to fetch anything at all from
 * wherever Warden happens to be running, which is a different and much worse product.
 */
function originsOf(serviceId: string): string[] {
  const out = new Set<string>();
  for (const p of listProbes(serviceId)) {
    const url = parseSpec(p).url;
    if (typeof url !== "string") continue;
    try {
      out.add(new URL(url).origin);
    } catch {
      /* a probe with an unparseable url grants nothing */
    }
  }
  return [...out];
}

/** Below this, Warden asks rather than acts. A production system is not a place to try things. */
export const CONFIDENCE_TO_ACT = 0.5;

/* ── running one incident ─────────────────────────────────────────── */

export interface Outcome {
  incidentId: string;
  status: string;
  downSeconds: number | null;
  summary: string;
}

export async function handleIncident(incidentId: string, emit: (e: WardenEmit) => void): Promise<Outcome> {
  const incident = getIncident(incidentId);
  if (!incident) throw new Error("no such incident");
  const service = getService(incident.serviceId);
  if (!service) throw new Error("no such service");

  const ctx = openContext({
    incidentId,
    serviceId: service.id,
    service,
    incident,
    policy: policyOf(service),
    standing: listStanding(service.id).map((s) => s.text),
    allowedOrigins: originsOf(service.id),
    emit,
  });
  ctx.changes = changesMade(incidentId);
  forgetSession(incidentId);

  emit({ kind: "run.start", incidentId, service: service.name, title: incident.title, model: modelLabel() });
  updateIncident(incidentId, { status: "investigating" });
  logEvent(service.id, "investigate", "run.start", incident.title, incidentId);

  let halted = false;
  try {
    const graph = buildGraph(incidentId, service.id);
    graph.addHook(BeforeNodeCallEvent, (e) => emit({ kind: "node.start", node: e.nodeId, label: NODE_LABEL[e.nodeId] ?? e.nodeId }));

    const brief = `Service: ${service.name}${service.matters ? ` — ${service.matters}` : ""}\nFailing check: ${incident.title}\nWhat it said: ${incident.symptom}`;
    const stream = graph.stream(brief, { invocationState: { incidentId, serviceId: service.id } }) as AsyncGenerator<MultiAgentStreamEvent>;
    for await (const ev of stream) {
      if (ev instanceof NodeResultEvent) {
        emit({ kind: "node.done", node: ev.nodeId, ms: ev.result.duration ?? 0, status: String(ev.result.status) });
        if (ev.result.status === "INTERRUPTED") halted = true;
      }
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    emit({ kind: "error", message: `Warden's own run did not finish (${why.slice(0, 160)}).` });
    logEvent(service.id, "system", "graph.failed", why, incidentId);
  }

  if (ctx.asked.length > 0 && !ctx.asked.every((a) => getDecision(a.decisionId)?.answeredAt)) halted = true;
  return halted ? holdForHuman(ctx) : await settle(ctx);
}

/** The run is stopped on a question. Say so, and leave it stopped. */
function holdForHuman(ctx: IncidentContext): Outcome {
  updateIncident(ctx.incidentId, { status: "escalated" });
  const summary = "Warden stopped and is waiting on you.";
  ctx.emit({ kind: "run.done", incidentId: ctx.incidentId, status: "escalated", downSeconds: null, summary });
  logEvent(ctx.serviceId, "policy", "halted", summary, ctx.incidentId);
  return { incidentId: ctx.incidentId, status: "escalated", downSeconds: null, summary };
}

/**
 * The verdict, and the only place one is issued. Re-run the probe that failed. If it comes back
 * clean the incident is resolved and the reading is filed as the proof; if it does not, nothing
 * Warden believes about its own fix changes that.
 */
async function settle(ctx: IncidentContext): Promise<Outcome> {
  const incident = getIncident(ctx.incidentId)!;
  const probe = getProbe(incident.probeId);

  if (ctx.changes === 0) {
    const summary = ctx.gaveUp ?? "Warden did not find anything it was allowed to do about this.";
    updateIncident(ctx.incidentId, { status: "escalated", resolution: summary });
    ctx.emit({ kind: "run.done", incidentId: ctx.incidentId, status: "escalated", downSeconds: null, summary });
    logEvent(ctx.serviceId, "investigate", "escalated", summary, ctx.incidentId);
    closeContext(ctx.incidentId);
    return { incidentId: ctx.incidentId, status: "escalated", downSeconds: null, summary };
  }

  updateIncident(ctx.incidentId, { status: "verifying" });
  ctx.emit({ kind: "node.start", node: "verify", label: `Re-running the check that failed` });
  const reading = await verifyIncident(ctx.service, incident, (e) => ctx.emit(e));
  if (!reading) {
    const summary = "Warden acted but could not re-run the check, so it will not claim this is fixed.";
    updateIncident(ctx.incidentId, { status: "escalated", resolution: summary });
    ctx.emit({ kind: "run.done", incidentId: ctx.incidentId, status: "escalated", downSeconds: null, summary });
    closeContext(ctx.incidentId);
    return { incidentId: ctx.incidentId, status: "escalated", downSeconds: null, summary };
  }

  ctx.emit({ kind: "verify", label: probe?.label ?? "the check", ok: reading.ok, detail: reading.detail });

  if (reading.ok) {
    const resolution = ctx.diagnosis ? `${ctx.diagnosis.split("\n")[0]!.slice(0, 200)} — fixed and verified.` : "Fixed and verified.";
    resolveIncident(ctx.incidentId, reading, resolution);
    const downSeconds = Math.max(0, Math.round((reading.at - incident.openedAt) / 1000));
    const summary = `Fixed. ${probe?.label ?? "The check"} passes again: ${reading.detail}. Down for ${fmt(downSeconds)}.`;
    ctx.emit({ kind: "run.done", incidentId: ctx.incidentId, status: "resolved", downSeconds, summary });
    logEvent(ctx.serviceId, "verify", "resolved", summary, ctx.incidentId);
    closeContext(ctx.incidentId);
    return { incidentId: ctx.incidentId, status: "resolved", downSeconds, summary };
  }

  const summary = `Warden acted, but the check still fails: ${reading.detail}. It is not calling this fixed.`;
  updateIncident(ctx.incidentId, { status: "escalated", resolution: summary });
  ctx.emit({ kind: "run.done", incidentId: ctx.incidentId, status: "escalated", downSeconds: null, summary });
  logEvent(ctx.serviceId, "verify", "not-fixed", summary, ctx.incidentId);
  closeContext(ctx.incidentId);
  return { incidentId: ctx.incidentId, status: "escalated", downSeconds: null, summary };
}

const fmt = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);

/* ── the other half of the halt ───────────────────────────────────── */

/**
 * A human answered. The same run continues from exactly where it stopped: Strands hands the
 * `act` tool the answer as its return value, and the agent finishes the thought it was having.
 */
export async function resumeWithAnswer(decisionId: string, answer: string, note: string | undefined, emit: (e: WardenEmit) => void): Promise<Outcome> {
  const decision = answerDecision(decisionId, answer, note);
  if (!decision?.incidentId) throw new Error("that decision is not attached to an incident");
  const incidentId = decision.incidentId;
  const incident = getIncident(incidentId);
  const service = incident ? getService(incident.serviceId) : null;
  if (!incident || !service) throw new Error("that incident is gone");

  // What they said becomes a rule in their words, so the same question is not put to them twice.
  addStanding({
    serviceId: service.id,
    text: `${decision.question} — you answered "${answer}"${note ? `: ${note}` : ""}.`,
    fromDecisionId: decision.id,
  });
  logEvent(service.id, "human", "answered", `${decision.question} → ${answer}`, incidentId);

  let ctx: IncidentContext;
  if (hasContext(incidentId)) {
    ctx = contextFor(incidentId);
    ctx.emit = emit;
  } else {
    ctx = openContext({
      incidentId,
      serviceId: service.id,
      service,
      incident,
      policy: policyOf(service),
      standing: listStanding(service.id).map((s) => s.text),
      allowedOrigins: originsOf(service.id),
      emit,
    });
    ctx.changes = changesMade(incidentId);
    ctx.diagnosis = incident.diagnosis;
    ctx.suspect = incident.suspect;
    ctx.confidence = incident.confidence;
  }

  markResumed(decisionId);
  emit({ kind: "node.start", node: "remedy", label: "Picking up where it stopped" });
  const agent = remedy(incidentId);
  const state = { invocationState: { incidentId, serviceId: service.id } };
  const t0 = Date.now();

  let result: AgentResult;
  const interruptId = ctx.asked.find((a) => a.decisionId === decisionId)?.interruptId;
  try {
    result = interruptId
      ? await agent.invoke([new InterruptResponseContent({ interruptId, response: answer })], state)
      : await agent.invoke(
          `The owner answered "${answer}"${note ? ` (${note})` : ""} to: ${decision.question}. ` +
            (answer === "approve" ? "Carry out exactly what you proposed, then stop." : "Do not do it. Call give_up and say what a human needs to do instead."),
          state,
        );
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    emit({ kind: "error", message: `Could not pick the run back up: ${why.slice(0, 160)}` });
    return { incidentId, status: "escalated", downSeconds: null, summary: why };
  }
  emit({ kind: "node.done", node: "remedy", ms: Date.now() - t0, status: String(result.stopReason) });

  if (result.stopReason === "interrupt" && result.interrupts?.length) {
    for (const i of result.interrupts) {
      const reason = i.reason as { decisionId?: string; question?: string; op?: string } | undefined;
      if (reason?.decisionId) {
        const rec = ctx.asked.find((a) => a.decisionId === reason.decisionId);
        if (rec) rec.interruptId = i.id;
        emit({ kind: "decision", decisionId: reason.decisionId, question: reason.question ?? i.name, proposal: null, because: null, interruptId: i.id });
      }
    }
    return holdForHuman(ctx);
  }

  return settle(ctx);
}
