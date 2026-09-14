import { describe, expect, it } from "vitest";
import { OPERATIONS, OPERATION_NAMES, catalogue, execute, riskOf, type OperationName } from "../operations";
import { hasMachine, stanceOf } from "@/lib/ops/local";
import { ASK_BEFORE_ACTING, DEFAULT_POLICY, OBSERVE_ONLY, POSTURE_WORDS, PolicySchema, decide, describePolicy, parsePolicy, posture, sanitisePolicy, type Policy, type PolicyContext } from "../policy";

/**
 * `decide()` is the whole product in one pure function, so it is tested the way a pure function
 * should be: every branch, by hand, with no mocks, no clock and no machine.
 *
 * The order of the branches is the property that matters most. A policy is a document a human wrote
 * and will be judged on; if "never" could lose to "may", or if a forbidden operation could be
 * switched on by adding a line to a JSON column, the document would be worthless.
 */

const FORBIDDEN: OperationName[] = ["db_migrate", "delete_data", "rotate_secret", "destroy_infra"];
const FRESH: PolicyContext = { actionsTaken: 0, minutesSinceLastAction: null };

const policy = (over: Partial<Policy> = {}): Policy => ({
  may: [],
  ask: [],
  never: [],
  maxActionsPerIncident: 3,
  cooldownMinutes: 10,
  note: "",
  ...over,
});

/** The most permissive policy anybody could write: everything Warden knows about, under "may". */
const PERMISSIVE = policy({ may: [...OPERATION_NAMES], maxActionsPerIncident: 20, cooldownMinutes: 0 });

describe("decide — the order of the rules", () => {
  it("refuses an operation it has never heard of, before anything else is consulted", () => {
    const d = decide("rm_rf", policy({ may: ["rm_rf"], ask: ["rm_rf"], never: ["rm_rf"] }), FRESH);
    expect(d.verdict).toBe("refuse");
    expect(d.rule).toBe("unknown-operation");
    expect(d.risk).toBe("forbidden");
    expect(d.reason).toContain("rm_rf");
  });

  it("refuses an unknown operation however permissive the policy is", () => {
    for (const made_up of ["", "shell", "run_command", "pm2_restart ; rm -rf /", "PM2_RESTART", "http_probe "]) {
      const d = decide(made_up, PERMISSIVE, FRESH);
      expect(d.verdict, made_up).toBe("refuse");
      expect(d.rule, made_up).toBe("unknown-operation");
    }
  });

  it("refuses forbidden risk before the policy is consulted at all — no policy can grant it", () => {
    for (const op of FORBIDDEN) {
      // Listed under "may", by the most permissive policy anybody could write.
      const granted = decide(op, PERMISSIVE, FRESH);
      expect(granted.verdict, op).toBe("refuse");
      expect(granted.rule, op).toBe("forbidden-always");
      expect(granted.reason, op).toContain("no policy can turn it on");

      // Listed under "never" too: the rule that answers is still the forbidden one, which is how
      // you can see the policy was never reached.
      const denied = decide(op, policy({ may: [op], never: [op], ask: [op] }), FRESH);
      expect(denied.rule, op).toBe("forbidden-always");
    }
  });

  it("lets `never` beat `may`", () => {
    const d = decide("pm2_restart", policy({ may: ["pm2_restart"], never: ["pm2_restart"] }), FRESH);
    expect(d.verdict).toBe("refuse");
    expect(d.rule).toBe("policy-never");
    expect(d.risk).toBe("reversible");
  });

  it("lets `never` beat `may` for reads as well — a deny list has no exceptions", () => {
    const d = decide("pm2_logs", policy({ may: ["pm2_logs"], never: ["pm2_logs"] }), FRESH);
    expect(d.verdict).toBe("refuse");
    expect(d.rule).toBe("policy-never");
  });

  it("lets `ask` beat `may`", () => {
    const d = decide("pm2_restart", policy({ may: ["pm2_restart"], ask: ["pm2_restart"] }), FRESH);
    expect(d.verdict).toBe("ask");
    expect(d.rule).toBe("policy-ask");
  });

  it("asks — never allows — when an operation is in none of the three lists", () => {
    const d = decide("pm2_restart", policy(), FRESH);
    expect(d.verdict).toBe("ask");
    expect(d.rule).toBe("not-granted");
    expect(d.reason).toContain("does not grant");
  });

  it("asks for an ungranted READ too: silence is never permission", () => {
    const d = decide("grep_repo", policy({ may: ["pm2_list"] }), FRESH);
    expect(d.verdict).toBe("ask");
    expect(d.rule).toBe("not-granted");
  });

  it("allows what the policy grants", () => {
    const d = decide("pm2_restart", policy({ may: ["pm2_restart"] }), FRESH);
    expect(d.verdict).toBe("allow");
    expect(d.rule).toBe("policy-may");
    expect(d.reason).toContain("grants pm2_restart");
  });
});

