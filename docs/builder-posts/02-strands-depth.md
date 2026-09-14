# Agents for Humans: building an agent that stops — Graphs, interrupts and hooks in the Strands Agents SDK

This is the second post about Vigil, the agent I built for the AWS "Agents for Humans" hackathon. It
watches the physical things in a house against live US federal safety data and wakes you only when
one of them becomes dangerous. The [first post](01-what-nobody-checks.md) is about why that problem
exists. This one is about how it is built on the **Strands Agents SDK** (TypeScript), and about four
patterns I would now reach for on any agent project.

All the code below is copied from the repo: <https://github.com/shariqazeem/vigil> (MIT).

## 1. One watch is a `Graph`, and the edges are conditional

A pass over a household has an obvious shape. Something has to decide which agency could possibly
know about each object — NHTSA does not have opinions about melatonin, and openFDA has none about a
dresser. Then several agencies can be asked at once. Then someone has to judge whether any of what
came back is actually about *your* unit.

That is a graph, and Strands has one:

```ts
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
```

The thing worth noticing is that the `handler` functions are evaluated **at run time, against live
state**. `laneWanted("ingestible")` reads the plan that the triage agent committed to two seconds
earlier and returns false if there is nothing edible in the house — so the openFDA lane, and the
model call it would have made, simply does not happen. `hasCandidates` means the match agent, which
is the expensive one, only runs if a source actually returned a row.

The nodes do not pass prose to each other. Each one reads and writes a shared per-pass context
through tools, because anything important that survives only as a sentence in a model's output is
something you cannot test.

## 2. The part that stops

A recall notice describes a production run: a model range, a colour, a size in inches, a manufacture
window, and where the label is. You own one object. When the record says "manufactured from September
2023 through December 2025" and the dresser came from your sister with no receipt, there is genuinely
no way to know — except by asking a person to go and look under the top panel.

Guessing either way is wrong, and wrong in asymmetric ways: a false alarm costs five minutes, a false
all-clear leaves a dresser that can tip over on a child in that child's bedroom, with a green tick
next to it.

So the tool raises an interrupt and the run really does halt:

```ts
          const answer = context!.interrupt<string>({
            name: "identify",
            reason: { decisionId: d.id, question: d.question, thingId: input.thingId, sourceId: cand.sourceId, record: cand.summary.slice(0, 600) },
          });
          if (answer !== "yes") return { recorded: "the owner says it is not theirs", answer };
          verdict = "covers";
```

This is not a flag the UI renders differently. The invocation returns with `stopReason: "interrupt"`,
Vigil freezes the pass's own state into SQLite, and the household is then skipped by the scheduled
sweep — because the question *is* the work, and waking someone twice about the same thing is exactly
the failure that makes people ignore safety products.

Hours later, in a different process, the answer goes back into the same conversation:

```ts
    result = await agent.invoke([new InterruptResponseContent({ interruptId, response: answer })], {
      invocationState: { passId, householdId: decision.householdId },
    });
```

That works because the asking agent carries a `SessionManager` with file storage, so the conversation
outlives the process that started it:

```ts
    sessionManager: new SessionManager({ sessionId: sessionIdFor(passId), storage: new LocalFileStorage(SESSIONS), saveLatestOn: "message" }),
```

And because a model that forgets to ask is a person who never gets woken up, forgetting is not one of
the available outcomes. An `AfterInvocationEvent` hook refuses to let the turn end:

```ts
  let nudges = 0;
  agent.addHook(AfterInvocationEvent, (e) => {
    const ctx = (() => { try { return contextFor(passId); } catch { return null; } })();
    if (!ctx) return;
    const asked = ctx.asked.some((a) => a.sourceId === expect.sourceId && a.thingId === expect.thingId);
    if (asked || nudges >= 2) return;
    nudges += 1;
    e.resume = `You ended without asking. Call rule_on_candidate NOW with thingId "${expect.thingId}", sourceId "${expect.sourceId}", verdict "unsure", confidence, reason, severity, and the question in "missing". That is the only acceptable next action.`;
  });
```

The `nudges >= 2` bound is deliberate. `resume` without a counter is an infinite loop waiting to
happen.

## 3. Hooks are enforcement; prompts are requests

Everything I first wrote as a paragraph in a system prompt, I eventually had to move into a hook.

A system prompt is a request. A `BeforeToolCallEvent` hook that sets `cancel` is a refusal. Vigil has
six of them, registered at `HookOrder.SDK_FIRST - 1` so a refusal costs nothing:

```ts
        if (!cand) {
          VigilGuards.note("no-invented-records", String(input.sourceId));
          e.cancel = `Refused: no record "${input.sourceId}" came back for ${input.thingId} in this pass. Vigil writes findings only from records it actually fetched. Call list_candidates and rule on those.`;
          return;
        }
        if (input.verdict === "covers" && (input.confidence ?? 0) < CONFIDENCE_FLOOR) {
          VigilGuards.note("no-alarm-on-a-hunch", `${input.sourceId} at ${input.confidence}`);
          e.cancel = `Refused: ${Math.round((input.confidence ?? 0) * 100)}% is below Vigil's floor of ${CONFIDENCE_FLOOR * 100}% for telling someone their thing is recalled. Rule "unsure" instead and name the one fact that would settle it.`;
          return;
        }
