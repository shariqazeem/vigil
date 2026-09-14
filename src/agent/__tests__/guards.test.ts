/**
 * The six refusals, driven through the real hook.
 *
 * No model is called and no network is touched. A real `Agent` is constructed with a stub model, a
 * real `VigilGuards` is attached to it, a real `PassContext` is opened with `openContext()`, and a
 * real `BeforeToolCallEvent` — the same class the SDK constructs before it runs a tool — is pushed
 * through the callback the plugin registered. `event.cancel` carrying a string is exactly what the
 * SDK turns into "the tool did not run"; that is what each of these asserts.
 *
 * Every guard gets both halves: the refusal, and the case next to it that must still be allowed.
 * A guard that refuses everything is not a guard, it is a broken product.
 */
import {
  Agent,
  BeforeToolCallEvent,
  Model,
  type BaseModelConfig,
  type HookCallback,
  type HookCallbackOptions,
  type HookableEvent,
  type HookableEventConstructor,
  type LocalAgent,
  type ModelStreamEvent,
} from "@strands-agents/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import type { Thing } from "@/lib/db/schema";
import { CONFIDENCE_FLOOR, VigilGuards } from "../guards";
import { openContext, type Candidate, type PassContext } from "../pass-context";

/* ── the harness ──────────────────────────────────────────────────────────── */

/** A model that cannot be called. If a test ever reaches inference, it fails loudly. */
class StubModel extends Model {
  updateConfig(): void {}
  getConfig(): BaseModelConfig {
    return { modelId: "stub-no-inference" };
  }
  async *stream(): AsyncIterable<ModelStreamEvent> {
    throw new Error("a guard test called a model");
    yield undefined as never;
  }
}

/**
 * Attach a real `VigilGuards` to a real `Agent` and hand back the BeforeToolCall callback it
 * registered, so a test can dispatch an event through it directly. The plugin registers through
 * the agent's own `addHook`; the proxy only watches it go past.
 */
function attachGuards(agent: Agent): HookCallback<BeforeToolCallEvent> {
  let captured: HookCallback<BeforeToolCallEvent> | undefined;
  const watched = new Proxy(agent, {
    get(target, prop) {
      if (prop !== "addHook") return Reflect.get(target, prop) as unknown;
      return <T extends HookableEvent>(type: HookableEventConstructor<T>, cb: HookCallback<T>, opts?: HookCallbackOptions) => {
        if (type === (BeforeToolCallEvent as HookableEventConstructor)) captured = cb as unknown as HookCallback<BeforeToolCallEvent>;
        return target.addHook(type, cb, opts);
      };
    },
  }) as LocalAgent;
  new VigilGuards().initAgent(watched);
  if (!captured) throw new Error("VigilGuards registered no BeforeToolCallEvent hook");
  return captured;
}

type Payload = Record<string, string | number | boolean | null>;

const agent = new Agent({ model: new StubModel(), printer: false });
const hook = attachGuards(agent);

let passes = 0;

const thing = (p: Partial<Thing> = {}): Thing => ({
  id: "th_car",
  householdId: "hh_1",
  kind: "product",
  label: "a thing",
  make: null,
  model: null,
  year: null,
  identifier: null,
  category: null,
  acquiredAt: null,
  secondHand: false,
  note: null,
  confidence: 1,
  unknowns: "[]",
  decoded: null,
  addedVia: "typed",
  addedAt: 0,
  retiredAt: null,
  ...p,
});

const candidate = (p: Partial<Candidate> = {}): Candidate => ({
  sourceId: "24V001000",
  source: "nhtsa-recalls",
  sourceUrl: null,
  thingId: "th_car",
  title: "a record",
  summary: "the government's words",
  consequence: null,
  remedy: null,
  component: null,
  unitsAffected: null,
  date: null,
  raw: {},
  ...p,
});

