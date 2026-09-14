import { ToolStreamEvent, tool, type ToolContext } from "@strands-agents/sdk";
import { z } from "zod";
import { changesMade, findDecisionFor, getProbe, listActions, minutesSinceLastChange, openDecision, readingsFor, recordAction, targetOf, updateIncident } from "@/lib/db/warden";
import { catalogue, execute, riskOf, withServiceDefaults, OPERATIONS, OPERATION_NAMES, type OperationName } from "@/lib/ops/operations";
import { decide, describePolicy } from "@/lib/ops/policy";
import { contextFor, type IncidentContext } from "./incident-context";

/**
 * WARDEN'S HANDS. Two of them.
 *
 * `look` runs anything in the catalogue whose risk is `read`. `act` runs anything that changes the
 * world. Both go through the same policy, in the same place, and neither of them lets the model
 * choose what the policy says.
 *
 * The shape matters more than it looks. There is no `run_command` tool and no way to compose one:
 * the agent picks an operation BY NAME from a fixed catalogue and supplies arguments that a zod
 * schema validates, and `execute` spawns it without a shell. The worst thing a jailbroken model can
 * do here is name an operation that does not exist, and be told so.
 *
 * Every call — allowed, refused, or turned into a question — is written to the actions table with
 * the policy rule that decided it. That table is the audit trail, and it is the same one the
 * console draws the incident timeline from.
 */

const ctxOf = (c: ToolContext | undefined): IncidentContext => {
  const incidentId = (c?.invocationState as { incidentId?: string } | undefined)?.incidentId;
  if (!incidentId) throw new Error("tool called outside an incident");
  return contextFor(incidentId);
};

const summarise = (stdout: string, stderr: string, error?: string, max = 900): string => {
  const body = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  const text = body || error || "(no output)";
  return text.length > max ? `${text.slice(0, max)}\n… [${text.length - max} more bytes]` : text;
};

/**
 * Fill in what the service already knows, then check the shape. A malformed call is corrected here
 * and never reaches the policy or the audit trail — it is a typo, not an attempt to do something.
 */
function prepare(
  op: OperationName,
  raw: Record<string, unknown>,
  ctx: IncidentContext,
): { input: Record<string, unknown> } | { correction: { rejected: true; error: string; takes: unknown } } {
  const filled = withServiceDefaults(op, raw ?? {}, targetOf(ctx.service));
  const parsed = (OPERATIONS[op].input as { safeParse: (v: unknown) => { success: boolean } }).safeParse(filled);
  if (!parsed.success) {
    const spec = catalogue().find((c) => c.name === op);
    return { correction: { rejected: true, error: `Those are not the arguments ${op} takes. Call it again with exactly these.`, takes: spec?.takes ?? {} } };
  }
  return { input: filled };
}

/** What the failing check has been saying, from Warden's own readings. */
function history(probeId: string): Record<string, unknown> {
  const probe = getProbe(probeId);
  const rs = readingsFor(probeId, 120);
  if (!rs.length) return { note: "Warden has no history for this check yet — this is the first time it has looked." };
  const passed = rs.filter((r) => r.ok).length;
  const firstFailure = [...rs].reverse().find((r, i, arr) => !r.ok && (i === 0 || arr[i - 1]!.ok));
  const lastPass = rs.find((r) => r.ok);
  return {
    check: probe?.label,
    looks: rs.length,
    passed,
    failed: rs.length - passed,
    startedFailingAt: firstFailure ? new Date(firstFailure.at).toISOString() : null,
    lastPassedAt: lastPass ? new Date(lastPass.at).toISOString() : null,
    minutesSinceItLastPassed: lastPass ? Math.round((Date.now() - lastPass.at) / 60_000) : null,
  };
}

const READ_OPS = OPERATION_NAMES.filter((n) => riskOf(n) === "read");

/**
 * How many things Warden may look at before it has to say what it thinks. An investigation that
 * keeps reading is not being thorough, it is avoiding a conclusion — and every minute of it is a
 * minute the service is still down.
 */
const MAX_LOOKS = 10;
const ACT_OPS = OPERATION_NAMES.filter((n) => riskOf(n) === "reversible" || riskOf(n) === "disruptive");

/* ── knowing where you are ────────────────────────────────────────── */

