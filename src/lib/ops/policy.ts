import { z } from "zod";
import { OPERATION_NAMES, OPERATIONS, riskOf, type OperationName, type Risk } from "./operations";

/**
 * THE POLICY. What a particular service lets Warden do without asking.
 *
 * This is the whole product in one file. An agent that can do anything is not an operator, it is a
 * liability; an agent that can do nothing is a dashboard. The useful thing sits in between and it
 * has to be written down, per service, by a human, in terms they would defend afterwards:
 *
 *     may      Warden does it, and tells you afterwards.
 *     ask      Warden works out exactly what it would do, then stops and asks. The run halts.
 *     never    Warden refuses, and says which rule refused it.
 *
 * The decision is made here, in code, from the policy row — never by the model, and never from a
 * sentence in a prompt. `decide()` is pure, so `policy.test.ts` can prove every branch of it
 * without a model, a network, or a machine to break.
 */

export const PolicySchema = z.object({
  /** operations Warden may perform unattended */
  may: z.array(z.string()).default([]),
  /** operations Warden must stop and ask about, however confident it is */
  ask: z.array(z.string()).default([]),
  /** the outer edge: refused whatever the policy above says */
  never: z.array(z.string()).default([]),
  /** at most this many acts on one incident before Warden must come back to you */
  maxActionsPerIncident: z.number().int().min(0).max(20).default(3),
  /** it may not act on the same service more often than this */
  cooldownMinutes: z.number().int().min(0).max(1440).default(10),
  /** a human sentence shown next to the service, in the owner's words */
  note: z.string().max(400).default(""),
});
export type Policy = z.infer<typeof PolicySchema>;

/** What a new service gets: look at everything, restart itself, ask before anything that sticks. */
export const DEFAULT_POLICY: Policy = {
  may: ["http_probe", "tls_expiry", "pm2_list", "pm2_logs", "git_log", "git_show", "read_file", "grep_repo", "disk_free", "pm2_restart", "pm2_start", "run_tests"],
  ask: ["redeploy_previous"],
  never: ["db_migrate", "delete_data", "rotate_secret", "destroy_infra"],
  maxActionsPerIncident: 3,
  cooldownMinutes: 10,
  note: "Look at anything. Restart yourself. Ask me before anything that does not undo itself.",
};

/**
 * For a service where a restart is not obviously safe. Everything reads, nothing acts without a
 * human — Warden works out exactly what it would do, shows it, and stops. Used for things that are
 * load-bearing in a way a restart could make worse, including Warden's own console: an operator
 * that restarts itself in the middle of an incident loses the run it was in the middle of.
 */
export const ASK_BEFORE_ACTING: Policy = {
  may: ["http_probe", "tls_expiry", "pm2_list", "pm2_logs", "git_log", "git_show", "read_file", "grep_repo", "disk_free"],
  ask: ["pm2_restart", "pm2_start", "run_tests", "redeploy_previous"],
  never: ["db_migrate", "delete_data", "rotate_secret", "destroy_infra"],
  maxActionsPerIncident: 2,
  cooldownMinutes: 10,
  note: "Look at anything. Work out the fix and show me exactly what you would run — but ask me before you run it.",
};

/**
 * What this policy amounts to, in three words, for the card on the board.
 *
 * Derived from the policy itself rather than guessed from the shape of it: a service is "observe"
 * when nothing that changes anything is permitted, "ask-first" when every such operation needs a
 * human, and "may-act" when at least one can happen without waking anybody. Reading the operation
 * catalogue for what counts as "changes anything" means a new reversible operation is covered the
 * day it is added, rather than the day someone remembers to update a list in a component.
 */
/**
 * A policy arriving from outside — a form, an import, an API call — made safe to store.
 *
 * Storing is not deciding: `decide()` refuses a forbidden operation whatever any policy says, so
 * nothing here is load-bearing for safety. It is load-bearing for HONESTY. A policy row that
 * appears to grant `delete_data` would be shown on the service page as granted, and a person would
 * reasonably believe they had granted it. So the four forbidden operations are stripped out of
 * `may` and `ask` and pinned into `never`, where the page will say what is true: never, under any
 * policy. Anything the catalogue has never heard of is dropped rather than stored as a lie about a
 * capability.
 */
export function sanitisePolicy(input: unknown): Policy {
  const parsed = PolicySchema.safeParse(input);
  if (!parsed.success) return OBSERVE_ONLY;
  const p = parsed.data;
  const known = (xs: string[]) => xs.filter((op) => KNOWN.has(op));
  const forbidden = OPERATION_NAMES.filter((n) => riskOf(n) === "forbidden");
  const strip = (xs: string[]) => known(xs).filter((op) => !forbidden.includes(op as OperationName));
  const never = [...new Set([...known(p.never), ...forbidden])];
  const ask = strip(p.ask).filter((op) => !never.includes(op));
  return {
    ...p,
    may: strip(p.may).filter((op) => !never.includes(op) && !ask.includes(op)),
    ask,
    never,
  };
}

export type Posture = "observe" | "ask-first" | "may-act";

export function posture(p: Policy): Posture {
  const changing = OPERATION_NAMES.filter((n) => {
    const r = riskOf(n);
    return r === "reversible" || r === "disruptive";
  });
  if (p.maxActionsPerIncident === 0) return "observe";
  const unattended = changing.filter((n) => p.may.includes(n) && !p.never.includes(n) && !p.ask.includes(n));
  if (unattended.length > 0) return "may-act";
  const asks = changing.filter((n) => p.ask.includes(n) && !p.never.includes(n));
  return asks.length > 0 ? "ask-first" : "observe";
}

