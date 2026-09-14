import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AfterToolCallEvent,
  Agent,
  BeforeToolCallEvent,
  JsonBlock,
  Model,
  TextBlock,
  ToolResultBlock,
  type BaseModelConfig,
  type HookableEvent,
  type InvocationState,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import type { Incident, Service } from "@/lib/db/schema";
import { DEFAULT_POLICY } from "@/lib/ops/policy";
import { TwoHandsOnly, WardenGuards } from "../guards";
import { closeContext, openContext, type IncidentContext } from "../incident-context";

/**
 * The four rules in `WardenGuards`, driven through the real hook on a real Agent.
 *
 * Nothing here is a mock of the guard. A real `BeforeToolCallEvent` is constructed and dispatched
 * through the agent's own hook registry, exactly as the agent loop dispatches it, and the assertion
 * is on `event.cancel` — the field the loop reads to decide whether the tool runs at all.
 *
 * The agent's model throws if it is ever asked for inference. A guard test that quietly called a
 * model would be testing a model.
 */

class NeverModel extends Model {
  calls = 0;
  override updateConfig(): void {}
  override getConfig(): BaseModelConfig {
    return { modelId: "warden-test-never-called" };
  }
  override stream(): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    throw new Error("a guard test asked the model for inference; it must never get that far");
  }
}

const SERVICE: Service = {
  id: "svc_test",
  ownerKey: "owner_test",
  name: "demo",
  matters: "the demo is what people look at",
  host: "local",
  hookUrl: null,
  sshKey: null,
  repo: "/srv/demo",
  process: "demo",
  nodeBin: null,
  policy: JSON.stringify(DEFAULT_POLICY),
  state: "watching",
  lastSweptAt: null,
  createdAt: 0,
  updatedAt: 0,
};

const incidentRow = (id: string): Incident => ({
  id,
  serviceId: SERVICE.id,
  probeId: "prb_test",
  title: "demo: the site is failing",
  status: "open",
  severity: "down",
  symptom: "expected 200, got 502",
  diagnosis: null,
  suspect: null,
  confidence: null,
  resolution: null,
  verifiedByReadingId: null,
  openedAt: Date.now(),
  resolvedAt: null,
  downSeconds: null,
});

let model: NeverModel;
let agent: Agent;
let ctx: IncidentContext;
let incidentId: string;
let seq = 0;

/** Dispatch an event through the agent's own hook registry, the way the agent loop does. */
async function dispatch<T extends HookableEvent>(event: T): Promise<T> {
  const registry = (agent as unknown as { _hooksRegistry: { invokeCallbacks<E>(e: E): Promise<E> } })._hooksRegistry;
  return registry.invokeCallbacks(event);
}

const state = (): InvocationState => ({ incidentId });

function before(name: string, input: unknown): BeforeToolCallEvent {
  return new BeforeToolCallEvent({
    agent,
    toolUse: { name, toolUseId: `tu_${(seq += 1)}`, input: input as never },
    tool: undefined,
    invocationState: state(),
  });
}

/**
 * The tool result the `act` tool returns when the policy refused it, as the loop actually carries
 * it: the tool returns an object, and the SDK wraps an object in a JsonBlock — not a TextBlock.
 */
function refusalResult(toolUseId: string, rule: string): ToolResultBlock {
  return new ToolResultBlock({
    toolUseId,
    status: "success",
    content: [new JsonBlock({ json: { refused: true, rule, reason: "your policy says no" } })],
  });
}

const lastRefusal = () => WardenGuards.refusals.at(-1);

beforeEach(async () => {
  WardenGuards.refusals.length = 0;
  model = new NeverModel();
  agent = new Agent({ model, tools: [], plugins: [new WardenGuards()], printer: false, retryStrategy: null });
  // Plugins register their hooks here, exactly as they do before a real run.
  await agent.initialize();
  incidentId = `inc_${(seq += 1)}_${Date.now()}`;
  ctx = openContext({
    incidentId,
    serviceId: SERVICE.id,
    service: SERVICE,
    incident: incidentRow(incidentId),
    policy: DEFAULT_POLICY,
    standing: [],
    allowedOrigins: ["http://127.0.0.1:39999"],
    emit: () => {},
  });
});