describe("decide — the two limits on a granted permission", () => {
  const granted = policy({ may: ["pm2_restart", "pm2_list"], maxActionsPerIncident: 2, cooldownMinutes: 10 });

  it("allows a non-read act below the cap", () => {
    expect(decide("pm2_restart", granted, { actionsTaken: 1, minutesSinceLastAction: null }).verdict).toBe("allow");
  });

  it("asks once the action cap is reached, and again beyond it", () => {
    for (const taken of [2, 3, 99]) {
      const d = decide("pm2_restart", granted, { actionsTaken: taken, minutesSinceLastAction: null });
      expect(d.verdict, `${taken}`).toBe("ask");
      expect(d.rule, `${taken}`).toBe("action-cap");
    }
  });

  it("reads the cap as a limit on acts, so a cap of 0 means Warden may look but never touch", () => {
    const lookOnly = policy({ may: ["pm2_restart", "pm2_list"], maxActionsPerIncident: 0, cooldownMinutes: 0 });
    expect(decide("pm2_restart", lookOnly, FRESH).rule).toBe("action-cap");
    expect(decide("pm2_list", lookOnly, FRESH).verdict).toBe("allow");
  });

  it("never applies the action cap to a read", () => {
    for (const op of OPERATION_NAMES.filter((n) => riskOf(n) === "read")) {
      const d = decide(op, policy({ may: [op], maxActionsPerIncident: 0 }), { actionsTaken: 999, minutesSinceLastAction: 0 });
      expect(d.verdict, op).toBe("allow");
      expect(d.rule, op).toBe("policy-may");
    }
  });

  it("asks inside the cooldown and allows on or after it", () => {
    expect(decide("pm2_restart", granted, { actionsTaken: 0, minutesSinceLastAction: 0 }).rule).toBe("cooldown");
    expect(decide("pm2_restart", granted, { actionsTaken: 0, minutesSinceLastAction: 9 }).rule).toBe("cooldown");
    expect(decide("pm2_restart", granted, { actionsTaken: 0, minutesSinceLastAction: 10 }).verdict).toBe("allow");
    expect(decide("pm2_restart", granted, { actionsTaken: 0, minutesSinceLastAction: 11 }).verdict).toBe("allow");
  });

  it("treats 'has never acted on this service' as outside the cooldown", () => {
    expect(decide("pm2_restart", granted, { actionsTaken: 0, minutesSinceLastAction: null }).verdict).toBe("allow");
  });

  it("has no cooldown at all when the policy sets none", () => {
    const nocool = policy({ may: ["pm2_restart"], cooldownMinutes: 0 });
    expect(decide("pm2_restart", nocool, { actionsTaken: 0, minutesSinceLastAction: 0 }).verdict).toBe("allow");
  });

  it("never applies the cooldown to a read", () => {
    for (const op of OPERATION_NAMES.filter((n) => riskOf(n) === "read")) {
      const d = decide(op, policy({ may: [op], cooldownMinutes: 1440 }), { actionsTaken: 0, minutesSinceLastAction: 0 });
      expect(d.verdict, op).toBe("allow");
    }
  });

  it("reports the action cap first when both limits are breached", () => {
    const d = decide("pm2_restart", granted, { actionsTaken: 5, minutesSinceLastAction: 0 });
    expect(d.rule).toBe("action-cap");
  });

  it("applies both limits to disruptive risk, not only reversible", () => {
    const p = policy({ may: ["redeploy_previous"], maxActionsPerIncident: 1, cooldownMinutes: 10 });
    expect(decide("redeploy_previous", p, { actionsTaken: 1, minutesSinceLastAction: null }).rule).toBe("action-cap");
    expect(decide("redeploy_previous", p, { actionsTaken: 0, minutesSinceLastAction: 1 }).rule).toBe("cooldown");
    expect(decide("redeploy_previous", p, FRESH).verdict).toBe("allow");
  });

  it("never turns a limit into a refusal — a cap is a question, not a wall", () => {
    for (const ctx of [{ actionsTaken: 99, minutesSinceLastAction: null }, { actionsTaken: 0, minutesSinceLastAction: 0 }]) {
      expect(decide("pm2_restart", granted, ctx).verdict).toBe("ask");
    }
  });
});