export const readIncident = tool({
  name: "read_incident",
  description: "The incident you are working on: what failed, on which service, what you may do here, and everything you have already looked at or tried. Read this first.",
  inputSchema: z.object({}),
  callback: (_input, context) => {
    const ctx = ctxOf(context);
    return {
      service: {
        name: ctx.service.name,
        matters: ctx.service.matters,
        host: ctx.service.host,
        repo: ctx.service.repo,
        process: ctx.service.process,
      },
      incident: {
        title: ctx.incident.title,
        symptom: ctx.incident.symptom,
        openedAt: new Date(ctx.incident.openedAt).toISOString(),
        minutesDown: Math.round((Date.now() - ctx.incident.openedAt) / 60_000),
      },
      // Warden's own record of this check. It is the thing that separates "this has been broken
      // for days" from "this broke four minutes ago", and a cumulative restart count cannot.
      thisCheckOverTime: history(ctx.incident.probeId),
      policy: describePolicy(ctx.policy),
      standingRules: ctx.standing,
      alreadyLookedAt: ctx.evidence.map((e) => ({ op: e.op, command: e.command, ok: e.ok, summary: e.summary.slice(0, 300) })),
      changesMadeThisIncident: ctx.changes,
      catalogue: catalogue(),
    };
  },
});

/* ── looking ──────────────────────────────────────────────────────── */

export const look = tool({
  name: "look",
  description:
    "Run one read-only operation from the catalogue and see what comes back. This is how you investigate: logs, recent commits, the diff of a commit, a file, a grep, the process table, the endpoint itself. It cannot change anything.",
  inputSchema: z.object({
    op: z.enum(READ_OPS as [OperationName, ...OperationName[]]),
    input: z.record(z.string(), z.unknown()).default({}).describe("arguments for that operation; {} when it takes none"),
    why: z.string().min(3).max(240).describe("what you are hoping this tells you, in one clause"),
  }),
  callback: async function* (input, context) {
    const ctx = ctxOf(context);

    if (ctx.evidence.length >= MAX_LOOKS) {
      return {
        refused: true,
        rule: "enough-looking",
        reason: `You have looked at ${ctx.evidence.length} things. That is the limit — the service is still down while you read. Call record_diagnosis with what you have, and say honestly how sure you are.`,
      };
    }

    // A probe may only be pointed at this service's own addresses. Otherwise "look at a URL"
    // is a request to fetch anything from wherever Warden happens to be running.
    if (input.op === "http_probe") {
      const url = String((input.input as { url?: unknown }).url ?? "");
      if (!ctx.allowedOrigins.some((o) => url.startsWith(o))) {
        return {
          refused: true,
          rule: "own-addresses-only",
          reason: `Warden may only probe this service's own addresses (${ctx.allowedOrigins.join(", ") || "none are configured"}). ${url} is not one of them.`,
        };
      }
    }

    const args = prepare(input.op, input.input, ctx);
    if ("correction" in args) return args.correction;

    const gate = decide(input.op, ctx.policy, { actionsTaken: ctx.changes, minutesSinceLastAction: minutesSinceLastChange(ctx.serviceId) });

    if (gate.verdict !== "allow") {
      recordAction({ incidentId: ctx.incidentId, serviceId: ctx.serviceId, op: input.op, risk: gate.risk, input: input.input, intent: input.why, verdict: gate.verdict, rule: gate.rule, reason: gate.reason });
      ctx.emit({ kind: "policy", op: input.op, verdict: gate.verdict, rule: gate.rule, reason: gate.reason });
      return { refused: true, rule: gate.rule, reason: gate.reason };
    }

    yield new ToolStreamEvent({ data: { step: input.op } });
    const target = targetOf(ctx.service);
    const res = await execute(input.op, args.input, target);
    ctx.emit({ kind: "look", op: input.op, command: res.command, why: input.why });

    const summary = summarise(res.stdout, res.stderr, res.error);
    ctx.evidence.push({ op: input.op, command: res.command, ok: res.ok, summary, ms: res.ms, at: Date.now() });
    recordAction({
      incidentId: ctx.incidentId,
      serviceId: ctx.serviceId,
      op: input.op,
      risk: "read",
      input: args.input,
      intent: input.why,
      verdict: "allow",
      rule: gate.rule,
      reason: gate.reason,
      command: res.command,
      ok: res.ok,
      output: summary,
      exitCode: res.code,
      ms: res.ms,
    });
    ctx.emit({ kind: "looked", op: input.op, ok: res.ok, summary: summary.slice(0, 300), ms: res.ms });

    return { ok: res.ok, command: res.command, ms: res.ms, output: summary, structured: res.data ?? null, error: res.error ?? null };
  },
});

