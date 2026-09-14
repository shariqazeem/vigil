# Vigil — Devpost submission copy

Paste-ready. Track: Everyday. Project: **Vigil**.

---

## Tagline

An autonomous agent that keeps watch over the physical things in your home against live US federal
safety data, and wakes you only when one of them becomes dangerous.

---

## Inspiration

A recall notice is posted to the address the manufacturer had when the product was new. That is not
where you live, and it never was if you bought the thing second-hand or it was handed down. So the
notice about the dresser in your child's room arrives at somebody else's house.

The consequences are not marginal. Roughly nine in ten recalled consumer products are never
returned, repaired or thrown out. Car-seat recall completion sits near 30%. NHTSA issues around a
thousand vehicle recall campaigns a year. And second-hand goods are structurally invisible to the
entire recall system — nobody registered them, so nobody can be told. Those are exactly the goods
that circulate through neighbourhood networks and families with the least money.

Nobody is checking on your behalf. Not ever, and not for the four years it might take before the
recall on the thing in your child's room is published.

This is not a job a person can do. It is not a job an app can do either — an app is a thing you have
to remember to open. It is a job for something that runs while you are asleep, for years, and
interrupts you exactly once, on the night it matters. That is the shape of an agent, and it is the
reason this is an agent and not a website with a search box.

## What it does

**You tell it what is in your house. Once.** A sentence, a photo of a shelf, a VIN typed on a phone.
An intake agent turns that into things it can watch, and is forced by its schema to declare what it
could *not* read rather than filling the gap in. A VIN is never interpreted by the model: it goes to
NHTSA's own vPIC decoder and comes back as fact.

**Then it does nothing visible, for months.** On a cron, with nobody present, it asks four public
federal sources about every thing you own — NHTSA recalls, NHTSA owner complaints, CPSC product
recalls, openFDA enforcement reports — and records every question it asked: the URL, whether the
source answered, how many rows came back, how long it took. A source that times out is recorded as
**unchecked**, never as clear. Silence is not safety.

**And when it cannot be sure, it stops.** A recall names a model range and a manufacture window, not
your serial number. When Vigil cannot tell whether a record covers *your* unit, it does not guess in
either direction. The run genuinely halts — `stopReason: interrupt` — and stays halted, in the
database, until a human answers one short yes/no question. What you answer is kept in your words, so
it never asks twice.

The demo household on production is four ordinary things: a 2019 Honda Accord whose VIN was decoded
live by NHTSA vPIC, a second-hand Mainstays 9-drawer fabric dresser, a Babysense Max View VBM55 baby
monitor, and vitafusion melatonin gummies. One real pass over it read **4,336 government records
across 6 source calls in 166.6 seconds**, wrote **five findings**, and then stopped on this question:

> On the label under the dresser's top panel, is the Tracking/Lot manufacture date in MM/YYYY
> between 09/2023 and 12/2025?

That question is the whole product. CPSC recall 26522 covers Mainstays 9-drawer fabric dressers
"manufactured from September 2023 through December 2025" — about 165,000 of them — for "Risk of
Serious Injury or Death from Tip-Over and Entrapment". The dresser came from the owner's sister, so
there is no receipt and no owner record anywhere. Nothing in the world can tell Vigil whether this
particular dresser is one of them except the person standing in the room. So it asks them, once, in
the record's own words about where the label is, and it does not move until they answer.

Among the five findings on that board: NHTSA campaign **20V314000**, which in NHTSA's own words means
"the engine can stall while driving, increasing the risk of a crash" — 135,995 vehicles. And CPSC
**26307**, the Babysense Max View VBM55, whose display unit "can overheat and/or spark when charging"
— about 81,800 units. Every word of every hazard on the board is lifted verbatim from the record,
with the record number and a link beside it. Vigil does not write hazards. It finds them and tells
you which of your things they are about.

Who it is for: anyone with a child, a car, or a second-hand anything. It is aimed hardest at the
people the recall system already fails — families who bought used, and the person who runs the home
daycare with eleven cots and four car seats nobody registered.

## How I built it

Vigil is built on the **Strands Agents SDK** (TypeScript, `@strands-agents/sdk`), and one watch is a
Strands **`Graph`**: a `triage` agent decides which federal agency could possibly know about each
thing; three lane agents ask those agencies **in parallel** behind conditional edges; and whatever
came back flows to a `match` agent behind another conditional edge that only fires when there is
actually something to judge. `match` is the only genuinely hard judgement in the system, because a
recall notice describes a production run and you own one unit of it.