describe("decide — purity", () => {
  it("gives the same answer for the same inputs and mutates nothing", () => {
    const p = policy({ may: ["pm2_restart"], ask: ["redeploy_previous"], never: ["run_tests"] });
    const before = JSON.stringify(p);
    const ctx: PolicyContext = { actionsTaken: 1, minutesSinceLastAction: 30 };
    const a = decide("pm2_restart", p, ctx);
    const b = decide("pm2_restart", p, ctx);
    expect(a).toEqual(b);
    expect(JSON.stringify(p)).toBe(before);
    expect(ctx).toEqual({ actionsTaken: 1, minutesSinceLastAction: 30 });
  });

  it("reports the operation's real risk on every verdict it can", () => {
    for (const op of OPERATION_NAMES) {
      const d = decide(op, PERMISSIVE, FRESH);
      expect(d.risk, op).toBe(riskOf(op));
    }
  });
});

describe("decide — every operation under the two shipped policies", () => {
  it("DEFAULT_POLICY: read and restart alone, ask before what does not undo itself, never the forbidden four", () => {
    const expected: Record<OperationName, string> = {
      http_probe: "allow",
      tls_expiry: "allow",
      dns_lookup: "allow",
      http_headers: "allow",
      pm2_list: "allow",
      pm2_logs: "allow",
      git_log: "allow",
      git_show: "allow",
      read_file: "allow",
      grep_repo: "allow",
      disk_free: "allow",
      pm2_restart: "allow",
      pm2_start: "allow",
      run_tests: "allow",
      call_hook: "allow",
      redeploy_previous: "ask",
      db_migrate: "refuse",
      delete_data: "refuse",
      rotate_secret: "refuse",
      destroy_infra: "refuse",
    };
    for (const op of OPERATION_NAMES) expect(decide(op, DEFAULT_POLICY, FRESH).verdict, op).toBe(expected[op]);
  });

  it("OBSERVE_ONLY: every read allowed, every act refused by name", () => {
    for (const op of OPERATION_NAMES) {
      const d = decide(op, OBSERVE_ONLY, FRESH);
      if (riskOf(op) === "read") {
        expect(d.verdict, op).toBe("allow");
      } else {
        expect(d.verdict, op).toBe("refuse");
        expect(d.rule, op).toBe(riskOf(op) === "forbidden" ? "forbidden-always" : "policy-never");
      }
    }
  });

  it("names only real operations in the shipped policies, and sorts each one exactly once", () => {
    for (const p of [DEFAULT_POLICY, ASK_BEFORE_ACTING, OBSERVE_ONLY]) {
      const all = [...p.may, ...p.ask, ...p.never];
      for (const op of all) expect(OPERATION_NAMES, op).toContain(op);
      expect(new Set(all).size).toBe(all.length);
      expect(new Set(all)).toEqual(new Set(OPERATION_NAMES));
    }
  });

  it("call_hook — the one act a URL-only service has — is sorted like a restart on every preset", () => {
    expect(riskOf("call_hook")).toBe("reversible");
    expect(decide("call_hook", DEFAULT_POLICY, FRESH).verdict).toBe("allow");
    expect(decide("call_hook", ASK_BEFORE_ACTING, FRESH).verdict).toBe("ask");
    expect(decide("call_hook", OBSERVE_ONLY, FRESH)).toMatchObject({ verdict: "refuse", rule: "policy-never" });
  });

  it("the two new network reads are granted on every preset, like the http check itself", () => {
    for (const p of [DEFAULT_POLICY, ASK_BEFORE_ACTING, OBSERVE_ONLY]) {
      expect(decide("dns_lookup", p, FRESH).verdict).toBe("allow");
      expect(decide("http_headers", p, FRESH).verdict).toBe("allow");
    }
  });

  it("keeps the forbidden four on every shipped policy's never list, belt and braces", () => {
    for (const p of [DEFAULT_POLICY, ASK_BEFORE_ACTING, OBSERVE_ONLY]) for (const op of FORBIDDEN) expect(p.never).toContain(op);
    expect(FORBIDDEN.every((op) => OPERATIONS[op].risk === "forbidden")).toBe(true);
    expect(OPERATION_NAMES.filter((n) => riskOf(n) === "forbidden").sort()).toEqual([...FORBIDDEN].sort());
  });
});

