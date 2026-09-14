# Vigil

**An autonomous agent that keeps watch over the physical things in your home — the car, the cot, the
dresser, the baby monitor, what's in the medicine drawer — against live US federal safety data, and
wakes you only when one of them becomes dangerous.**

Live: **https://vigil.80.225.209.190.sslip.io** · Source: **https://github.com/shariqazeem/vigil** · MIT

Built on the **[Strands Agents SDK](https://github.com/strands-agents)** (TypeScript).

---

## The problem

A recall notice is posted to the address the manufacturer had when the product was new. That is not
where you live, and it never was if you bought the thing second-hand or it was handed down. So the
notice about the dresser in your child's room arrives at somebody else's house.

The consequences are not marginal:

- Roughly **9 in 10 recalled consumer products are never returned, repaired or thrown out**
  ([CPSC](https://www.cpsc.gov/Newsroom/News-Releases)).
- **Car-seat recall completion sits near 30%**; NHTSA issues around a thousand vehicle recall
  campaigns a year, covering tens of millions of vehicles.
- Second-hand and hand-me-down goods are **structurally invisible** to the entire recall system —
  nobody registered them, so nobody can be told. Those are exactly the goods that circulate through
  neighbourhood networks and families with the least money.

Nobody is checking on your behalf. Not ever, and not for the four years it might take before the
recall on the thing in your child's room is published.

This is not a job a person can do. It is not a job an app can do either — an app is a thing you have
to remember to open. It is a job for something that runs when you are asleep, for years, and
interrupts you exactly once, on the night it matters.

## What Vigil does

1. **You tell it what is in your house. Once.** A sentence, a photo of a shelf, a VIN typed on a
   phone. It turns that into things it can watch, and it is forced to declare what it could *not*
   read rather than filling the gap in.
2. **Then it does nothing visible, for months.** On a schedule, with nobody present, it asks four
   public federal sources about every thing you own, and records every question it asked — the URL,
   whether the source answered, how many rows came back, how long it took.
3. **And when it cannot be sure, it stops.** A recall names a model range and a manufacture window,
   not your serial number. When Vigil cannot tell whether a record covers *your* unit, it does not
   guess in either direction. The run genuinely halts — `stopReason: interrupt` — and stays halted,
   in the database, until a human answers one short question. What you answer is kept in your words,
   so it never asks twice.

Who it is for: anyone with a child, a car, or a second-hand anything. It is aimed hardest at the
people the recall system already fails — families who bought used, and the person who runs the home
daycare with eleven cots and four car seats nobody registered.

## Try it in sixty seconds

**The live demo needs nothing from you.** Open
[the demo house](https://vigil.80.225.209.190.sslip.io) and press *Watch it work on a real house*.
It is four ordinary things — a 2019 Honda Accord, a Mainstays 9-drawer fabric dresser, a Babysense
Max View baby monitor, vitafusion melatonin gummies — and every finding on it is a real government
record you can look up yourself.

```bash
# the tests, including the red-team one. No network, no model, no keys.
npx vitest run                                     # 108 passing

# the whole product from a terminal
npm install --legacy-peer-deps
cp .env.example .env                               # fill in LLM_BASE_URL + LLM_API_KEY
npx tsx --env-file=.env scripts/pass.ts seed demo  # a household of four ordinary things
npx tsx --env-file=.env scripts/pass.ts run <id>   # one watch, printed as it happens
npx tsx --env-file=.env scripts/pass.ts answer <decisionId> yes   # resume a halted run

# the four federal sources, live
npx tsx --env-file=.env scripts/sources-smoke.ts

npm run dev -- -p 3100                             # the board
```

Nothing here is a fixture. You can check any finding yourself:

```bash
curl -s "https://api.nhtsa.gov/recalls/recallsByVehicle?make=honda&model=accord&modelYear=2019" | jq '.results[] | {NHTSACampaignNumber, Consequence}'
curl -s "https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallNumber=26522" | jq '.[0].Title'
```

## Architecture

![Vigil's architecture](docs/architecture.png)

One pass is a Strands **`Graph`**. `triage` decides which agency could possibly know about each
thing; three lanes ask them **in parallel** behind conditional edges; whatever came back goes to
`match` behind another conditional edge. `match` is the only genuinely hard judgement in the system,
because a recall notice describes a production run and you own one unit of it.

Two things sit deliberately outside the model's control, in plain code, after the graph:

- **`closeTheGaps`** compares what triage *promised* to check against the checks actually recorded,
  and asks whatever is missing itself. A source the agent forgot is a hole in a safety net.
- **`closeTheVerdicts`** re-sends any record that was fetched and never ruled on, then *holds* — never
  drops — whatever is still unruled. A recall fetched, seen and quietly dropped is the failure this
  product may not have.

> The agent chooses how to look. The code guarantees that it looked.

### How the Strands Agents SDK is used

| SDK feature | Where | What it does here |
| --- | --- | --- |
| `Graph` + conditional edges | `src/agent/watch.ts` `buildGraph` | triage → three parallel lanes → match; edges evaluate live against the pass's own state |
| `Agent` + `structuredOutputSchema` | `src/agent/intake.ts` | a drop becomes a zod-validated inventory; a wrong shape is retried with the validation error |
| tool-raised `context.interrupt()` | `src/agent/tools.ts` `ruleOnCandidateTool(true)` | the run halts on a question the agent cannot answer |
| `InterruptResponseContent` resume | `src/agent/watch.ts` `resumeWithAnswer` | the same run continues, hours later, from another process |
| `SessionManager` + `LocalFileStorage` | `src/agent/watch.ts` `askAgent` | the halted conversation survives the process it started in |
| `BeforeToolCallEvent` hook | `src/agent/guards.ts` | the six refusals, on the tool boundary |
| `AfterToolCallEvent` hook | `src/agent/guards.ts` | a tool that refused itself is handed its reason back, exactly once |
| `AfterInvocationEvent.resume` | `src/agent/watch.ts` `askAgent` | the asking agent cannot end a turn without having asked |
| `InterventionHandler` | `src/agent/guards.ts` `NothingLeavesTheHouse` | nothing addressed outside the household is a tool the agent can simply call |
| `InvokeModelStage` middleware | `src/agent/throttle.ts` | one process-wide queue and backoff, so a fan-out cannot trip a rate limit |
| `ModelRouter` + `FallbackStrategy` | `src/agent/model.ts` | Bedrock primary, an OpenAI-compatible gateway behind it |
| `DefaultModelRetryStrategy` + `ExponentialBackoff` | `src/agent/model.ts` | decorrelated jitter; a watch retries rather than failing |
| `ToolStreamEvent` | `src/agent/tools.ts` | per-source progress inside a tool call |
| `BeforeNodeCallEvent` | `src/agent/watch.ts` | each node's start is an event the board draws from |
| `traceAttributes` / `appState` / `invocationState` | throughout | every span and tool call carries its household and pass id |

### The six things it is not allowed to do

Not asked nicely in a prompt. Refused in a `BeforeToolCallEvent` hook the agents are constructed
with, on the way to the tool:

1. **Invent a record.** A finding can only be built from a row that came back from a real HTTP
   request during that pass.
2. **Alarm you on a hunch.** A `covers` verdict below 60% confidence is refused; it must ask instead.
3. **Clear something it recognises.** When a record names the thing's brand *and* a word about the
   object itself, "not yours" is refused outright. The errors here are not symmetric: a false alarm
   wastes five minutes, a false all-clear leaves a recalled dresser in a child's room.
4. **Claim a unit it cannot identify.** If a record is scoped to a manufacture window, lot or serial
   range that nobody has checked, `covers` is refused — it has to ask you to go and look at the label.
5. **Escalate a tone.** `critical` is refused unless the record carries NHTSA's own do-not-drive flag
   or its own words describe death, serious injury, fire or a crash.
6. **Give a record two verdicts.** A second, contradicting `covers` or `clear` is refused; an earlier
   `unsure` is a question, not a verdict, and may still be settled.

```bash
npx vitest run src/agent/__tests__/gates.test.ts
```

That is the red-team test. It pushes a deliberately jailbroken tool payload — a fabricated campaign
number that was never fetched, a 0.2-confidence `covers`, a `critical` on a record whose text says
nothing dangerous, a `clear` on an exact brand-and-model match — through the real hook and the real
tool, and asserts the findings table stays empty. A control case in the same file proves the harness
*can* write, so the test is not vacuously passing. Each guard has its allow-case too.

### The sources

| Source | Endpoint | Keyless |
| --- | --- | --- |
| NHTSA recalls | `api.nhtsa.gov/recalls/recallsByVehicle` | yes |
| NHTSA owner complaints | `api.nhtsa.gov/complaints/complaintsByVehicle` | yes |
| NHTSA vPIC (VIN decode) | `vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues` | yes |
| CPSC recalls | `saferproducts.gov/RestWebServices/Recall` | yes |
| openFDA enforcement | `api.fda.gov/{food,drug,device}/enforcement.json` | yes |

Every source call records a **check** row — endpoint, ok, row count, latency — *before* the agent
sees a row, so what was asked cannot be changed by what the model then does with it. A source that
times out is recorded as **unchecked**, never as clear. Silence is not safety.

Two of these APIs answer errors that look like success, and the client handles both: NHTSA returns
HTTP 400 with a body reading `"Results returned successfully", results: []` for a malformed query,
which would otherwise render as "no recalls for your car"; CPSC returns HTTP 200 with a single fake
row whose title begins `Error retrieving Recalls`, which would otherwise render as one recall.

## What is honest about this

- **Vehicle matching is exact; product matching is not.** A VIN's model year against `certain
  2018-2019 Honda Accord` is a reliable comparison. A dresser against four hundred words of CPSC
  prose is a judgement, and it is confidence-scored and asks rather than guesses. Expect it to ask.
- **The model is nondeterministic run to run.** That is precisely why the completeness gates exist in
  code rather than in a prompt, and why every pass records what it actually asked.
- **It runs on an OpenAI-compatible gateway today** (MiniMax-M3). Amazon Bedrock is wired as the
  primary of a `ModelRouter` and switches on with `BEDROCK_MODEL_ID`, but the deployed instance is
  not running on Bedrock, and this README will not pretend otherwise.
- **It is not affiliated with NHTSA, CPSC or the FDA**, and it is not a substitute for registering
  your product with its manufacturer. It is a second pair of eyes on data those agencies publish.
- **Coverage is US federal data.** A household outside the US gets the vehicle and product corpora,
  which are large, but not its own country's.
- The demo household is seeded with four ordinary objects that happen to have real recalls against
  them. That is the point of the demo, and it is said plainly on the page.

## Setup

```bash
npm install --legacy-peer-deps   # the Strands SDK's optional peers conflict under strict resolution
cp .env.example .env
npm run typecheck && npm run lint && npx vitest run
npm run dev -- -p 3100
```

Deployment is `./scripts/deploy.sh` (rsync → build in a staging directory → `pm2 startOrReload`). Two
pm2 apps run on the VM: `vigil` (`next start -p 3100`) and **`vigil-sweep`**, a cron every six hours
that runs `scripts/sweep.ts` over every household whose last look is older than the gap. The sweep is
what makes this a watch rather than a button; a household already waiting on an answer is not woken
again, because the question *is* the work.

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

## Licence

MIT. See [LICENSE](LICENSE).

Data from NHTSA, CPSC and the FDA is public US government information. Vigil is not affiliated with
any of them.