/** A live pass with the things and records a test needs, and nothing else. */
function pass(opts: { things?: Thing[]; candidates?: Candidate[]; standing?: string[] } = {}): PassContext {
  const ctx = openContext({
    passId: `p_guard_${++passes}`,
    householdId: "hh_1",
    things: opts.things ?? [thing()],
    standing: opts.standing ?? [],
    expected: [],
    emit: () => {},
  });
  ctx.candidates.push(...(opts.candidates ?? [candidate()]));
  return ctx;
}

/** Push one tool call through the guard exactly as the agent loop would, and return the event. */
async function rule(ctx: PassContext, input: Payload, toolName = "rule_on_candidate"): Promise<BeforeToolCallEvent> {
  const event = new BeforeToolCallEvent({
    agent,
    toolUse: { name: toolName, toolUseId: `tu_${passes}_${Math.random().toString(36).slice(2)}`, input },
    tool: undefined,
    invocationState: { passId: ctx.passId },
  });
  await hook(event);
  return event;
}

const refusal = (e: BeforeToolCallEvent): string => {
  expect(typeof e.cancel, `expected a refusal, got ${String(e.cancel)}`).toBe("string");
  return String(e.cancel);
};

const allowed = (e: BeforeToolCallEvent): void => {
  expect(e.cancel, `expected to be allowed, refused with: ${String(e.cancel)}`).toBeFalsy();
};

beforeEach(() => {
  VigilGuards.refusals.length = 0;
});

/* ── 1. no invented records ───────────────────────────────────────────────── */

describe("no-invented-records", () => {
  it("refuses a verdict on a campaign number that never came back this pass", async () => {
    const ctx = pass({ candidates: [candidate({ sourceId: "24V001000" })] });
    const e = await rule(ctx, { thingId: "th_car", sourceId: "24V999000", verdict: "covers", confidence: 0.99, severity: "high" });
    expect(refusal(e)).toContain('no record "24V999000"');
    expect(VigilGuards.refusals.map((r) => r.rule)).toEqual(["no-invented-records"]);
  });

  it("refuses a real record ruled against the wrong thing", async () => {
    const ctx = pass({
      things: [thing({ id: "th_car" }), thing({ id: "th_cot", label: "the cot" })],
      candidates: [candidate({ sourceId: "24V001000", thingId: "th_car" })],
    });
    expect(refusal(await rule(ctx, { thingId: "th_cot", sourceId: "24V001000", verdict: "covers", confidence: 0.9, severity: "high" }))).toContain("no record");
  });

  it("allows a verdict on a record that did come back", async () => {
    const ctx = pass({ candidates: [candidate({ sourceId: "24V001000" })] });
    allowed(await rule(ctx, { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.9, severity: "high" }));
    expect(VigilGuards.refusals).toHaveLength(0);
  });
});

/* ── 2. no alarm on a hunch ───────────────────────────────────────────────── */

describe("no-alarm-on-a-hunch", () => {
  it("refuses `covers` below the confidence floor", async () => {
    const ctx = pass();
    const e = await rule(ctx, { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.2, severity: "high" });
    expect(refusal(e)).toContain("below Vigil's floor");
    expect(refusal(e)).toContain("20%");
    expect(VigilGuards.refusals.map((r) => r.rule)).toEqual(["no-alarm-on-a-hunch"]);
  });

  it("refuses `covers` with no confidence at all", async () => {
    const ctx = pass();
    expect(refusal(await rule(ctx, { thingId: "th_car", sourceId: "24V001000", verdict: "covers", severity: "high" }))).toContain("below Vigil's floor");
  });

  it("allows `covers` exactly at the floor, and anything above it", async () => {
    allowed(await rule(pass(), { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: CONFIDENCE_FLOOR, severity: "high" }));
    allowed(await rule(pass(), { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.61, severity: "high" }));
  });

  it("does not apply the floor to `unsure` — asking is always allowed", async () => {
    allowed(await rule(pass(), { thingId: "th_car", sourceId: "24V001000", verdict: "unsure", confidence: 0.1, severity: "watch", missing: "the date code" }));
  });
});