The SDK primitives, and what each one does here:

| SDK feature | Where | What it does |
| --- | --- | --- |
| `Graph` + conditional edges | `src/agent/watch.ts` `buildGraph` | triage → three parallel lanes → match; edge handlers evaluate live against the pass's own state |
| `Agent` + `structuredOutputSchema` | `src/agent/intake.ts` | a drop becomes a zod-validated inventory; a wrong shape is retried with the validation error |
| tool-raised `context.interrupt()` | `src/agent/tools.ts` `ruleOnCandidateTool(true)` | the run halts on a question the agent cannot answer |
| `InterruptResponseContent` resume | `src/agent/watch.ts` `resumeWithAnswer` | the same run continues, hours later, from another process |
| `SessionManager` + `LocalFileStorage` | `src/agent/watch.ts` `askAgent` | the halted conversation survives the process it started in |
| `BeforeToolCallEvent` hook | `src/agent/guards.ts` | six refusals, enforced on the tool boundary |
| `AfterToolCallEvent` hook | `src/agent/guards.ts` | a tool that refused itself is handed its reason back, exactly once |
| `AfterInvocationEvent.resume` | `src/agent/watch.ts` `askAgent` | the asking agent cannot end a turn without having asked |
| `InterventionHandler` | `src/agent/guards.ts` `NothingLeavesTheHouse` | nothing addressed outside the household is a tool the agent can simply call |
| `InvokeModelStage` middleware | `src/agent/throttle.ts` | one process-wide queue and backoff, so a fan-out cannot trip a rate limit |
| `ModelRouter` + `FallbackStrategy` | `src/agent/model.ts` | Amazon Bedrock as primary, an OpenAI-compatible gateway behind it |
| `DefaultModelRetryStrategy` + `ExponentialBackoff` | `src/agent/model.ts` | decorrelated jitter; a watch retries rather than failing |
| `ToolStreamEvent` | `src/agent/tools.ts` | per-source progress inside a single tool call |
| `BeforeNodeCallEvent` / `NodeResultEvent` | `src/agent/watch.ts` | each node's start and result is an event the live board draws from |
| `traceAttributes` / `appState` / `invocationState` | throughout | every span and tool call carries its household and pass id |

**Two things sit deliberately outside the model's control**, in plain code, after the graph finishes:

- `closeTheGaps` compares what triage *promised* to check against the checks actually recorded, and
  asks whatever is missing itself. A source the agent forgot is a hole in a safety net.
- `closeTheVerdicts` re-sends any record that was fetched and never ruled on, then *holds* — never
  drops — whatever is still unruled. A recall fetched, seen and quietly dropped is the one failure
  this product may not have.

The agent chooses how to look. The code guarantees that it looked.

**And six things it is not allowed to do**, refused in a `BeforeToolCallEvent` hook on the way to the
tool rather than asked for nicely in a prompt: invent a record; alarm you below 60% confidence; clear
a record that names your brand *and* your object; claim a unit whose manufacture window nobody has
checked; escalate severity to `critical` without the record's own do-not-drive flag or its own words
about death, injury, fire or a crash; or give one record two verdicts. The errors here are not
symmetric — a false alarm wastes five minutes, a false all-clear leaves a recalled dresser in a
child's room — and the rules are written asymmetrically to match.

The data layer is five keyless US federal endpoints behind one `SourceResult` shape that never
throws: NHTSA `recallsByVehicle` and `campaignNumber`, NHTSA `complaintsByVehicle`, NHTSA vPIC
`decodevinvalues`, CPSC `saferproducts.gov/RestWebServices/Recall`, and openFDA
`{food,drug,device}/enforcement.json`. Every source call writes a **check** row — endpoint, ok, row
count, latency — *before* the agent sees a single row, so what was asked cannot be changed by what
the model then does with it.

The rest: Next.js 15 (App Router, React 19, TypeScript strict), SQLite via drizzle + better-sqlite3,
server-sent events from the running pass straight onto the board, and pm2 on a small VM with two
apps — `vigil` and `vigil-sweep`, a cron every six hours. The sweep is what makes this a watch rather
than a button.

