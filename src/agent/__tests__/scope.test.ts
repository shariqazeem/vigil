import { describe, expect, it } from "vitest";
import { act, giveUp, listTried, look, readIncident, recordDiagnosis } from "@/agent/tools";

/**
 * A TOOL CANNOT BE POINTED AT SOMEBODY ELSE'S INCIDENT.
 *
 * Which incident a tool is working on comes from `invocationState`, which the server sets when it
 * starts the graph. The model never supplies it and cannot influence it — and the reason that holds
 * is structural rather than careful: no tool has an argument for it. There is nothing to pass.
 *
 * That is worth an assertion rather than a comment, because the natural way to extend any of these
 * tools later is to add a field, and `serviceId` or `incidentId` is exactly the field somebody
 * would add. Several services run under one process, and one of them is somebody else's production
 * that Warden is only allowed to look at.
 */
const TOOLS = { read_incident: readIncident, look, record_diagnosis: recordDiagnosis, act, give_up: giveUp, list_tried: listTried };

/** The top-level argument names a model is able to supply for one tool. */
function fieldsOf(t: unknown): string[] {
  // The SDK's `tool()` keeps the zod schema on `_inputSchema`, and zod v4 keeps the object's shape
  // under `def`. Both are reached through a cast rather than a type, so the assertion below that
  // these are the fields we expect is what stops this reading an empty object and passing.
  const schema = (t as { _inputSchema?: { def?: { shape?: Record<string, unknown> }; shape?: Record<string, unknown> } })._inputSchema;
  return Object.keys(schema?.def?.shape ?? schema?.shape ?? {});
}

const callbackOf = (t: unknown) => (t as { _callback: (input: unknown, ctx: unknown) => unknown })._callback;

/** Some callbacks are sync and throw, some are async and reject. Either is a refusal. */
async function refusal(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("it did not refuse");
}

describe("what a model is allowed to name", () => {
  it.each(Object.entries(TOOLS))("%s takes no incident or service of its own", (name, t) => {
    const forbidden = fieldsOf(t).filter((f) => /incident|service|owner|target|host|ssh|key/i.test(f));
    expect(forbidden, `${name} must not let the model choose what it is working on`).toEqual([]);
  });

  it("still takes the arguments it is supposed to, so this is not passing vacuously", () => {
    expect(fieldsOf(act).sort()).toEqual(["input", "op", "why"]);
    expect(fieldsOf(look).sort()).toEqual(["input", "op", "why"]);
    expect(fieldsOf(recordDiagnosis).sort()).toEqual(["confidence", "diagnosis", "suspect"]);
  });

  it("refuses to run at all when the server has not said which incident this is", async () => {
    // invocationState is the server's, not the model's. Without it there is no context to resolve
    // and the tool must fail rather than guess at one.
    expect(await refusal(() => callbackOf(listTried)({}, { invocationState: {} }))).toMatch(/outside an incident/);
    expect(await refusal(() => callbackOf(listTried)({}, undefined))).toMatch(/outside an incident/);
  });

  it("refuses an incident id that is not a live run, rather than resurrecting one", async () => {
    expect(await refusal(() => callbackOf(listTried)({}, { invocationState: { incidentId: "inc_not_running" } }))).toMatch(/no live incident/);
  });
});
