# Agents for Humans: eight bugs between a working demo and a working operator

Warden is an agent that operates running software — it investigates a failing check, fixes what a
per-service policy allows, and proves the fix by re-running the check. Built on the Strands Agents
SDK, in TypeScript, in six days.

The demo worked early. The product did not, and the gap between them was six bugs. Four of them I
found by watching it fail; two the test suite found on its own, and neither was visible from
outside. This is what each one actually was.

Four of the six were the same shape: **something remembered more than it should have.**

## 1. A retry strategy cannot be shared between agents

I built one `DefaultModelRetryStrategy` at module scope and passed that same instance to both agents,
because both of them talk to the same provider and want the same behaviour. The second agent to
receive it errored instead of retrying. The SDK binds a retry strategy to the
agent that owns it; handing the same instance to a second agent is not a configuration, it is an
aliasing bug. The fix is a factory, and the comment on it is there so nobody undoes it:

```ts
/**
 * Backoff that survives a provider having a bad minute. A nightly watch retries; it does not fail.
 * One instance per agent — the SDK binds a strategy to the agent that owns it.
 */
export const retryStrategy = (): DefaultModelRetryStrategy =>
  new DefaultModelRetryStrategy({
    maxAttempts: 4,
    backoff: new ExponentialBackoff({ baseMs: 500, maxMs: 20_000, jitter: "decorrelated" }),
  });
```

General lesson: anything stateful you pass into an agent constructor should be constructed per
agent unless the documentation says otherwise. It costs nothing and it removes a whole class of
question.

## 2. A cost cap that is charged before the request runs

Calls started failing with `429 quota exceeded (cap 0.5)`. Not after generating anything — before.
Retries did not help, backoff did not help, and the same prompt worked from a different code path.

The gateway reserves `max_tokens × price` against a per-request ceiling *before it will start the
request*, and rejects the whole call if the reservation does not fit. I measured it: a request
declaring 4000 max tokens went through, and the identical request declaring 8000 was refused. It had
nothing to do with how much the model actually produced.

```ts
/**
 * Kept under the gateway's per-request cost ceiling. Commonstack reserves `max_tokens × price`
 * against the key's cap before it will start a request, and rejects the whole call with
 * `429 quota exceeded (cap 0.5)` if the reservation does not fit — measured: 4000 passes, 8000 does
 * not. …
 */
const MAX_TOKENS = Number(process.env.WARDEN_MAX_TOKENS ?? 3000);
```

`max_tokens` is not a limit you set generously "just in case". On some gateways it is a price you
pay up front for permission to start.

## 3. A guard that refused its own tool call

One of the rules no policy can switch off is *no second go at the same act*: the same operation with
the same arguments, twice on one incident, is refused. Restarting again is not a new idea, and the
loop it creates is the most likely way an autonomous operator does real damage.

The first version kept a `Set` of `op:args` signatures. Add on attempt, refuse if present.

In production, Warden diagnosed a stopped process, asked to start it — and refused itself. The
`BeforeToolCallEvent` hook ran twice for a single tool call, and the second run found the signature
the first had just written. The agent then reported, accurately and uselessly, that it had already
tried that.

The fix is to remember *which call* made the entry:

```ts
        // Keyed by the tool call that made it, so a hook that runs twice for one call — or a
        // retry of the identical call inside the SDK — cannot make an act trip its own guard.
        const signature = `${op}:${JSON.stringify(input.input ?? {})}`;
        const first = ctx.attempted.get(signature);
        if (first && first !== e.toolUse.toolUseId) {
```

A `Map<signature, toolUseId>` instead of a `Set<signature>`. Idempotency in a hook is not optional:
assume it can run more than once per call, and make the second run a no-op by identity rather than
by content.

## 4. An agent that read its own last words

The remedy agent has a `SessionManager` backed by `LocalFileStorage`, because a run that stops to
ask a human may be answered hours later, in a different process. That is exactly what the session is
for.

It also meant that when I handed the *same incident* to Warden a second time — after fixing
something, from a clean start — the agent loaded the conversation from the previous attempt, read
its own earlier "I could not do anything here", and said it again. Twice, with more confidence the
second time. The transcript looked like an agent with a settled opinion. It was an agent reading its
own diary.

The distinction is: a session must survive a **halt**, and must not survive a **fresh start**.

```ts
/**
 * The session exists so a run that STOPS to ask a human can be picked back up hours later with the
 * conversation intact. It must not survive into a fresh attempt at the same incident: an agent that
 * reads its own earlier "I could not do anything here" simply says it again, which is exactly what
 * happened the first time this was built.
 */
function forgetSession(incidentId: string): void {
```