It runs on **MiniMax-M3** through an OpenAI-compatible endpoint. Amazon **Bedrock** is wired as the
primary of a Strands `ModelRouter` with a `FallbackStrategy` and switches on with `BEDROCK_MODEL_ID`
— but the deployed instance is not running on Bedrock, and this submission will not pretend
otherwise.

## Challenges I ran into

**The hardest problem is not finding recalls. It is knowing when you have found *yours*.** A CPSC
notice is four hundred words of prose describing a production run: a colour, a size in inches, a
weight, a date window, and where the label is. You own one object. Matching one to the other is a
judgement with two asymmetric failure modes, and both are unacceptable in different ways. The answer
was to make "I cannot tell" a first-class outcome with real machinery behind it — a tool-raised
interrupt that genuinely stops the run and persists — rather than a confidence number that gets
rounded up.

**Two of the federal APIs answer errors that look like success.** NHTSA returns HTTP 400 with a body
reading `"Results returned successfully", results: []` for a malformed query, which would otherwise
render to an owner as "no recalls for your car". CPSC returns HTTP 200 with a single fake row whose
title begins `Error retrieving Recalls`, which would otherwise render as one recall. Both are handled
in the HTTP client and both have tests, because either one silently produces the worst output this
product can produce: a false all-clear.

**A fan-out is the right shape for the work and the wrong shape for a rate-limited endpoint.** Three
lanes in parallel plus one match invocation per thing walked straight into `429 quota exceeded` and
lost every ruling in flight. The fix was a Strands `InvokeModelStage` middleware: the agents still
believe they are running in parallel, the gateway sees one queue with decorrelated backoff.

**A guard once blocked its own agent from asking.** An `unsure` ruling was being recorded as a
verdict, and the one-verdict-per-record rule then refused the follow-up that would have settled it.
The bug was conceptual, not mechanical: an `unsure` is a question, not a verdict. That distinction is
now written into both the hook and the tool.

## Accomplishments that I'm proud of

- **The stop is real.** Not a UI state, not a flag — a Strands interrupt with `stopReason: interrupt`
  that persists the run's own state to SQLite and resumes hours later, from a different process, with
  `InterruptResponseContent`. The `vigil-sweep` cron will skip a household that is waiting on an
  answer, because the question *is* the work.
- **The red-team test.** `npx vitest run src/agent/__tests__/gates.test.ts` pushes a deliberately
  jailbroken tool payload — an invented campaign number, a 0.2-confidence alarm, a `critical` on a
  record about a missing tyre-pressure label, an all-clear on a recall naming the exact brand and
  model of a child's car seat — through the real hook and the real tool, and asserts the findings
  table stays **empty**. A control case in the same file proves the harness can write, so zero rows
  means the gate held rather than the plumbing being broken. 108 tests pass in total.
- **Nothing on screen is on a timer.** The lamp moves across the household because a real HTTP
  request to a real federal API just started. A node turns red because a government record was
  matched to it. The field freezes because the agent actually stopped. Every frame of the board is a
  fold of server events, and a replay is always labelled a replay.
- **Every claim has its own artifact.** The landing page's recall card is fetched from api.nhtsa.gov
  while the page renders, with the endpoint and latency printed beside it. If NHTSA is down the card
  says so rather than showing a picture of a recall nobody looked up.

## What I learned

**Where a rule lives decides whether it is a rule.** Everything I first wrote as a paragraph in a
system prompt, I later had to move into a hook or a tool. A prompt is a request; a
`BeforeToolCallEvent` that sets `cancel` is a refusal. The useful test of any safety claim in an
agent is: can you write a test that jailbreaks the model and asserts nothing happened? If not, it is
a wish.

**Completeness is a separate problem from capability.** A good model plans well and then, on some
runs, quietly does four of the five things it planned. For a search engine that is a bad day; for a
safety net it is a hole. Comparing the plan to the recorded checks in code, and asking the
difference, turned out to be the single highest-value thing in the codebase — and it is about thirty
lines.

**Asymmetric errors need asymmetric rules.** I started with symmetric confidence thresholds and they
were wrong. A false alarm costs five minutes. A false all-clear leaves a recalled dresser in a
child's room. So "clear" is refused on a brand-and-object match outright, while "covers" needs 60%
and a checkable unit — and the honest middle is to stop and ask.

## What's next

- Run on Amazon Bedrock in production rather than only having the router wired for it, and evaluate
  AgentCore for the scheduled pass.