/* ── committing to an answer ──────────────────────────────────────── */

export const recordDiagnosis = tool({
  name: "record_diagnosis",
  description:
    "Commit to what you think is wrong, and why. Quote the evidence you actually read — a log line, a commit subject, a status. Call this once you can name a cause; call it with low confidence and say so if you cannot.",
  inputSchema: z.object({
    diagnosis: z.string().min(20).max(1200).describe("in plain words, to the person who owns this service. Quote what you read."),
    suspect: z.string().max(200).nullable().describe("the commit sha, file, or process name the evidence points at, or null"),
    confidence: z.number().min(0).max(1).describe("how sure you are of the CAUSE, not of the fix"),
  }),
  callback: (input, context) => {
    const ctx = ctxOf(context);
    if (ctx.evidence.length === 0) {
      return { rejected: true, error: "You have not looked at anything yet. Warden does not diagnose from the symptom alone — use `look` first." };
    }
    ctx.diagnosis = input.diagnosis;
    ctx.suspect = input.suspect;
    ctx.confidence = input.confidence;
    updateIncident(ctx.incidentId, { diagnosis: input.diagnosis, suspect: input.suspect, confidence: input.confidence, status: "acting" });
    ctx.emit({ kind: "diagnosis", text: input.diagnosis, suspect: input.suspect, confidence: input.confidence });
    return { recorded: true, evidenceUsed: ctx.evidence.length };
  },
});

/* ── acting ───────────────────────────────────────────────────────── */

export const act = tool({
  name: "act",
  description:
    "Do something that changes the running system. The policy for this service decides: it either happens and you are told what came back, or it stops the run and asks the owner, or it is refused and you are told which rule refused it. You cannot know which in advance and you must not assume.",
  inputSchema: z.object({
    op: z.enum(ACT_OPS as [OperationName, ...OperationName[]]),
    input: z.record(z.string(), z.unknown()).default({}),
    why: z.string().min(10).max(300).describe("why this specific act follows from your diagnosis, in one sentence the owner would accept"),
  }),
  callback: async (input, context) => {
    const ctx = ctxOf(context);

    if (!ctx.diagnosis) {
      return { rejected: true, error: "Warden does not act before it can say what is wrong. Call record_diagnosis first." };
    }

    const args = prepare(input.op, input.input, ctx);
    if ("correction" in args) return args.correction;

    const gate = decide(input.op, ctx.policy, { actionsTaken: ctx.changes, minutesSinceLastAction: minutesSinceLastChange(ctx.serviceId) });
    ctx.emit({ kind: "policy", op: input.op, verdict: gate.verdict, rule: gate.rule, reason: gate.reason });

    if (gate.verdict === "refuse") {
      recordAction({ incidentId: ctx.incidentId, serviceId: ctx.serviceId, op: input.op, risk: gate.risk, input: args.input, intent: input.why, verdict: "refuse", rule: gate.rule, reason: gate.reason });
      return { refused: true, rule: gate.rule, reason: gate.reason, note: "Do not try to reach the same end another way. Say so in your report instead." };
    }

    if (gate.verdict === "ask") {
      // One question per operation per incident. If it has been answered, honour the answer.
      const existing = findDecisionFor(ctx.incidentId, input.op);
      if (existing?.answer) {
        if (existing.answer !== "approve") return { refused: true, rule: "owner-declined", reason: `The owner was asked and said no: "${existing.answer}".` };
      } else {
        // The PREPARED arguments, not the ones the model typed: the owner is approving the call that
        // would actually run, defaults filled in and validated, not a sketch of it.
        const proposal = `${input.op}\n${JSON.stringify(args.input)}\n\n${input.why}`;
        const d =
          existing ??
          openDecision({
            serviceId: ctx.serviceId,
            incidentId: ctx.incidentId,
            kind: "approve_action",
            question: `Warden wants to ${describeAct(input.op, args.input)} on ${ctx.service.name}. Approve?`,
            proposal,
            because: gate.reason,
            options: [
              { value: "approve", label: "Approve", tone: "primary" },
              { value: "no", label: "No — leave it", tone: "quiet" },
            ],
          });
        if (!ctx.asked.some((a) => a.decisionId === d.id)) {
          ctx.asked.push({ decisionId: d.id, interruptId: null, op: input.op });
          ctx.emit({ kind: "decision", decisionId: d.id, question: d.question, proposal: d.proposal, because: d.because, interruptId: null });
        }
        recordAction({ incidentId: ctx.incidentId, serviceId: ctx.serviceId, op: input.op, risk: gate.risk, input: args.input, intent: input.why, verdict: "ask", rule: gate.rule, reason: gate.reason });
        updateIncident(ctx.incidentId, { status: "waiting" });

        // THE HALT. The run genuinely stops here and is resumed with the owner's answer.
        const answer = context!.interrupt<string>({
          name: "approve_action",
          reason: { decisionId: d.id, question: d.question, op: input.op, args: JSON.stringify(args.input), why: input.why, because: gate.reason },
        });
        if (answer !== "approve") return { refused: true, rule: "owner-declined", reason: `The owner said no: "${answer}".` };
      }
    }

    // Allowed, or approved. Do it.
    return performAct(ctx, input.op, args.input, input.why, gate.rule, gate.reason);
  },
});

