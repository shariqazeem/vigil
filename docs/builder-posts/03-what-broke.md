# Agents for Humans: four bugs from building Vigil, and what each one taught me

This is the third post about Vigil, the agent I built for the AWS "Agents for Humans" hackathon — an
autonomous watch over the physical things in a house, checked against live US federal safety data.
The [first post](01-what-nobody-checks.md) is the problem. The [second](02-strands-depth.md) is how it
uses the Strands Agents SDK. This one is the part nobody writes up: the four things that broke, and
what each of them actually taught me.

None of these is a framework complaint. Three are my own category errors and the fourth is a platform
behaving reasonably in a way I had not thought about. They are here because I would have saved hours
if somebody had written them down first.

---

## 1. A retry strategy is not a constant

I wrote this, which is the obvious thing to write:

```ts
const retry = new DefaultModelRetryStrategy({ maxAttempts: 4, backoff: /* … */ });
```

…as a module-level constant, and passed it to every agent I constructed. It is configuration. It has
no per-agent meaning. Sharing it is free.

The first agent constructed fine. The second threw, with words to the effect of *"instance is already
attached to another agent"*.

Which is correct, and I should have expected it. A retry strategy is not a config object; it is a
stateful participant in the agent's loop, and the SDK binds it to the agent that owns it. Handing the
same instance to five agents would mean five loops sharing one attempt counter.

The fix is one character of syntax and a change of mental model — make it a factory, not a constant:

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

Every agent now gets `retryStrategy: retryStrategy()`.

**What it taught me.** In an agent framework, the line between "configuration" and "runtime
participant" is not where your instincts put it. Anything the loop can *write to* — retry strategies,
session managers, hook registries — is per-agent, even when its constructor arguments look like
settings. My rule now: if an SDK object is constructed with `new`, assume it is stateful and reach
for a factory. It costs nothing to be wrong in that direction.

---

## 2. A 429 that was not about rate

Vigil's model calls go through an OpenAI-compatible gateway. Partway through a pass I started getting:

```
429 quota exceeded (cap 0.5)
```

I did what everybody does: assumed I was going too fast, and added backoff. It did not help. Slowing
to one request at a time did not help. The failures were not correlated with concurrency at all —
they tracked *which agent* was calling, which made no sense until I read the number in the
parentheses.

The gateway enforces a **per-request cost ceiling**, and it reserves `max_tokens × price` against that
ceiling *before* it will start the request. It is not measuring what you spend. It is measuring what
you might spend. So a request that would have produced 200 tokens was rejected outright because its
`max_tokens` was 8,000 and the reservation did not fit under the cap.

I binary-searched it. 4,000 passes. 8,000 does not. The fix is a number and a comment explaining the
number, because in six months the number will look arbitrary:

```ts
/**
 * Kept under the gateway's per-request cost ceiling. Commonstack reserves `max_tokens × price`
 * against the key's cap before it will start a request, and rejects the whole call with
 * `429 quota exceeded (cap 0.5)` if the reservation does not fit — measured: 4000 passes, 8000 does
 * not. Nothing Vigil writes is long; the ceiling costs it nothing and a 429 costs it a pass.
 */
const MAX_TOKENS = Number(process.env.VIGIL_MAX_TOKENS ?? 3000);
```

Nothing Vigil writes is long — a ruling is a sentence, a brief is two — so the ceiling costs it
nothing and a 429 costs it a whole pass.

The genuine rate limiting, which also exists, got its own fix: a Strands `InvokeModelStage` middleware
that puts one process-wide queue under the fan-out, so three parallel lanes plus one match invocation
per thing look like parallelism to the agents and like a queue to the gateway.

**What it taught me.** Read the error body, not the status code. `429` in an agent stack can mean at
least three different things — too many requests, too much spent, or too much *declared* — and only
one is fixed by waiting. I now log the provider's full error string on any retry, because the first
version of my throttle was enthusiastically backing off from a failure backoff could never fix.

---

## 3. The guard that stopped its own agent from asking

This is the one that scared me, because it broke the central feature silently.

Vigil's rules are enforced in a `BeforeToolCallEvent` hook. One of them is **one verdict per record**:
the match agent may not rule on the same government record twice, because a second contradicting
ruling silently overwriting the first is exactly how a product like this produces a wrong answer with
a confident face.