describe("parsePolicy", () => {
  it("gives a service with no policy written down the default one", () => {
    expect(parsePolicy(null)).toEqual(DEFAULT_POLICY);
    expect(parsePolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(parsePolicy("")).toEqual(DEFAULT_POLICY);
  });

  it("round-trips a policy that parses", () => {
    const p = policy({ may: ["pm2_list"], ask: ["pm2_restart"], never: ["run_tests"], note: "careful with this one" });
    expect(parsePolicy(JSON.stringify(p))).toEqual(p);
  });

  it("fills the defaults in for a partial policy", () => {
    const p = parsePolicy(JSON.stringify({ may: ["pm2_list"] }));
    expect(p.may).toEqual(["pm2_list"]);
    expect(p.ask).toEqual([]);
    expect(p.never).toEqual([]);
    expect(p.maxActionsPerIncident).toBe(3);
    expect(p.cooldownMinutes).toBe(10);
  });

  it("falls back to OBSERVE_ONLY on anything that will not parse", () => {
    for (const raw of ["{", "not json at all", "[]", '{"may":"pm2_restart"}', '{"maxActionsPerIncident":99}', '{"cooldownMinutes":-1}', "null", '{"may":["pm2_list"],']) {
      expect(parsePolicy(raw), raw).toEqual(OBSERVE_ONLY);
    }
  });

  it("means a policy that will not parse cannot widen what Warden may do", () => {
    const broken = parsePolicy('{"may":["pm2_restart","redeploy_previous","db_migrate"]');
    expect(decide("pm2_restart", broken, FRESH).verdict).toBe("refuse");
    expect(decide("redeploy_previous", broken, FRESH).verdict).toBe("refuse");
    expect(decide("db_migrate", broken, FRESH).verdict).toBe("refuse");
    expect(decide("pm2_list", broken, FRESH).verdict).toBe("allow");
  });

  it("refuses a policy whose numbers are outside the schema rather than clamping them", () => {
    expect(PolicySchema.safeParse({ maxActionsPerIncident: 21 }).success).toBe(false);
    expect(PolicySchema.safeParse({ cooldownMinutes: 1441 }).success).toBe(false);
    expect(PolicySchema.safeParse({ maxActionsPerIncident: 1.5 }).success).toBe(false);
    expect(PolicySchema.safeParse({}).success).toBe(true);
  });
});

describe("describePolicy", () => {
  it("tells the agent what it may do, what it must ask about, and the limits", () => {
    const text = describePolicy(DEFAULT_POLICY);
    expect(text).toContain(DEFAULT_POLICY.note);
    expect(text).toContain("pm2_restart");
    expect(text).toContain("redeploy_previous");
    expect(text).toContain("db_migrate");
    expect(text).toContain("At most 3 actions");
    expect(text).toContain("10 minutes");
  });

  it("says nothing about a list that is empty rather than saying 'none'", () => {
    const text = describePolicy(policy({ may: ["pm2_list"] }));
    expect(text).toContain("You may do these without asking: pm2_list");
    expect(text).not.toContain("You must stop and ask before");
    expect(text).not.toContain("You may never do");
  });
});

/**
 * The three words on a service card. This is what an owner glances at to know whether the thing
 * watching their production can touch it, so it has to be derived from the policy rather than from
 * a guess about the shape of one — and it has to stay right when a new operation is added.
 */
describe("the posture a card shows", () => {
  it("calls a policy that permits nothing an observer", () => {
    expect(posture(OBSERVE_ONLY)).toBe("observe");
  });

  it("calls a policy with an unattended restart an actor", () => {
    expect(posture(DEFAULT_POLICY)).toBe("may-act");
  });

  it("calls a policy whose every change needs a human an asker", () => {
    expect(posture(ASK_BEFORE_ACTING)).toBe("ask-first");
  });

  it("is not fooled by a policy that may do plenty, as long as none of it changes anything", () => {
    const readsEverything: Policy = {
      ...OBSERVE_ONLY,
      may: OPERATION_NAMES.filter((n) => riskOf(n) === "read"),
      maxActionsPerIncident: 3,
    };
    expect(posture(readsEverything)).toBe("observe");
  });

  it("demotes to asking when the one changing operation it may do is also on the never list", () => {
    const contradictory: Policy = { ...DEFAULT_POLICY, never: [...DEFAULT_POLICY.never, "pm2_restart", "pm2_start", "run_tests", "call_hook"] };
    // never beats may — the same precedence decide() uses — so nothing is left that can happen
    // unattended, and the card must not keep saying "may act".
    expect(posture(contradictory)).not.toBe("may-act");
    for (const op of ["pm2_restart", "pm2_start"]) {
      expect(decide(op, contradictory, { actionsTaken: 0, minutesSinceLastAction: null }).verdict).toBe("refuse");
    }
  });

  it("agrees with decide() about whether anything can happen unattended", () => {
    const changing = OPERATION_NAMES.filter((n) => riskOf(n) === "reversible" || riskOf(n) === "disruptive");
    for (const policy of [OBSERVE_ONLY, DEFAULT_POLICY, ASK_BEFORE_ACTING]) {
      const anyAllowed = changing.some((op) => decide(op, policy, { actionsTaken: 0, minutesSinceLastAction: null }).verdict === "allow");
      expect(posture(policy) === "may-act", `${describePolicy(policy).slice(0, 40)}`).toBe(anyAllowed);
    }
  });
});

/**
 * The policy editor renders one sentence per operation. If an operation has none, a person is being
 * asked to grant a capability the screen will not describe — so this is a build-breaking omission,
 * not a cosmetic one.
 */
describe("every operation says what granting it means", () => {
  it.each(OPERATION_NAMES)("%s has a sentence", (name) => {
    const entry = catalogue().find((o) => o.name === name)!;
    expect(entry.does.length, `${name} needs a "does"`).toBeGreaterThan(20);
    expect(entry.does.trim().endsWith("."), `${name}'s sentence should be a sentence`).toBe(true);
    // An identifier repeated back is not an explanation.
    expect(entry.does.toLowerCase()).not.toContain(name);
  });

  it("says plainly that a forbidden operation is refused, wherever it is shown", () => {
    for (const o of catalogue().filter((x) => x.risk === "forbidden")) {
      expect(o.does.toLowerCase()).toContain("refused");
    }
  });
});

/**
 * A POLICY THAT ARRIVES FROM A FORM.
 *
 * `decide()` refuses a forbidden operation whatever the policy says, so none of this is what keeps
 * Warden safe. It is what keeps the SCREEN honest: a stored policy claiming to grant `delete_data`
 * would be rendered as granted, and somebody would reasonably believe they had granted it. The
 * editor must not be able to write a permission the engine will never honour.
 */
describe("a policy arriving from outside", () => {
  const forbidden = OPERATION_NAMES.filter((n) => riskOf(n) === "forbidden");

  it("cannot grant a forbidden operation, however it is submitted", () => {
    const attempt = { ...DEFAULT_POLICY, may: [...DEFAULT_POLICY.may, ...forbidden], never: [] };
    const saved = sanitisePolicy(attempt);
    for (const op of forbidden) {
      expect(saved.may, op).not.toContain(op);
      expect(saved.ask, op).not.toContain(op);
      expect(saved.never, op).toContain(op);
      // and the engine agrees, which is the claim the screen is now making
      expect(decide(op, saved, { actionsTaken: 0, minutesSinceLastAction: null }).verdict).toBe("refuse");
    }
  });

  it("pins the forbidden four into never even when never was submitted empty", () => {
    expect(sanitisePolicy({ ...OBSERVE_ONLY, never: [] }).never).toEqual(expect.arrayContaining(forbidden));
  });

  it("drops operations the catalogue has never heard of rather than storing a fiction", () => {
    const saved = sanitisePolicy({ ...DEFAULT_POLICY, may: [...DEFAULT_POLICY.may, "sudo_rm_rf", "curl"] });
    expect(saved.may).not.toContain("sudo_rm_rf");
    expect(saved.may).not.toContain("curl");
    expect(saved.may).toContain("pm2_restart");
  });

  it("puts an operation in exactly one list, so the editor cannot show two answers at once", () => {
    const saved = sanitisePolicy({ ...DEFAULT_POLICY, may: ["pm2_restart"], ask: ["pm2_restart"], never: ["pm2_restart"] });
    const appearances = [saved.may, saved.ask, saved.never].filter((xs) => xs.includes("pm2_restart"));
    expect(appearances).toHaveLength(1);
    // never beats ask beats may — the same precedence decide() applies
    expect(saved.never).toContain("pm2_restart");
  });

  it("falls back to watching only when handed something that is not a policy", () => {
    for (const junk of [null, "", 42, { may: "everything" }, { maxActionsPerIncident: -5 }]) {
      expect(posture(sanitisePolicy(junk))).toBe("observe");
    }
  });

  it("keeps a legitimate policy intact", () => {
    expect(sanitisePolicy(ASK_BEFORE_ACTING)).toEqual(ASK_BEFORE_ACTING);
    expect(sanitisePolicy(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
  });
});

/**
 * The card and the page must agree about what Warden can do to a service.
 *
 * "may act" on a card, above a page explaining that Warden cannot touch this service, is the
 * product contradicting itself — and the card is the half people read. A permissive policy on a
 * service with no machine grants nothing, because execute() refuses every operation except the
 * check itself.
 */
describe("what a service card says", () => {
  const permissive = POSTURE_WORDS[posture(DEFAULT_POLICY)];

  it("says network only when there is no machine, whatever the policy says", () => {
    expect(permissive.label).toBe("may act");
    expect(stanceOf({ host: "local", repo: null, process: null }, permissive).label).toBe("network only");
  });

  it.each([
    ["a process name", { host: "local", repo: null, process: "app" }],
    ["a checkout", { host: "local", repo: "/srv/app", process: null }],
    ["a machine to reach", { host: "ubuntu@203.0.113.10", repo: null, process: null }],
  ])("reports the policy once the service has %s", (_what, service) => {
    expect(stanceOf(service, permissive)).toEqual(permissive);
  });

  it("agrees with what execute() will actually allow", async () => {
    const urlOnly = { host: "local", repo: null, process: null };
    expect(hasMachine(urlOnly)).toBe(false);
    const res = await execute("pm2_list", {}, { ...urlOnly, sshKey: null, nodeBin: null });
    expect(res.ok).toBe(false);
  });
});