/* ── 3. no clearing a brand match ─────────────────────────────────────────── */

describe("no-clearing-a-brand-match", () => {
  const seat = thing({ id: "th_car", make: "Graco", model: "4Ever DLX", category: "child restraint", label: "Ayesha's car seat" });

  it("refuses `clear` when the record names the brand AND a word about the object", async () => {
    const ctx = pass({
      things: [seat],
      candidates: [
        candidate({
          sourceId: "24-123",
          source: "cpsc-recalls",
          title: "Graco recalls child restraint systems",
          summary: "Graco 4Ever DLX child restraint systems sold nationwide.",
        }),
      ],
    });
    const e = await rule(ctx, { thingId: "th_car", sourceId: "24-123", verdict: "clear", confidence: 0.95, severity: "watch" });
    expect(refusal(e)).toContain('names "Graco"');
    expect(refusal(e)).toContain("wrong all-clear");
    expect(VigilGuards.refusals.map((r) => r.rule)).toEqual(["no-clearing-a-brand-match"]);
  });

  it("catches the near miss the guard exists for: VBM55 against a VBM55RX label", async () => {
    const monitor = thing({ id: "th_car", make: "Babysense", model: "VBM55", category: "baby monitor", label: "the baby monitor" });
    const ctx = pass({
      things: [monitor],
      candidates: [
        candidate({
          sourceId: "24-456",
          source: "cpsc-recalls",
          title: "Babysense recalls video baby monitors",
          summary: "The recall involves Babysense VBM55RX video baby monitors.",
        }),
      ],
    });
    expect(refusal(await rule(ctx, { thingId: "th_car", sourceId: "24-456", verdict: "clear", confidence: 0.9, severity: "watch" }))).toContain("Babysense");
  });

  it("allows `clear` on the same brand's different object — a brand alone is not a match", async () => {
    const bottle = thing({ id: "th_car", make: "vitafusion", model: "Melatonin", category: "dietary supplement", label: "the melatonin bottle" });
    const ctx = pass({
      things: [bottle],
      candidates: [
        candidate({
          sourceId: "F-0123-2026",
          source: "openfda",
          title: "vitafusion Fiber Well",
          summary: "vitafusion Fiber Well, 90 count, distributed nationwide.",
        }),
      ],
    });
    allowed(await rule(ctx, { thingId: "th_car", sourceId: "F-0123-2026", verdict: "clear", confidence: 0.9, severity: "watch" }));
    expect(VigilGuards.refusals).toHaveLength(0);
  });

  it("allows `clear` on a record from another brand entirely", async () => {
    const ctx = pass({
      things: [seat],
      candidates: [candidate({ sourceId: "24-789", source: "cpsc-recalls", title: "Britax recalls child restraint systems", summary: "Britax ClickTight child restraint systems." })],
    });
    allowed(await rule(ctx, { thingId: "th_car", sourceId: "24-789", verdict: "clear", confidence: 0.9, severity: "watch" }));
  });

  it("still allows `covers` and `unsure` on a brand match — only the all-clear is refused", async () => {
    const ctx = pass({
      things: [seat],
      candidates: [candidate({ sourceId: "24-123", source: "cpsc-recalls", title: "Graco recalls child restraints", summary: "Graco 4Ever DLX child restraint systems." })],
    });
    allowed(await rule(ctx, { thingId: "th_car", sourceId: "24-123", verdict: "unsure", confidence: 0.4, severity: "high", missing: "the date code under the seat" }));
    allowed(await rule(ctx, { thingId: "th_car", sourceId: "24-123", verdict: "covers", confidence: 0.9, severity: "high" }));
  });
});

/* ── 4. no covering a window nobody has checked ───────────────────────────── */