```

The other four: no clearing a record that names your brand *and* your object; no claiming a unit
whose manufacture window nobody has checked; no `critical` severity without the record's own
do-not-drive flag or its own words about death, injury, fire or a crash; and one settled verdict per
record.

The refusal string matters as much as the refusal. A cancelled tool call is a correctable mistake,
not a dead end, so an `AfterToolCallEvent` hook hands a self-refused tool its reason back — exactly
once, so a model that keeps insisting cannot spin:

```ts
    const retried = new Set<string>();
    agent.addHook(AfterToolCallEvent, (e) => {
      const r = e.result?.content?.[0];
      if (!r || r.type !== "textBlock") return;
      const key = e.toolUse.toolUseId;
      if (r.text.includes('"rejected":true') && !retried.has(key)) {
        retried.add(key);
        e.retry = true;
      }
    });
```

There is also a declarative half, as an `InterventionHandler`, which states the boundary the whole
product is built around: Vigil may read anything public and say anything it likes to the person whose
house it is, but nothing leaves the household without a human pressing a button.

```ts
export class NothingLeavesTheHouse extends InterventionHandler {
  readonly name = "vigil:nothing-leaves-the-house";
  private static readonly OUTBOUND = /^(send_|post_|file_|submit_|email_|notify_)/;

  override beforeToolCall(event: BeforeToolCallEvent) {
    const name = event.toolUse.name;
    if (name === "ask_owner") return InterventionActions.proceed();
    if (NothingLeavesTheHouse.OUTBOUND.test(name)) {
      return InterventionActions.deny(
        "Vigil never speaks to anyone outside this household on its own. Use ask_owner: show the owner exactly what would be sent, and let them decide.",
      );
    }
    return InterventionActions.proceed();
  }
}
```

The useful test of any safety claim in an agent is: can you write a test that jailbreaks the model and
asserts nothing happened? `src/agent/__tests__/gates.test.ts` pushes four deliberately jailbroken tool
payloads — an invented campaign number with total confidence, a 0.2-confidence alarm, a `critical` on
a record whose own words are about a missing tyre-pressure label, and an all-clear on a recall naming
the exact brand and model of a child's car seat — through the real hook and then the real tool, and
asserts the findings table stays empty. A control case in the same file proves the harness *does*
write when the ruling is honest, so zero rows means the gate held rather than the plumbing being
broken. `npx vitest run` runs all 108 tests; none of them touches a model or the network.

## 4. The completeness gate — the pattern I would take anywhere

This is the one I did not expect, and it is about thirty lines.

A good model plans well, and then on some runs quietly does four of the five things it planned. For a
search product that is a bad day. For a safety net it is a hole, and worse, an invisible one: the
board would show "checked" with no note that one agency was never asked.

So the triage agent commits to a plan through a tool, and after the graph finishes, plain code
compares the promise to the record:

```ts
/** Records the agent pulled back and then never ruled on. Silence about one of these is the
 *  failure mode that matters: a recall fetched, seen, and quietly dropped. */
export function unruled(ctx: PassContext): Candidate[] {
  return ctx.candidates.filter((c) => !ctx.ruled.has(`${c.thingId}::${c.sourceId}`));
}

/** What triage promised but the lanes never actually asked. The gap the code closes itself. */
export function missingChecks(ctx: PassContext): ExpectedCheck[] {
  return ctx.expected.filter((e) => !ctx.done.has(checkKey(e.thingId, e.source)));
}
```

and then closes both gaps itself:

```ts
      const unchecked = await closeTheGaps(ctx, send);
      if (unchecked > 0) logEvent(householdId, "system", "gap.closed", `${unchecked} source(s) the agent planned but did not ask`, pass.id);
      const unjudged = await closeTheVerdicts(ctx, householdId, send);
      if (unjudged > 0) logEvent(householdId, "system", "verdicts.closed", `${unjudged} record(s) the agent fetched but did not rule on`, pass.id);
```

`closeTheGaps` calls the missing sources directly and absorbs the rows as candidates like any others.
`closeTheVerdicts` re-sends unruled records to a fresh match invocation, one thing at a time, up to
three rounds — and whatever is still unruled is **held**, never dropped, so it becomes a question to a
human rather than silence.

The framing I ended up with, which is now a comment in the source:

> The agent chooses how to look. The code guarantees that it looked.

This also means a graph failure is survivable. If a node times out or a provider has a bad ten
minutes, the graph error is reported and stepped over, and the gates run anyway — which is exactly
what a half-finished watch needs.

## 5. The rest of the SDK surface, briefly

- **`InvokeModelStage` middleware** (`src/agent/throttle.ts`) — three lanes in parallel plus one match
  invocation per thing walked straight into `429 quota exceeded`. The fan-out is the right shape for
  the work, so the throttle went underneath it as model-stage middleware: the agents believe they are
  parallel, the gateway sees one queue with decorrelated backoff.
- **`ModelRouter` + `FallbackStrategy`** (`src/agent/model.ts`) — Amazon Bedrock as the primary
  candidate with an OpenAI-compatible gateway behind it, because a watch that runs for years cannot go
  dark when one provider does. Bedrock switches on with `BEDROCK_MODEL_ID`; to be straight about it,
  the deployed instance runs on the gateway today (MiniMax-M3) and the README says so.
- **`Agent` + `structuredOutputSchema`** (`src/agent/intake.ts`) — a sentence or a photo becomes a
  zod-validated inventory, with a required `unknowns` field so the model must declare what it could
  not read rather than inventing a model year.
- **`ToolStreamEvent`** — per-source progress from inside a single tool call, which is what makes the
  live board show a lamp moving between objects while one tool is still running.
- **`BeforeNodeCallEvent` / `NodeResultEvent`** — every node start and result is an event the board
  draws from over SSE, so nothing on screen is on a timer.
- **`traceAttributes` / `appState` / `invocationState`** — every span and every tool call carries its
  household and pass id, which is how the tools find their context without a global.

Next post: four bugs that cost me real time, including a guard that blocked its own agent from
asking, and a rate limiter that rejected an 8,000-token request while allowing a 4,000-token one.
