import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * A QUESTION THAT STOPPED MATTERING.
 *
 * This happened on the live fleet. Warden started a stopped process, then asked whether it could
 * also run the test suite, and the run halted holding that question. The service was up. The board
 * said it was down and waiting on a human — and the sweep leaves a service alone while a question
 * is outstanding, so it would have stayed that way until somebody answered a question about
 * something that no longer mattered.
 *
 * The product's own rule settles it: the probe says whether it is fixed. A withdrawn question is
 * recorded as an answer with its reason, never deleted, because the decisions table is the record
 * of what was asked and what came of it.
 */
const env = vi.hoisted(() => {
  const dir = `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/warden-withdraw-${process.pid}-${Date.now()}`;
  process.env.WARDEN_DB_PATH = `${dir}/warden.db`;
  delete (globalThis as { __wardenDb?: unknown }).__wardenDb;
  return { dir };
});

import { rmSync } from "node:fs";
import { addService, getDecision, openDecision, pendingDecisions, withdrawDecision } from "@/lib/db/warden";
import { OBSERVE_ONLY } from "@/lib/ops/policy";

afterAll(() => rmSync(env.dir, { recursive: true, force: true }));

const ask = (serviceId: string) =>
  openDecision({
    serviceId,
    incidentId: "inc_test",
    kind: "approve_action",
    question: "Warden wants to run the test suite on Vigil. Approve?",
    proposal: "run_tests\n{}",
    because: "the cooldown",
    options: [{ value: "approve", label: "Approve" }],
  });

describe("withdrawing a question", () => {
  it("takes it out of what is waiting on a human", () => {
    const s = addService({ ownerKey: "anon:w", name: "Vigil", host: "local", policy: OBSERVE_ONLY });
    const d = ask(s.id);
    expect(pendingDecisions(s.id).map((x) => x.id)).toContain(d.id);

    withdrawDecision(d.id, "the check passed after what Warden had already done");
    expect(pendingDecisions(s.id)).toHaveLength(0);
  });

  it("keeps the question and records why it was withdrawn, rather than deleting it", () => {
    const s = addService({ ownerKey: "anon:w2", name: "Vigil", host: "local", policy: OBSERVE_ONLY });
    const d = ask(s.id);
    withdrawDecision(d.id, "the check passed after what Warden had already done");

    const after = getDecision(d.id)!;
    expect(after.question).toBe(d.question);
    expect(after.answer).toBe("withdrawn");
    expect(after.answerNote).toContain("the check passed");
    expect(after.answeredAt).toBeTruthy();
  });

  it("is not mistaken for a person approving it", () => {
    const s = addService({ ownerKey: "anon:w3", name: "Vigil", host: "local", policy: OBSERVE_ONLY });
    const d = ask(s.id);
    withdrawDecision(d.id, "no longer needed");
    // Anything that acts on an approval must not act on this.
    expect(getDecision(d.id)!.answer).not.toBe("approve");
  });
});