describe("no-covering-an-unchecked-window", () => {
  const cot = thing({ id: "th_car", make: "IKEA", model: "SNIGLAR", category: "cot", label: "the cot" });
  const windowed = candidate({
    sourceId: "24-321",
    source: "cpsc-recalls",
    title: "Cots recalled",
    summary: "The cots were manufactured between January 2019 and March 2020. The date code is printed on a label under the mattress support.",
  });

  it("refuses `covers` on a manufacture-window record when nobody knows which unit this is", async () => {
    const ctx = pass({ things: [cot], candidates: [windowed] });
    const e = await rule(ctx, { thingId: "th_car", sourceId: "24-321", verdict: "covers", confidence: 0.95, severity: "high" });
    expect(refusal(e)).toContain("only covers units from a particular run");
    expect(VigilGuards.refusals.map((r) => r.rule)).toEqual(["no-covering-an-unchecked-window"]);
  });

  it("refuses it for a lot number and for a serial range too", async () => {
    for (const summary of [
      "Consumers should check the lot number printed on the bottom of the bottle.",
      "The serial number is on the rating plate at the rear of the heater.",
      "The units were sold between March 2021 and June 2022 at retailers nationwide.",
    ]) {
      const ctx = pass({ things: [cot], candidates: [candidate({ sourceId: "24-321", source: "cpsc-recalls", summary })] });
      expect(refusal(await rule(ctx, { thingId: "th_car", sourceId: "24-321", verdict: "covers", confidence: 0.95, severity: "high" }))).toContain("particular run");
    }
  });

  it("allows it once the household has said when it got the thing", async () => {
    const ctx = pass({ things: [thing({ ...cot, acquiredAt: Date.UTC(2019, 5, 1) })], candidates: [windowed] });
    allowed(await rule(ctx, { thingId: "th_car", sourceId: "24-321", verdict: "covers", confidence: 0.95, severity: "high" }));
  });

  it("allows it once the owner has answered yes about that exact record", async () => {
    // The real format written by resumeWithAnswer(): the question, then what they said.
    const ctx = pass({
      things: [cot],
      candidates: [windowed],
      standing: ['Does recall 24-321 cover your cot? — you answered "yes": the date code under the base reads 1909.'],
    });
    allowed(await rule(ctx, { thingId: "th_car", sourceId: "24-321", verdict: "covers", confidence: 0.95, severity: "high" }));
  });

  it("is NOT unlocked by a standing rule that merely mentions the record", async () => {
    // "stop asking me about 24-321" is not the owner saying the recall covers their cot.
    const ctx = pass({ things: [cot], candidates: [windowed], standing: ["Stop asking me about 24-321."] });
    expect(refusal(await rule(ctx, { thingId: "th_car", sourceId: "24-321", verdict: "covers", confidence: 0.95, severity: "high" }))).toContain("particular run");
  });

  it("does not apply to NHTSA vehicle recalls, which are scoped by model and VIN", async () => {
    const ctx = pass({
      things: [cot],
      candidates: [candidate({ sourceId: "24V001000", source: "nhtsa-recalls", summary: "Vehicles manufactured between 1 Jan 2019 and 3 Mar 2020 may have a faulty fuel pump." })],
    });
    allowed(await rule(ctx, { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.95, severity: "high" }));
  });

  it("does not apply to a record with no window in it", async () => {
    const ctx = pass({
      things: [cot],
      candidates: [candidate({ sourceId: "24-999", source: "cpsc-recalls", summary: "All SNIGLAR cots are being recalled; no units are excluded." })],
    });
    allowed(await rule(ctx, { thingId: "th_car", sourceId: "24-999", verdict: "covers", confidence: 0.95, severity: "high" }));
  });
});

/* ── 5. severity must be evidenced ────────────────────────────────────────── */