export const POSTURE_WORDS: Record<Posture, { label: string; tone: "unknown" | "warn" | "accent" }> = {
  observe: { label: "observe only", tone: "unknown" },
  "ask-first": { label: "asks first", tone: "warn" },
  "may-act": { label: "may act", tone: "accent" },
};

/** A service Warden may only read. Used for anything it does not own — someone else's production. */
export const OBSERVE_ONLY: Policy = {
  may: ["http_probe", "tls_expiry", "pm2_list", "pm2_logs", "git_log", "git_show", "read_file", "grep_repo", "disk_free"],
  ask: [],
  never: ["pm2_restart", "pm2_start", "run_tests", "redeploy_previous", "db_migrate", "delete_data", "rotate_secret", "destroy_infra"],
  maxActionsPerIncident: 0,
  cooldownMinutes: 0,
  note: "Watch and diagnose. Touch nothing — this service is not ours to operate.",
};

export type Verdict = "allow" | "ask" | "refuse";

export interface Decision {
  verdict: Verdict;
  /** the rule that decided, in the words the product shows a human */
  rule: string;
  /** why, in one sentence, addressed to the person who wrote the policy */
  reason: string;
  risk: Risk;
}

export interface PolicyContext {
  /** how many acts Warden has already performed on this incident */
  actionsTaken: number;
  /** minutes since Warden last acted on this service, or null if it never has */
  minutesSinceLastAction: number | null;
}

const KNOWN = new Set(Object.keys(OPERATIONS));

/**
 * The single decision. Pure: same inputs, same answer, no clock, no model, no network.
 *
 * Order matters and is deliberate. An unknown operation is refused before anything else, because
 * the safest answer to "may I do a thing you have never heard of" is no. Forbidden risk is refused
 * before the policy is consulted at all, so no policy can grant it. `never` beats `may`, so adding
 * something to the deny list is always sufficient. Caps are checked last, because a human reading
 * "you have already acted twice on this incident" wants to know the act was otherwise permitted.
 */
export function decide(op: string, policy: Policy, ctx: PolicyContext): Decision {
  if (!KNOWN.has(op)) {
    return { verdict: "refuse", rule: "unknown-operation", reason: `Warden has no operation called "${op}". It can only do the things in its catalogue.`, risk: "forbidden" };
  }
  const name = op as OperationName;
  const risk = riskOf(name);

  if (risk === "forbidden") {
    return { verdict: "refuse", rule: "forbidden-always", reason: `${op} is outside what Warden may ever do. This is not a policy setting and no policy can turn it on.`, risk };
  }
  if (policy.never.includes(op)) {
    return { verdict: "refuse", rule: "policy-never", reason: `Your policy for this service lists ${op} under "never".`, risk };
  }
  if (policy.ask.includes(op)) {
    return { verdict: "ask", rule: "policy-ask", reason: `Your policy says to ask you before ${op}.`, risk };
  }
  if (!policy.may.includes(op)) {
    return { verdict: "ask", rule: "not-granted", reason: `Your policy does not grant ${op} on this service, so Warden will not do it without you.`, risk };
  }

  // Granted. Now the two limits that stop a granted permission becoming an unbounded one.
  if (risk !== "read") {
    if (ctx.actionsTaken >= policy.maxActionsPerIncident) {
      return {
        verdict: "ask",
        rule: "action-cap",
        reason: `Warden has already acted ${ctx.actionsTaken} time${ctx.actionsTaken === 1 ? "" : "s"} on this incident, which is the limit you set. Something it is doing is not working.`,
        risk,
      };
    }
    if (ctx.minutesSinceLastAction !== null && ctx.minutesSinceLastAction < policy.cooldownMinutes) {
      return {
        verdict: "ask",
        rule: "cooldown",
        reason: `Warden acted on this service ${ctx.minutesSinceLastAction} minute${ctx.minutesSinceLastAction === 1 ? "" : "s"} ago and your cooldown is ${policy.cooldownMinutes}. Restarting in a loop is not a fix.`,
        risk,
      };
    }
  }

  return { verdict: "allow", rule: "policy-may", reason: `Your policy grants ${op} on this service.`, risk };
}

/** The policy as the agent is told it: what it may do here, and what it will have to ask about. */
export function describePolicy(policy: Policy): string {
  const line = (label: string, ops: string[]) => (ops.length ? `${label}: ${ops.join(", ")}` : null);
  return [
    policy.note ? `In the owner's words: "${policy.note}"` : null,
    line("You may do these without asking", policy.may),
    line("You must stop and ask before", policy.ask),
    line("You may never do", policy.never),
    `At most ${policy.maxActionsPerIncident} action${policy.maxActionsPerIncident === 1 ? "" : "s"} on one incident, and no acting twice within ${policy.cooldownMinutes} minutes.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function parsePolicy(raw: string | null | undefined): Policy {
  if (!raw) return DEFAULT_POLICY;
  try {
    return PolicySchema.parse(JSON.parse(raw));
  } catch {
    // A policy that will not parse is not a reason to widen what Warden may do.
    return OBSERVE_ONLY;
  }
}