afterEach(() => {
  expect(model.calls, "the guards must never reach a model").toBe(0);
  closeContext(incidentId);
});

/* ── rule 1 ────────────────────────────────────────────────────────── */

describe("rule 1 — no operation that does not exist", () => {
  it("refuses an act naming an operation that is not in the catalogue", async () => {
    for (const op of ["shell", "run_command", "rm_rf", "", "PM2_RESTART", "pm2_restart ", "curl"]) {
      WardenGuards.refusals.length = 0;
      const e = await dispatch(before("act", { op, input: {} }));
      expect(typeof e.cancel, op).toBe("string");
      expect(String(e.cancel), op).toContain("there is no operation called");
      expect(lastRefusal(), op).toEqual({ rule: "unknown-operation", detail: op });
    }
  });

  it("refuses a look naming an operation that is not in the catalogue", async () => {
    const e = await dispatch(before("look", { op: "cat_etc_passwd", input: {} }));
    expect(typeof e.cancel).toBe("string");
    expect(lastRefusal()?.rule).toBe("unknown-operation");
  });

  it("lets a real operation through", async () => {
    ctx.diagnosis = "pm2 says the process is errored";
    const e = await dispatch(before("act", { op: "pm2_restart", input: { process: "demo" } }));
    expect(e.cancel).toBe(false);
    expect(WardenGuards.refusals).toHaveLength(0);
  });
});

/* ── rule 2 ────────────────────────────────────────────────────────── */

describe("rule 2 — `look` is read-only, and cannot be used to smuggle an act", () => {
  it("refuses a look pointed at anything that changes the running system", async () => {
    for (const op of ["pm2_restart", "pm2_start", "run_tests", "redeploy_previous", "db_migrate", "delete_data"]) {
      WardenGuards.refusals.length = 0;
      const e = await dispatch(before("look", { op, input: { process: "demo" } }));
      expect(typeof e.cancel, op).toBe("string");
      expect(String(e.cancel), op).toContain("not something to \"look\" at");
      expect(lastRefusal(), op).toEqual({ rule: "look-must-be-read-only", detail: op });
    }
  });

  it("lets a look at a read operation through, with no diagnosis needed", async () => {
    expect(ctx.diagnosis).toBeNull();
    for (const op of ["pm2_list", "pm2_logs", "git_log", "git_show", "read_file", "grep_repo", "disk_free", "http_probe"]) {
      const e = await dispatch(before("look", { op, input: {} }));
      expect(e.cancel, op).toBe(false);
    }
    expect(WardenGuards.refusals).toHaveLength(0);
  });
});

/* ── rule 3 ────────────────────────────────────────────────────────── */

describe("rule 3 — no acting before diagnosing", () => {
  it("refuses an act while the incident has no recorded diagnosis", async () => {
    const e = await dispatch(before("act", { op: "pm2_restart", input: { process: "demo" } }));
    expect(typeof e.cancel).toBe("string");
    expect(String(e.cancel)).toContain("record_diagnosis first");
    expect(lastRefusal()).toEqual({ rule: "no-acting-before-diagnosing", detail: "pm2_restart" });
  });

  it("lets the same act through the moment a diagnosis is recorded", async () => {
    const refused = await dispatch(before("act", { op: "pm2_restart", input: { process: "demo" } }));
    expect(refused.cancel).not.toBe(false);

    ctx.diagnosis = "the log ends with 'Error: listen EADDRINUSE' and pm2 says errored";
    const allowed = await dispatch(before("act", { op: "pm2_restart", input: { process: "demo" } }));
    expect(allowed.cancel).toBe(false);
  });

  it("does not remember a refused act as attempted, so it can be tried once properly", async () => {
    await dispatch(before("act", { op: "pm2_restart", input: { process: "demo" } }));
    expect(ctx.attempted.size).toBe(0);
  });
});

/* ── rule 4 ────────────────────────────────────────────────────────── */

