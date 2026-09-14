import { AfterToolCallEvent, BeforeToolCallEvent, HookOrder, InterventionActions, InterventionHandler, type LocalAgent, type Plugin } from "@strands-agents/sdk";
import { riskOf, OPERATION_NAMES, type OperationName } from "@/lib/ops/operations";
import { contextFor, type IncidentContext } from "./incident-context";

/**
 * The rules that hold whatever the model does, written where it cannot argue with them.
 *
 * The policy in `src/lib/ops/policy.ts` decides what Warden may do on a given service. These are
 * the rules underneath that, which no policy can switch off:
 *
 *   1. NO OPERATION THAT DOES NOT EXIST. The catalogue is the whole surface. A name that is not in
 *      it is refused here before anything is spawned.
 *   2. NO ACTING BEFORE DIAGNOSING. `act` without a recorded diagnosis is refused — an agent that
 *      restarts things to see what happens is not an operator.
 *   3. NO SECOND GO AT THE SAME ACT. The same operation with the same arguments, twice on one
 *      incident, is refused. Restarting again is not a new idea, and the loop it creates is the
 *      most likely way an autonomous operator does real damage.
 *   4. NO ACTING PAST A REFUSAL. Once an act has been refused on this incident, the same operation
 *      cannot be re-attempted with different wording.
 *
 * Each is a property `guards.test.ts` proves by pushing a deliberately jailbroken tool call through
 * the real hook and asserting nothing ran.
 */

export class WardenGuards implements Plugin {
  readonly name = "warden:guards";

  /** Every refusal, bounded — this is a long-lived process and a diagnostic that grows is a leak. */
  static readonly refusals: { rule: string; detail: string }[] = [];
  private static note(rule: string, detail: string): void {
    WardenGuards.refusals.push({ rule, detail });
    if (WardenGuards.refusals.length > 200) WardenGuards.refusals.splice(0, WardenGuards.refusals.length - 200);
  }

  initAgent(agent: LocalAgent): void {
    agent.addHook(
      BeforeToolCallEvent,
      (e) => {
        const name = e.toolUse.name;
        if (name !== "act" && name !== "look") return;
        const ctx = passOf(e.invocationState);
        if (!ctx) return;
        const input = (e.toolUse.input ?? {}) as { op?: string; input?: Record<string, unknown> };
        const op = String(input.op ?? "");

        if (!OPERATION_NAMES.includes(op as OperationName)) {
          WardenGuards.note("unknown-operation", op);
          e.cancel = `Refused: there is no operation called "${op}". Warden can only do the things in its catalogue — call read_incident to see it.`;
          return;
        }
        if (name === "look" && riskOf(op as OperationName) !== "read") {
          WardenGuards.note("look-must-be-read-only", op);
          e.cancel = `Refused: ${op} changes the running system, so it is not something to "look" at. Use act, and the policy will decide.`;
          return;
        }
        if (name !== "act") return;

        if (!ctx.diagnosis) {
          WardenGuards.note("no-acting-before-diagnosing", op);
          e.cancel = "Refused: Warden does not touch a running system before it can say what is wrong with it. Call record_diagnosis first.";
          return;
        }

        const signature = `${op}:${JSON.stringify(input.input ?? {})}`;
        if (ctx.attempted.has(signature)) {
          WardenGuards.note("no-second-go", signature);
          e.cancel = `Refused: you have already run ${op} with those arguments on this incident. Doing it again is not a new idea — either try something the evidence supports, or call give_up.`;
          return;
        }
        if (ctx.refused.has(op)) {
          WardenGuards.note("no-acting-past-a-refusal", op);
          e.cancel = `Refused: ${op} was already refused on this incident. Reaching the same end another way is exactly what Warden must not do. Say so in your report instead.`;
          return;
        }
        ctx.attempted.add(signature);
      },
      { order: HookOrder.SDK_FIRST - 1 },
    );

    // A refused act is remembered, so the fourth rule has something to stand on.
    agent.addHook(AfterToolCallEvent, (e) => {
      if (e.toolUse.name !== "act") return;
      const ctx = passOf(e.invocationState);
      if (!ctx) return;
      const block = e.result?.content?.[0];
      const text = block && block.type === "textBlock" ? block.text : "";
      if (!text.includes('"refused":true')) return;
      const op = String(((e.toolUse.input ?? {}) as { op?: string }).op ?? "");
      if (op) ctx.refused.add(op);
    });
  }
}

function passOf(invocationState: Record<string, unknown> | undefined): IncidentContext | null {
  const incidentId = (invocationState as { incidentId?: string } | undefined)?.incidentId;
  if (!incidentId) return null;
  try {
    return contextFor(incidentId);
  } catch {
    return null;
  }
}

/**
 * The declarative half of the same boundary, as a Strands intervention. It states the shape of the
 * product: Warden has exactly two hands, and a tool that is neither of them does not exist. Any
 * future tool whose name suggests it runs a command is denied here before anyone can wire it up.
 */
export class TwoHandsOnly extends InterventionHandler {
  readonly name = "warden:two-hands-only";
  private static readonly SHELL_SHAPED = /(shell|bash|exec|spawn|command|eval|sudo|ssh|curl|http_request|file_editor|python)/i;
  private static readonly ALLOWED = new Set(["read_incident", "look", "record_diagnosis", "act", "give_up", "list_tried"]);

  override beforeToolCall(event: BeforeToolCallEvent) {
    const name = event.toolUse.name;
    if (TwoHandsOnly.ALLOWED.has(name)) return InterventionActions.proceed();
    if (TwoHandsOnly.SHELL_SHAPED.test(name)) {
      return InterventionActions.deny(
        "Warden has no general-purpose shell and never will. It can only invoke named operations from its catalogue, through `look` and `act`, where the service's policy decides.",
      );
    }
    return InterventionActions.proceed();
  }
}