`handleIncident` clears the session; `resumeWithAnswer` does not. That one line of asymmetry is the
whole feature.

## 5. A rule that never armed, found by a test

The fourth guard rule is *no acting past a refusal*: once an operation has been refused on this
incident, it cannot be re-attempted with different wording. To know a refusal happened, an
`AfterToolCallEvent` hook reads the tool's result and looks for `"refused":true`.

It read `textBlock` only.

Every refusal the `act` tool produces is an object — `{ refused: true, rule, reason }` — which
arrives as a `jsonBlock`. So the hook looked at the first content block, found no text, and returned.
The rule never armed. Not once, in production, ever, and nothing visible was different: the policy
still refused the operation each time, so the *outcome* was right and the guard that was supposed to
stop the agent from trying a second route simply was not there.

A test written against the real hook with a real `ToolResultBlock` caught it in about a second:

```ts
      const block = e.result?.content?.[0];
      // A tool that returns an object arrives as a jsonBlock, not a textBlock. Read both, or this
      // rule never arms: every refusal the `act` tool produces is an object.
      const text = block?.type === "textBlock" ? block.text : block?.type === "jsonBlock" ? JSON.stringify(block.json) : "";
```

Safety code that has never been observed firing is not safety code. If a rule cannot be made to
trigger in a test, assume it does not work.

## 6. Two lists that had to agree, and didn't

`pm2_list` parses pm2's `jlist` into rows. The process probe in the sweep reads those rows back and
turns one into a sentence for the console. Two files, one format, nothing between them.

I renamed a field in the parser from `restarts` to `restartsSinceAdded` — deliberately, because
pm2's restart count is cumulative since the process was added and reading it as "restarts" had
already misled the agent into calling a stopped process a crash loop. I renamed it in the parser and
not in the reader.

Result: every healthy reading rendered as `online, undefined restarts`. Every single one. The probe
still passed, the incident logic still worked, and the console quietly printed `undefined` on the
happy path — which is the kind of thing you stop seeing after the second day.

The test that holds it now asks the real probe, through the real parse, and asserts the sentence:

```ts
    const reading = await runProbe(service, probe);
    expect(reading.ok).toBe(true);
    expect(reading.detail).toBe("online, 3 restarts since deploy");
    expect(reading.detail).not.toContain("undefined");
```

Two lists that must agree, in different files, with nothing between them to notice when they stop
agreeing, is the most common defect shape I hit in this codebase. The fix is always the same: one
test that reads both.

## 7. The halt that could not be answered

This is the one I would most want another agent builder to read, because it is invisible until the
feature is genuinely used and it was invisible to a test suite that covered the feature.

Warden's central claim is that when the policy says `ask`, the run **stops** — a real Strands
interrupt, raised from inside a tool, held until a person answers, resumable hours later from a
different process. That is what makes it an operator rather than an automation: the pause is not a
poll, it is the agent suspended mid-thought with its state on disk.

It fired on the live fleet for the first time last week. A restart fell inside the service's
cooldown, the policy returned `ask`, the tool raised the interrupt, the run stopped, the question
appeared on the board. Everything about the halt worked.

Answering it did not:

```
Could not pick the run back up: Agent is in an interrupted state.
Resume by invoking with interruptResponse content blocks.
```

The resume path looked like this:

```ts
const interruptId = ctx.asked.find((a) => a.decisionId === decisionId)?.interruptId;
result = interruptId
  ? await agent.invoke([new InterruptResponseContent({ interruptId, response: answer })], state)
  : await agent.invoke(`The owner answered "${answer}" …`, state);
```

`ctx` is an in-memory context, keyed by incident. The id of the interrupt is generated inside the
tool call that halts — **in whatever process was running at the time**. For Warden that is almost
always the sweep's: a cron process that opens the incident, hands it to the agent, gets interrupted,
prints the question and exits. Minutes later somebody answers in the web app, which is a different
process, with an empty `ctx`. So `interruptId` was `undefined`, the code took the fallback branch,
and the SDK correctly refused: the session on disk *is* interrupted, and you do not resume an
interrupted agent with a prompt.

Every test passed, because every test halted and resumed inside one process — which is the one case
that never happens in production.

The fix is three lines and the interesting part is where the answer already was:

```ts
await agent.initialize().catch(() => {});
const interruptId = interruptToAnswer({
  onDecision: decision.interruptId,
  restoredFromSession: agent._interruptState?.getUnansweredInterrupt?.()?.id,
  inMemory: ctx.asked.find((a) => a.decisionId === decisionId)?.interruptId,
});
```