describe("severity-must-be-evidenced", () => {
  const benign = candidate({
    sourceId: "24V001000",
    title: "Label may be missing information",
    summary: "The certification label may omit the tyre inflation pressure.",
    consequence: "The vehicle fails to conform to the requirements of the standard.",
  });

  it("refuses `critical` on a record whose own words say nothing dangerous", async () => {
    const ctx = pass({ candidates: [benign] });
    const e = await rule(ctx, { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.95, severity: "critical" });
    expect(refusal(e)).toContain('"critical" is not supported by the record');
    expect(VigilGuards.refusals.map((r) => r.rule)).toEqual(["severity-must-be-evidenced"]);
  });

  it("allows `critical` when the government set its own do-not-drive flag", async () => {
    allowed(await rule(pass({ candidates: [candidate({ ...benign, parkIt: true })] }), { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.95, severity: "critical" }));
    allowed(await rule(pass({ candidates: [candidate({ ...benign, parkOutSide: true })] }), { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.95, severity: "critical" }));
  });

  it("allows `critical` when the record's own words carry it", async () => {
    for (const summary of [
      "An engine compartment fire may occur while parked.",
      "The seat back may collapse in a crash.",
      "Ingestion of the magnets can cause death.",
    ]) {
      allowed(await rule(pass({ candidates: [candidate({ ...benign, summary })] }), { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.95, severity: "critical" }));
    }
  });

  it("leaves the severities the record does support alone", async () => {
    allowed(await rule(pass({ candidates: [benign] }), { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.95, severity: "high" }));
    allowed(await rule(pass({ candidates: [benign] }), { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.95, severity: "watch" }));
  });
});

/* ── 6. one settled verdict per record ────────────────────────────────────── */

describe("one-settled-verdict-per-record", () => {
  it("refuses a second verdict once the record has been settled", async () => {
    const ctx = pass();
    ctx.ruled.set("th_car::24V001000", "covers");
    const e = await rule(ctx, { thingId: "th_car", sourceId: "24V001000", verdict: "clear", confidence: 0.99, severity: "watch" });
    expect(refusal(e)).toContain('already been ruled "covers"');
    expect(VigilGuards.refusals.map((r) => r.rule)).toEqual(["one-verdict-per-record"]);
  });

  it("refuses it in the other direction too — a `clear` cannot become a `covers`", async () => {
    const ctx = pass();
    ctx.ruled.set("th_car::24V001000", "clear");
    expect(refusal(await rule(ctx, { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.99, severity: "high" }))).toContain('already been ruled "clear"');
  });

  it("lets an earlier `unsure` be settled — a question is not a verdict", async () => {
    const ctx = pass();
    ctx.ruled.set("th_car::24V001000", "unsure");
    allowed(await rule(ctx, { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.9, severity: "high" }));
  });

  it("keeps the count per (thing, record), not per record", async () => {
    const ctx = pass({
      things: [thing({ id: "th_car" }), thing({ id: "th_van", label: "the van" })],
      candidates: [candidate({ thingId: "th_car" }), candidate({ thingId: "th_van" })],
    });
    ctx.ruled.set("th_car::24V001000", "covers");
    allowed(await rule(ctx, { thingId: "th_van", sourceId: "24V001000", verdict: "covers", confidence: 0.9, severity: "high" }));
  });
});

/* ── the hook's own boundaries ────────────────────────────────────────────── */

describe("the hook itself", () => {
  it("says nothing about tools that are not rule_on_candidate", async () => {
    const e = await rule(pass(), { thingId: "th_car" }, "list_candidates");
    allowed(e);
  });

  it("stays out of the way when there is no live pass — the tool refuses that itself", async () => {
    const event = new BeforeToolCallEvent({
      agent,
      toolUse: { name: "rule_on_candidate", toolUseId: "tu_nopass", input: { thingId: "th_car", sourceId: "24V001000", verdict: "covers", confidence: 0.9, severity: "high" } },
      tool: undefined,
      invocationState: {},
    });
    await hook(event);
    expect(event.cancel).toBeFalsy();
  });
});