- An email channel for the one night it matters, so the interrupt reaches a person who is not looking
  at a browser tab.
- A stored block cursor and a scan for CPSC/NHTSA records published *between* passes, so a watch can
  say what changed since the last look rather than re-reading the corpus.
- Coverage beyond US federal data. The architecture is per-source, so a national recall register
  elsewhere is a file in `src/lib/sources/`, not a rewrite.
- Second-hand marketplaces are the real distribution problem worth solving: the moment a dresser
  changes hands is the moment it leaves every owner list there is.

## Built with

Strands Agents SDK (TypeScript) · Amazon Bedrock (wired via `ModelRouter` + `FallbackStrategy`) ·
TypeScript · Next.js 15 · React 19 · Node.js 22 · SQLite · drizzle-orm · better-sqlite3 · zod ·
Vitest · server-sent events · pm2 · nginx · NHTSA recalls API · NHTSA ODI complaints API · NHTSA vPIC
· CPSC saferproducts.gov REST · openFDA enforcement API

---

## For the judges

**Live, and nothing is needed from you:** <https://vigil.80.225.209.190.sslip.io>
No sign-up, no key, no wallet. Press **"Watch it work on a real house"**.

**Repo:** <https://github.com/shariqazeem/vigil> · MIT · architecture diagram in `docs/architecture.png`

**One command proves the safety rules are real:**

```bash
npx vitest run src/agent/__tests__/gates.test.ts
```

No network, no model, no keys. It jailbreaks the agent four different ways through the real hook and
the real tool and asserts the findings table stays empty — plus a control case proving the same
harness *does* write a finding when the ruling is honest. `npx vitest run` runs all 108.

**The three things to look at first:**

1. **The board, frozen mid-run.** On the demo house the field is stopped on
   `stopReason: interrupt` with the dresser question. That is a persisted Strands interrupt, not a
   UI state. Answer it and the same run continues.
2. **`src/agent/guards.ts`.** Six refusals in a `BeforeToolCallEvent` hook, each one a property you
   can test, each one commented with the real miss that motivated it.
3. **"See everything the last watch asked"** at the foot of the board. Every URL the agent called,
   with row counts and latency. They are public and keyless — paste one into a terminal and you get
   what Vigil got:
   ```bash
   curl -s "https://api.nhtsa.gov/recalls/recallsByVehicle?make=honda&model=accord&modelYear=2019"
   curl -s "https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallNumber=26522"
   ```

## Honest limitations

- **Vehicle matching is exact; product matching is not.** A VIN's model year against "certain
  2018-2019 Honda Accord" is a reliable comparison. A dresser against four hundred words of CPSC
  prose is a judgement — confidence-scored, and it asks rather than guesses. Expect it to ask.
- **The model is nondeterministic run to run.** That is precisely why the completeness gates live in
  code rather than in a prompt, and why every pass records what it actually asked.
- **It runs on an OpenAI-compatible gateway today (MiniMax-M3).** Bedrock is wired as the primary of
  a `ModelRouter` and switches on with `BEDROCK_MODEL_ID`, but the deployed instance is not running
  on Bedrock and this submission does not claim it is.
- **Not affiliated with NHTSA, CPSC or the FDA**, and not a substitute for registering your product
  with its manufacturer. It is a second pair of eyes on data those agencies publish.
- **Coverage is US federal data.** A household outside the US gets the vehicle and product corpora,
  which are large, but not its own country's.
- **The demo household is seeded with four ordinary objects that happen to have real recalls against
  them.** That is the point of the demo, and it is said plainly on the page.

## Prior work and disclosures

This repository's first commit is **8 September 2026**, inside the hackathon's submission period
(10 August – 14 September 2026). It was started by the same solo builder as a different product —
*Owed*, a debt-collection agent on the same Reader/Collector engine — and was re-aimed at Vigil on
14 September. The git history is public and intact; `git log` shows exactly this.

What carried over from that week, all the author's own work: the model factory, the SSE
stream-to-board pipe, the anonymous-owner cookie, the drizzle/SQLite setup, and the staged-build
deploy script. Design tokens and app-shell patterns were adapted from the author's earlier project
SAGE, which predates the submission period and is disclosed here for that reason. Everything specific
to Vigil — the sources layer, the graph, the guards, the completeness gates, the interrupt loop, the
field, and the tests — was written on 14 September 2026.