async function performAct(ctx: IncidentContext, op: OperationName, args: Record<string, unknown>, why: string, rule: string, reason: string) {
  const target = targetOf(ctx.service);
  const res = await execute(op, args, target);
  ctx.emit({ kind: "act", op, command: res.command, why });
  const summary = summarise(res.stdout, res.stderr, res.error, 900);
  ctx.changes = changesMade(ctx.incidentId) + 1;
  recordAction({
    incidentId: ctx.incidentId,
    serviceId: ctx.serviceId,
    op,
    risk: riskOf(op),
    input: args,
    intent: why,
    verdict: "allow",
    rule,
    reason,
    command: res.command,
    ok: res.ok,
    output: summary,
    exitCode: res.code,
    ms: res.ms,
  });
  ctx.emit({ kind: "acted", op, ok: res.ok, summary: summary.slice(0, 260), ms: res.ms });
  return {
    done: true,
    ok: res.ok,
    command: res.command,
    ms: res.ms,
    output: summary,
    note: "Warden will now re-run the probe that failed. Whether this worked is decided by that reading, not by you.",
  };
}

function describeAct(op: string, input: Record<string, unknown>): string {
  const p = typeof input.process === "string" ? input.process : "";
  if (op === "pm2_restart") return `restart ${p}`;
  if (op === "pm2_start") return `start ${p}`;
  if (op === "redeploy_previous") return `roll ${p} back to the previous build`;
  if (op === "run_tests") return `run the test suite`;
  return op;
}

/* ── giving up honestly ───────────────────────────────────────────── */

export const giveUp = tool({
  name: "give_up",
  description:
    "Say that you cannot finish this one. Use it when the evidence does not support a fix you are allowed to make, or when what you tried did not work. An honest escalation is a good outcome; guessing at a production system is not.",
  inputSchema: z.object({
    why: z.string().min(20).max(800).describe("what you found, what you tried, and what a human will need to do. Be specific enough that they do not have to start over."),
  }),
  callback: (input, context) => {
    const ctx = ctxOf(context);
    ctx.gaveUp = input.why;
    updateIncident(ctx.incidentId, { status: "escalated", resolution: input.why });
    return { recorded: true };
  },
});

export const listTried = tool({
  name: "list_tried",
  description: "The authoritative record of everything run on this incident. If it shows no acts, none have been attempted — whatever you think you remember. Read it before acting again: repeating a failed act is not a new idea.",
  inputSchema: z.object({}),
  callback: (_input, context) => {
    const ctx = ctxOf(context);
    const rows = listActions(ctx.incidentId);
    const acts = rows.filter((a) => a.risk !== "read");
    return {
      summary: acts.length === 0 ? "No act has been attempted on this incident. Nothing has been refused." : `${acts.length} act(s) attempted.`,
      actions: rows.map((a) => ({
        op: a.op,
        verdict: a.verdict,
        rule: a.rule,
        command: a.command,
        ok: a.ok,
        output: (a.output ?? "").slice(0, 400),
      })),
      changesMade: ctx.changes,
    };
  },
});