describe("rule 4 — no second go at the same act", () => {
  beforeEach(() => {
    ctx.diagnosis = "the process is errored and the log shows a crash on boot";
  });

  it("allows an act once and refuses the identical one after it", async () => {
    const first = await dispatch(before("act", { op: "pm2_restart", input: { process: "demo" } }));
    expect(first.cancel).toBe(false);
    expect(ctx.attempted.has('pm2_restart:{"process":"demo"}')).toBe(true);

    const second = await dispatch(before("act", { op: "pm2_restart", input: { process: "demo" } }));
    expect(typeof second.cancel).toBe("string");
    expect(String(second.cancel)).toContain("already run pm2_restart with those arguments");
    expect(lastRefusal()?.rule).toBe("no-second-go");
  });

  it("counts the arguments, not just the name — a different act is a new idea", async () => {
    expect((await dispatch(before("act", { op: "pm2_restart", input: { process: "demo" } }))).cancel).toBe(false);
    expect((await dispatch(before("act", { op: "pm2_restart", input: { process: "other" } }))).cancel).toBe(false);
    expect((await dispatch(before("act", { op: "pm2_start", input: { process: "demo" } }))).cancel).toBe(false);
    expect(WardenGuards.refusals).toHaveLength(0);
  });

  it("does not let one tool call trip its own guard when the hook runs twice for it", async () => {
    // The SDK may dispatch the same tool call more than once (a retry inside the loop). The
    // signature is keyed by the toolUseId that claimed it, so a call is never refused by itself.
    const call = before("act", { op: "pm2_restart", input: { process: "demo" } });
    await dispatch(call);
    expect(call.cancel).toBe(false);
    call.cancel = false;
    await dispatch(call);
    expect(call.cancel).toBe(false);
    expect(WardenGuards.refusals).toHaveLength(0);
  });

  it("is scoped to one incident", async () => {
    await dispatch(before("act", { op: "pm2_restart", input: { process: "demo" } }));
    const other = openContext({
      incidentId: "inc_elsewhere",
      serviceId: SERVICE.id,
      service: SERVICE,
      incident: incidentRow("inc_elsewhere"),
      policy: DEFAULT_POLICY,
      standing: [],
      allowedOrigins: [],
      emit: () => {},
    });
    other.diagnosis = "a different failure entirely";
    const e = new BeforeToolCallEvent({
      agent,
      toolUse: { name: "act", toolUseId: "tu_other", input: { op: "pm2_restart", input: { process: "demo" } } },
      tool: undefined,
      invocationState: { incidentId: "inc_elsewhere" },
    });
    await dispatch(e);
    expect(e.cancel).toBe(false);
    closeContext("inc_elsewhere");
  });
});

/* ── rule 5 ────────────────────────────────────────────────────────── */

describe("rule 5 — no acting past a refusal", () => {
  beforeEach(() => {
    ctx.diagnosis = "the last deploy broke the boot path";
  });

  it("remembers a refusal from the act's own result, then refuses the operation by any route", async () => {
    const first = before("act", { op: "redeploy_previous", input: { process: "demo" } });
    await dispatch(first);
    expect(first.cancel).toBe(false);

    // The policy refused it; the loop carries that result back through AfterToolCallEvent.
    await dispatch(
      new AfterToolCallEvent({
        agent,
        toolUse: first.toolUse,
        tool: undefined,
        result: refusalResult(first.toolUse.toolUseId, "policy-never"),
        invocationState: state(),
      }),
    );
    expect(ctx.refused.has("redeploy_previous")).toBe(true);

    // Same operation, reworded arguments — the thing rule 4 would miss.
    const again = await dispatch(before("act", { op: "redeploy_previous", input: { process: "demo", quiet: true } }));
    expect(typeof again.cancel).toBe("string");
    expect(String(again.cancel)).toContain("already refused on this incident");
    expect(lastRefusal()).toEqual({ rule: "no-acting-past-a-refusal", detail: "redeploy_previous" });
  });

  it("reports the repeat rule first when the arguments are identical too", async () => {
    ctx.refused.add("pm2_restart");
    ctx.attempted.set('pm2_restart:{"process":"demo"}', "tu_an_earlier_call");
    await dispatch(before("act", { op: "pm2_restart", input: { process: "demo" } }));
    expect(lastRefusal()?.rule).toBe("no-second-go");
  });

  it("reads a refusal that arrived as plain text too", async () => {
    const call = before("act", { op: "pm2_start", input: { process: "demo" } });
    await dispatch(call);
    await dispatch(
      new AfterToolCallEvent({
        agent,
        toolUse: call.toolUse,
        tool: undefined,
        result: new ToolResultBlock({
          toolUseId: call.toolUse.toolUseId,
          status: "success",
          content: [new TextBlock(JSON.stringify({ refused: true, rule: "policy-never" }))],
        }),
        invocationState: state(),
      }),
    );
    expect(ctx.refused.has("pm2_start")).toBe(true);
  });

  it("does not remember a result that was not a refusal", async () => {
    const call = before("act", { op: "pm2_restart", input: { process: "demo" } });
    await dispatch(call);
    await dispatch(
      new AfterToolCallEvent({
        agent,
        toolUse: call.toolUse,
        tool: undefined,
        result: new ToolResultBlock({ toolUseId: call.toolUse.toolUseId, status: "success", content: [new TextBlock(JSON.stringify({ done: true, ok: true }))] }),
        invocationState: state(),
      }),
    );
    expect(ctx.refused.size).toBe(0);
  });

  it("ignores a refusal reported against a look, which has no policy of its own to defy", async () => {
    const call = before("look", { op: "http_probe", input: { url: "http://elsewhere/" } });
    await dispatch(call);
    await dispatch(
      new AfterToolCallEvent({
        agent,
        toolUse: call.toolUse,
        tool: undefined,
        result: refusalResult(call.toolUse.toolUseId, "own-addresses-only"),
        invocationState: state(),
      }),
    );
    expect(ctx.refused.size).toBe(0);
  });
});