`initialize()` replays the session, and the restored agent knows perfectly well which interrupt it
is still holding. The precedence is deliberate and it is the lesson: **the session on disk is the
most reliable source and the in-memory note is the least.** A decision row written by an older build
comes second; the process's own memory comes last, because it only survives in the case that hardly
ever occurs.

The same run, answered again: the act ran in 318ms, the probe came back `200 in 310ms`, and an
incident that had been open seventeen minutes closed.

If you are building human-in-the-loop with Strands, assume from the first line that the process
which raises an interrupt will not be the process that answers it. Persist the interrupt id, or ask
the restored agent for it. Do not keep it in a `Map`.

## 8. Opening the console opened a door I had not looked at

The last one is not an agent bug. It is what happens when you change who can reach your code and
forget to re-ask a question you had already answered.

Warden's operations run in one of two places: locally, or over ssh on a machine named by the
service. Registering a service used to mean editing a script on the box, so "may this person point
Warden at a path of their choosing" never came up — they had a shell there already. The containment
that does exist is relative:

```ts
function insideRepo(repo: string, path: string): string { /* throws if path escapes */ }
```

Then I made the console the product. Anyone can now register a service from a browser, and the form
takes a checkout path and a process name. A service with no ssh key runs its operations locally. So:

```json
{ "name": "innocent", "url": "https://example.com/",
  "repo": "/home/ubuntu/warden", "process": "warden" }
```

That registration points `read_file` at Warden's own checkout — where the `.env` with the model key
lives — and `pm2_restart` at Warden itself. `insideRepo` does not help at all: the containment is
relative to a repo the attacker named. I verified it against my own production instance before
fixing it, which I recommend, because reading the code convinces you much less than watching it work.

The fix is a rule rather than a patch. A registration that arrives over the network does not get the
machine Warden runs on unless the operator has said so:

```
WARDEN_ALLOW_LOCAL_SERVICES=1
```

Without it, a service with no machine to reach is an http watch and nothing else — said plainly to
the person registering it, with the reason, rather than quietly downgraded. The same rule guards the
edit route, because editing is another way to arrive at the same place. The CLI is untouched, and
that is the whole distinction: whoever runs it already has a shell on the box.

The general shape, which I think is worth more than the specific hole: **every boundary in your
system was drawn against an assumption about who is on the other side of it.** When you let a new
kind of person in — a browser instead of a terminal — none of those assumptions re-derive
themselves. Go and find the ones that were load-bearing. Mine was "the person choosing the path
already has a shell here", and it had been true for six days.

## And one that was not a bug in my code

ssh connection multiplexing died on every call with:

```
unix_listener: path too long
```

An investigation makes a dozen remote calls in a minute, and paying a full ssh handshake for each
one is most of the wall-clock a person watches. Multiplexing is worth real seconds. But a unix
socket path is capped near 104 bytes, and macOS's per-user `TMPDIR` — which is long — combined with
ssh's `%C` hash sails past it.

```ts
const SSH_MUX = "/tmp/.wd-%C";
```

Eleven characters plus the hash. That is all it needed.

## What the bugs have in common

Five of the eight are memory bugs: a strategy remembered by the wrong owner, a signature remembered
across a hook re-entry, a session remembered across a restart, a field name remembered in one file
and not the other, and an interrupt id remembered by a process that had exited. Agents make this worse than ordinary software does, because so much of their
state is deliberately persistent — that is the point of a session — and because when a remembered
thing goes wrong, the system does not crash. It explains itself, fluently, and the explanation is
wrong.

Which is the argument for the two boundaries Warden is built around. The policy decides whether an
act happens; the probe decides whether it worked. Both are code, both are pure enough to test, and
neither asks the agent what it remembers. When bug 4 had the remedy agent confidently repeating its
own old surrender, the thing that made it recoverable was that the incident's actual history was in
a table, not in the conversation.

The last two do not fit that pattern and are the ones I would keep if I could only keep two. Bug 7
was invisible to a complete test suite because every test exercised the feature in the one process
arrangement that never occurs in production. Bug 8 was invisible because the boundary that would
have caught it was drawn against an assumption — "whoever chooses this path already has a shell
here" — that stopped being true the moment a browser could reach the same code, and assumptions do
not re-derive themselves when you move them.

The whole suite is 327 tests across 20 files, about a second, fully offline — no network, no model,
no process spawned. Bugs 5 and 6 came out of writing it, and four of the tests exist only because
bug 8 did. That is a good rate of return for a morning.

---

*Warden is MIT: https://github.com/shariqazeem/warden · live, no sign-up:
https://getwarden.vercel.app*