So when the match agent ruled `unsure` on the dresser — correctly; the CPSC recall covers units made
between September 2023 and December 2025 and nobody knows when this one was made — that `unsure` went
into the ruled map.

Then the adjudicator, the agent whose entire job is to put the unanswerable question to a human,
called `rule_on_candidate` with `unsure` to raise the interrupt. And the guard refused it:

> Refused: 26522 has already been ruled "unsure" for this thing in this pass. A record gets one
> verdict.

The `AfterInvocationEvent.resume` hook then told the agent it had ended without asking, and it tried
again, and was refused again, and the pass finished with a held record and no question. The board
showed a household with nothing wrong.

The bug was not in the mechanism. It was in the word *verdict*. I had written an invariant in
English — "one verdict per record" — and implemented it against a three-valued enum where one of the
values is not a verdict at all. `covers` is an answer. `clear` is an answer. `unsure` is a **question**,
and a question is exactly the thing that is supposed to be settled later.

The fix is four characters, in both the hook and the tool:

```ts
        // "unsure" is not a verdict, it is a question. A later ruling may settle it; a second
        // "covers" or "clear" may not overwrite the first.
        const priorVerdict = ctx.ruled.get(`${input.thingId}::${input.sourceId}`);
        if (priorVerdict && priorVerdict !== "unsure") {
```

```ts
      const already = ctx.ruled.get(`${input.thingId}::${input.sourceId}`);
      if (already && already !== "unsure") {
        return { rejected: true, error: `${input.sourceId} has already been ruled "${already}" for this thing in this pass. A record gets one verdict. Rule on a record that has none.` };
      }
```

**What it taught me.** Guards fail in the direction you are not watching. I had tested that the guard
refused a jailbroken model. I had not tested that it let the *honest* path through — and a guard that
over-refuses is not visibly broken, it just makes the product quietly do less. Every rule in
`guards.ts` now has both a refusal case and an allow case in the tests.

The smaller, sharper lesson: when you state an invariant in a sentence, check that every value in your
enum belongs to the category the sentence names. "One verdict per record" was true. `unsure` was never
a verdict.

---

## 4. Session ids have a character set

The short one, included because it cost me twenty minutes of reading stack traces that were telling
me the truth.

Vigil's halted runs are resumable because the asking agent carries a `SessionManager` with file
storage, keyed on the pass id. Pass ids in this codebase are a prefix plus a nanoid, so they are
**mixed case** — `pass_d0axiHmT5k`. Strands session ids are not: lowercase, digits, hyphen and
underscore only.

```ts
/** Strands session ids are lowercase, digits, hyphen and underscore only. */
const sessionIdFor = (passId: string) => `pass-${passId.toLowerCase().replace(/[^a-z0-9_-]/g, "-")}`;
```

The constraint is obviously sensible — a session id becomes a path segment on disk, and
case-insensitive filesystems exist. It is only a bug because I passed a raw internal id straight into
someone else's namespace.

**What it taught me.** Every id you hand across a library boundary is entering a namespace with rules
that are not yours. Normalise at the boundary, in one named function, with the rule written above it
as a comment — so the next person does not have to rediscover the character set from a stack trace.

---

## What the four have in common

Three of these four are the same mistake in different clothes: **I assumed a boundary was thinner than
it was.** A retry strategy looked like config and was runtime state. An id looked portable and was
namespaced. A 429 looked like one thing and was another. And the fourth — the guard — was a word in
English that did not survive contact with an enum.

The habit I took away is small and has already paid for itself: when something in an agent stack
behaves surprisingly, write the explanation into the source next to the fix, with the measurement in
it. Every excerpt above has its "why" attached, including the number I binary-searched. In six months
I will not remember that 8,000 fails and 4,000 passes, and neither will anyone reading it.

Vigil is live at **https://vigil.80.225.209.190.sslip.io** — no sign-up, no key — and the source is
MIT at **https://github.com/shariqazeem/vigil**. `npx vitest run` runs 108 tests, none of which
touches a model or the network, and `npx vitest run src/agent/__tests__/gates.test.ts` is the
red-team one that tries to jailbreak the agent four ways and asserts nothing reaches the board.