/* ── the hook's own edges ──────────────────────────────────────────── */

describe("the hook's edges", () => {
  it("leaves tools that are neither hand alone", async () => {
    for (const name of ["read_incident", "record_diagnosis", "give_up", "list_tried"]) {
      const e = await dispatch(before(name, { op: "db_migrate" }));
      expect(e.cancel, name).toBe(false);
    }
    expect(WardenGuards.refusals).toHaveLength(0);
  });

  it("does nothing when there is no live incident to check against", async () => {
    // The tools themselves throw "tool called outside an incident" in this case, so the hook
    // standing down is not a hole — but it is worth pinning down that it stands down quietly.
    const e = new BeforeToolCallEvent({
      agent,
      toolUse: { name: "act", toolUseId: "tu_nostate", input: { op: "rm_rf", input: {} } },
      tool: undefined,
      invocationState: {},
    });
    await dispatch(e);
    expect(e.cancel).toBe(false);

    const gone = new BeforeToolCallEvent({
      agent,
      toolUse: { name: "act", toolUseId: "tu_dead", input: { op: "rm_rf", input: {} } },
      tool: undefined,
      invocationState: { incidentId: "inc_that_was_closed" },
    });
    await dispatch(gone);
    expect(gone.cancel).toBe(false);
  });

  it("keeps the refusal diagnostic bounded", async () => {
    for (let i = 0; i < 260; i += 1) await dispatch(before("act", { op: `made_up_${i}`, input: {} }));
    expect(WardenGuards.refusals.length).toBeLessThanOrEqual(200);
    expect(lastRefusal()?.detail).toBe("made_up_259");
  });
});

/* ── two hands ─────────────────────────────────────────────────────── */

describe("TwoHandsOnly — Warden has exactly two hands", () => {
  const hands = new TwoHandsOnly();
  const call = (name: string) =>
    hands.beforeToolCall(
      new BeforeToolCallEvent({ agent, toolUse: { name, toolUseId: "tu_iv", input: {} }, tool: undefined, invocationState: state() }),
    );

  it("denies anything whose name suggests it runs a command", () => {
    for (const name of ["shell", "bash", "exec", "run_command", "execute_shell", "sudo_run", "ssh_into", "curl_url", "python_repl", "file_editor", "eval_js", "spawn_process", "http_request"]) {
      const action = call(name);
      expect(action.type, name).toBe("deny");
      expect(action.type === "deny" && action.reason, name).toContain("no general-purpose shell");
    }
  });

  it("lets exactly the six real tools proceed", () => {
    for (const name of ["read_incident", "look", "record_diagnosis", "act", "give_up", "list_tried"]) {
      expect(call(name).type, name).toBe("proceed");
    }
  });

  it("is a name rule, not a whitelist — an unrelated future tool is not blocked by it", () => {
    expect(call("summarise_incident").type).toBe("proceed");
  });
});
