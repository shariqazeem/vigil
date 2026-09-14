# Agents for Humans: the Strands features that are load-bearing in an autonomous operator

Warden is an agent that operates production services: it investigates a failing check, fixes what a
per-service policy allows, and proves the fix by re-running the check. It is built on the
**Strands Agents SDK** in TypeScript.

This post is about which parts of the SDK ended up doing real work, and why. Every excerpt below is
copied verbatim from the repo (MIT, https://github.com/shariqazeem/warden).

## A Graph whose edge is the safety property

One incident is a `Graph` with two agents: `investigate`, which gathers evidence and must commit to
a cause, and `remedy`, which chooses the smallest act that cause supports. The interesting part is
not that there are two agents. It is the edge between them.

```ts
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
```

`CONFIDENCE_TO_ACT` is 0.5. If the investigator could not name a cause, or named one it is not sure
of, the agent that has hands *is never invoked*. This is a different guarantee from telling a single
agent "do not act unless you are confident", and the difference is the whole reason for the graph: a
prompt is a request, an edge handler is a fact about which code runs.

The handler reads shared incident state rather than the previous node's output, because that state
is also what the tools, the hooks and the database row read. Two agents that hand each other prose
can disagree about what was found; two agents that read the same ledger cannot.

## Tools instead of structured output

The obvious way to get a diagnosis out of an agent is `structuredOutputSchema` on the final message.
I started there and moved away from it, because three other things need the diagnosis *during* the
run: the graph's edge (above), the `act` guard that refuses to touch anything before a cause is
recorded, and the incident row that the console renders live. A schema on the last message arrives
too late for all three.

So the investigation's output is a tool call — `record_diagnosis`, with `diagnosis`, `suspect` and
`confidence` — validated by zod, which writes to the incident row and emits to the console the
moment it is called. The `AfterInvocationEvent` hook makes it non-optional:

```ts
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
```

`e.resume` is the SDK feature I reach for most. It says "you are not finished" without restarting
the agent or losing the turn. The remedy agent has the same hook with a different condition: it may
not end a turn having neither acted nor explained why it cannot. One nudge, then the run ends and
the incident escalates with everything it read. Silence at 3am is the one outcome that helps nobody.

## An interrupt raised from inside a tool

When the policy says `ask`, Warden does not "decide to stop". The tool raises a real interrupt from
inside the callback, after writing the question and the exact proposal to the database:

```ts
        // THE HALT. The run genuinely stops here and is resumed with the owner's answer.
        const answer = context!.interrupt<string>({
          name: "approve_action",
          reason: { decisionId: d.id, question: d.question, op: input.op, args: JSON.stringify(input.input), why: input.why, because: gate.reason },
        });
        if (answer !== "approve") return { refused: true, rule: "owner-declined", reason: `The owner said no: "${answer}".` };
```

The agent's result comes back with `stopReason: "interrupt"`, the graph node reports `INTERRUPTED`,
and the run is over — not paused in memory, over. That matters because the person who has to answer
might be asleep, and the process will be restarted before they wake up.

The other half is the resume. The owner's answer is handed back as the tool's *return value*, so the
agent continues the thought it was having rather than being told about a decision it made an hour
ago:

```ts
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
```

The fallback branch exists because an interrupt id can be lost — a redeploy, a cleared session — and
an operator that cannot be answered because of bookkeeping is worse than one that re-reads the
question. `SessionManager` with `LocalFileStorage` is what usually makes the first branch possible:
the remedy agent's conversation is written to disk on every message, so a halted run outlives the
process it started in.

## Hooks as the rules the model cannot argue with

Four rules hold whatever the model does, in a `BeforeToolCallEvent` hook registered at
`HookOrder.SDK_FIRST - 1`: no operation that does not exist; no acting before diagnosing; no second
go at the same act; no acting past a refusal. Setting `e.cancel` means the tool callback never runs
— the model gets a refusal, and nothing is spawned.

The third rule is the one that took two attempts:

```ts
        // Keyed by the tool call that made it, so a hook that runs twice for one call — or a
        // retry of the identical call inside the SDK — cannot make an act trip its own guard.
        const signature = `${op}:${JSON.stringify(input.input ?? {})}`;
        const first = ctx.attempted.get(signature);
        if (first && first !== e.toolUse.toolUseId) {
          WardenGuards.note("no-second-go", signature);
          e.cancel = `Refused: you have already run ${op} with those arguments on this incident. Doing it again is not a new idea — either try something the evidence supports, or call give_up.`;
          return;
        }
```

The first version stored a `Set` of signatures. The hook ran twice for one tool call, the second run
saw the signature the first had written, and the act refused itself. Keying the map on `toolUseId`
is the fix: the call that created the entry is never refused by its own entry.

The fourth rule needs to know that a *refusal* happened, which arrives after the tool has run:

```ts
      const block = e.result?.content?.[0];
      // A tool that returns an object arrives as a jsonBlock, not a textBlock. Read both, or this
      // rule never arms: every refusal the `act` tool produces is an object.
      const text = block?.type === "textBlock" ? block.text : block?.type === "jsonBlock" ? JSON.stringify(block.json) : "";
      if (!text.includes('"refused":true')) return;
```

That comment is a scar. The original read `textBlock` only. Every refusal the `act` tool produces is
an object, so the rule never armed in production and nothing outside the test suite noticed.

Alongside the hooks there is an `InterventionHandler` that states the boundary declaratively. Six
tools are allowed by name, and anything whose name matches this is denied before it can be wired up:

```ts
  private static readonly SHELL_SHAPED = /(shell|bash|exec|spawn|command|eval|sudo|ssh|curl|http_request|file_editor|python)/i;
```

It is proved by the tests; it is not yet registered on the two live agents, which are held by the
hooks. I would rather say that than imply otherwise.

## Middleware for the thing that actually breaks in production

Several incidents can be live at once, each a graph wanting the model. That is the right shape for
the work and the wrong shape for a rate-limited endpoint. Rather than serialise the incidents, the
throttle goes underneath them as middleware on the model stage:

```ts
    agent.addMiddleware(InvokeModelStage, async function* (context, next) {
      const queuedAt = Date.now();
      if (inFlight >= LIMIT) throttleStats.queued += 1;
      await acquire();
      throttleStats.waitedMs += Date.now() - queuedAt;
      throttleStats.calls += 1;
      try {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return yield* next(context);
          } catch (e) {
            if (!isRateLimited(e) || attempt >= MAX_ATTEMPTS) throw e;
            throttleStats.rateLimited += 1;
```

Agents believe they are running in parallel; the gateway sees a bounded queue. A 429 waits and comes
back rather than failing a node, because an operator that gives up on a rate limit is an operator
that quietly stops operating.

## Two models, one of them a fallback

```ts
    const router = new ModelRouter(
      [
        new RoutingCandidate({ model: bedrock, name: "bedrock", description: `Amazon Bedrock ${bedrockId}` }),
        new RoutingCandidate({ model: fallback, name: "gateway", description: `fallback ${gatewayId}` }),
      ],
      { strategy: new FallbackStrategy(), maxSwitches: 2 },
    );
```

Setting `BEDROCK_MODEL_ID` makes Amazon Bedrock the primary and the OpenAI-compatible gateway the
fallback, with `cacheConfig: { strategy: "auto" }` on the Bedrock model because the system prompts
are long and identical across a pass. A watch meant to run for years cannot go dark because one
provider has a bad afternoon. The deployed instance currently runs the gateway alone, and the
console prints which model actually ran each pass, so the screen cannot claim more than is true.

Two smaller things that earned their place: `SlidingWindowConversationManager` (`windowSize: 16,
pinFirst: 1`) on the investigator, because six logs and diffs overran the context and killed a run
mid-thought — what falls out of the window is still in the evidence list that `read_incident` hands
back; and a `retryStrategy()` **factory** rather than a shared instance, because a
`DefaultModelRetryStrategy` binds to the agent that owns it and the second agent to receive the same
object gets an error instead of a retry.

## The shape this pushed me towards

Every one of these features moved a decision out of the model and into a place where a test can
reach it. The edge decides whether the acting agent runs. The hook decides whether the tool runs.
The policy decides whether the operation runs. The probe decides whether it worked.

The prompts that remain are short, and they mostly describe boundaries the code already enforces.
That turns out to be the reliable signal: every time I caught myself writing "you must not…" into a
system prompt, it meant I had not yet written the hook.

---

*Warden: https://github.com/shariqazeem/warden (MIT). The suite that proves the boundaries —
132 tests, offline, no model, nothing spawned — is `npx vitest run`.*
