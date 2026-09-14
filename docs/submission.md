# Devpost submission — Warden

*AWS "Agents for Humans" · Professional Agents track. Paste-ready copy; each section maps to a
Devpost field.*

---

## Name

Warden

## Tagline

An autonomous operator for software that is already running: it investigates your services when they
break, fixes what your policy allows, and proves the fix by re-running the check that failed.

## Links

- **Live, no sign-up:** https://warden.80.225.209.190.sslip.io
- **Source (MIT):** https://github.com/shariqazeem/warden
- **Architecture diagram:** `docs/architecture.png` in the repo (Mermaid source beside it)

---

## Inspiration

I run a few small services on one VM. Monitoring wakes me up; it does not do anything. And the thing
it wakes me up for is almost always the same four steps, in the same order: is the process actually
running, what does the log say, what deployed recently, does the smallest reversible act fix it.
At 3am, on a phone, I am a slow and error-prone shell script.

The reason nobody automates those four steps is that the automation is scarier than the outage. An
agent with a shell on a production box is a new and worse problem. So I built the boundaries first
and the agent second. Warden is what is left when you decide, up front, that the agent does not get
to choose what it is allowed to do, and does not get to decide whether it worked.

## What it does

Warden watches services on a clock, with nobody present. When a check has failed its threshold
number of times in a row — two, by default, so one blip is not an outage — it opens an incident and
hands it straight to an agent.

The agent investigates: the process table, the logs, recent commits, the diff of a suspicious one, a
specific file the evidence pointed it at. It gets ten looks, because the service is down while it
reads. Then it must commit to a cause and say how sure it is.

If it is sure enough, a second agent picks the smallest act the diagnosis supports and asks to do
it. What happens next is not the agent's decision. A per-service policy, written by a human, either
**allows** it, **refuses** it and names the rule that refused it, or **stops the run and asks** —
a real halt, held in the database, resumable hours later from another process.

Then the part that makes it a product instead of a demo: Warden re-runs *the exact check that
failed*. A clean reading closes the incident and its id is stored as the proof. Anything else and
the incident escalates, saying plainly that Warden acted but is not calling this fixed.

**Judges: there is a button on the front page that breaks it.** A working operator has a boring
board, which is a real presentation problem, and the honest answer to it is a real outage rather
than a video. If the fleet is quiet, *Break Vigil on purpose* runs `pm2 stop vigil` on the actual
machine; Warden's own checks notice, an incident opens, and you land on it with the run streaming.
Ninety seconds, nothing recorded. Which service that button may touch is one function with the
reasons written down and its own test file — never SAGE, never Warden's own console, never anything
a visitor registered — and stopping is still not one of Warden's own operations.

**And you can use it on your own things in under a minute.** Press *Watch something of yours*, give
it a URL, and that is the sign-up: a signed cookie makes the service yours and the next sweep picks
it up. Everything after that is in the console — the policy editor, where all seventeen operations sit
with a sentence each saying what granting it actually means, with the four forbidden ones shown
locked rather than hidden; adding and retiring checks; *check it now*, which streams each probe as
it answers; and the page where you say how Warden should reach you when it stops. There is a CLI and
it does the same things, because the same functions are behind both, but nothing about running
Warden requires a terminal.

It is currently watching three real services on one VM — its own console, a public site called
Vigil, and SAGE, which belongs to someone else and is registered `OBSERVE_ONLY`: every read allowed,
every act refused by name, action cap zero. That last one is the product in one card. You can point
an operator at something you are allowed to look at and not allowed to touch, and the policy is
where you say so. Those three are public to watch and writable by nobody — `canEdit` has no branch
for them, which is the only reason it is safe to leave the fleet open.

When it stops, it tells you. An address is a URL it POSTs to, so a Slack or Discord incoming webhook
works with nothing to install, and so does anything you wrote yourself. It sends when it stopped to
ask you, when it acted and the check still fails, and when it is handing the problem back — and only
to addresses that asked for everything does it mention something it already fixed, because that is
news, not an interruption.

A real run, from the audit table on the live site: Vigil was stopped on purpose. Warden read the
process table, both log streams and the recent commits, and diagnosed a stopped process at 85%
confidence — saying plainly that it could not name the trigger from the logs, and citing a standing
rule a person had left behind on an earlier incident — the policy returned `allow` under rule `policy-may`, it ran
`pm2 start vigil` in 371ms, re-ran the failing probe, got `200 in 207ms`, and closed the incident
after 60 seconds down. One row in that audit table is a refusal: it tried to read the pm2 log file,
which lives outside the service's checkout, and the operation refused it.

## What I had to get right before any of that could ship

Letting a browser write to this changed the threat model completely. Until then, registering a
service meant editing a file on the machine Warden runs on, so whoever did it already had a shell
there. Three boundaries, with a test file that attacks each one:

- **A probe is a server-side fetch on a timer**, which is the shape of every SSRF ever written. The
  cloud metadata addresses are refused on every instance, always — there is no configuration that
  turns that off, because the thing on the other end is the machine's own credentials. Everything
  else private is refused unless the operator opts in. Node keeps the brackets on an IPv6 hostname,
  so `[fd00:ec2::254]` slipped past the always-refuse rule until a test caught it.
- **A form never names an ssh key file.** Keys are chosen by nickname from a list the operator
  configured on the server; the path never touches the browser. Unset — which is what the public
  instance runs — the console can register services watched over http but cannot reach a machine.
- **A policy arriving from a form is sanitised before it is stored.** Not because `decide()` would
  ever honour a forbidden operation — it refuses them by risk, whatever the policy says — but
  because a stored policy *claiming* to grant `delete_data` would be rendered as granted, and
  somebody would reasonably believe they had granted it.

## How I built it

Warden is built on the **Strands Agents SDK** (TypeScript), and the SDK's shape is the product's
shape. One incident is a Strands `Graph` with two agents — `investigate` and `remedy` — joined by a
**conditional edge** whose handler reads the live incident context and returns false unless a
diagnosis has been recorded with confidence ≥ 0.5. Warden cannot act on a hunch, because a hunch
never reaches the agent that can act.

The diagnosis is a **tool call** (`record_diagnosis`), not a `structuredOutputSchema` on the final
message, because three other things need to read it mid-run: the graph's edge, the `act` guard, and
the incident row.

When the policy says `ask`, the `act` tool raises **`context.interrupt()`** from inside the
callback. The run genuinely stops — `stopReason: "interrupt"` — and the question is written to a
decisions table. When a human answers, possibly hours later and certainly in another process, the
answer comes back as **`InterruptResponseContent`** and the agent finishes the thought it was
having; a **`SessionManager` + `LocalFileStorage`** is what lets the conversation outlive the
process.

The rules that no policy can switch off live in **`BeforeToolCallEvent` / `AfterToolCallEvent`**
hooks: no operation that does not exist, no acting before diagnosing, no second go at the same act,
no acting past a refusal. An **`InterventionHandler`** (`TwoHandsOnly`) states the same boundary
declaratively — six tools are allowed, anything whose name suggests a shell is denied. Model calls
across every live incident go through one queue implemented as **`InvokeModelStage` middleware**, so
the fan-out stays and a rate-limited gateway sees a bounded queue.

**Amazon Bedrock** is wired as the primary candidate of a Strands **`ModelRouter`** with a
**`FallbackStrategy`** behind it, with prompt caching on, and switches on with `BEDROCK_MODEL_ID`.
The deployed instance is not on Bedrock — it runs MiniMax-M3 through an OpenAI-compatible endpoint —
and the console prints which model actually ran each pass so the screen cannot claim otherwise.

Underneath all of it: **Warden has no shell.** It invokes one of 17 named operations from a fixed
catalogue, arguments validated by zod, spawned with `execFile`. Four of them (`db_migrate`,
`delete_data`, `rotate_secret`, `destroy_infra`) are declared *forbidden* rather than omitted, so the
product can show you the line — and `decide()` refuses forbidden risk before it consults the policy
at all, so no policy can grant them.

The sweep is pm2 cron every ten minutes; the console is Next.js with the run streaming over SSE; the
ledger is SQLite through drizzle. 291 tests across 18 files, about a second, fully offline.

## Challenges I ran into

**A retry strategy cannot be shared.** I constructed one `DefaultModelRetryStrategy` and attached it
to both agents. The SDK binds a strategy to the agent that owns it; the second agent got an error
rather than a retry. It is a factory function now.

**The gateway's cost cap is a reservation, not a bill.** Requests were failing with
`429 quota exceeded (cap 0.5)` before any tokens were generated. The gateway reserves
`max_tokens × price` against a per-request ceiling up front — a request asking for 8000 tokens was
refused while the identical one asking for 4000 went through. Nothing Warden writes is long, so the
ceiling costs nothing and a 429 costs a whole pass.

**A guard that refused its own tool call.** The `no-second-go` rule records an `op:args` signature
when an act is attempted and refuses a second attempt. The hook ran twice for one call, so the act
tripped its own guard and Warden refused to do the thing it had just decided to do. The signature is
keyed on `toolUseId` now: the call that created the entry is not refused by its own entry.

**An agent that read its own last words.** The remedy agent's session, which exists so a halted run
can be resumed, survived into a *fresh* attempt at the same incident. It read its own earlier "I
could not do anything here" and said it again, with more confidence the second time. The session is
now cleared on a new attempt and kept on a resume — the distinction is the whole feature.

**pm2's restart count is cumulative.** The agent read "4 restarts" as a crash loop and refused to
start a process that was simply stopped. What actually answers that question is Warden's own reading
history for the failing check, which is now handed to the investigator explicitly.

**The halt fired for the first time in production, and could not be answered.** A restart fell
inside the cooldown, the policy returned `ask`, the run stopped holding the question — all correct.
Answering it threw `Agent is in an interrupted state`. The Strands interrupt id was held in an
in-memory map keyed by incident, and the id is generated inside the tool call that halts, in
whatever process is running then: the cron sweep, which prints the question and exits. The answer
arrives minutes later in the web app, a different process with an empty map, so the code fell back
to resuming with a prompt — which the SDK rightly refuses. Every test passed, because every test
halted and resumed inside one process, which is the one arrangement production never has. The
session on disk had the answer the whole time: `initialize()` replays it and the restored agent
knows which interrupt it is holding. If you build human-in-the-loop on Strands, assume from the
first line that the process raising an interrupt is not the process that answers it.

**Opening the console opened a door I had already closed once.** A service with no ssh key runs its
operations locally, and `repo` is chosen by whoever registers the service — so a stranger could
register `{repo: "/home/ubuntu/warden", process: "warden"}` and point `read_file` at Warden's own
checkout, where the `.env` is. The path containment in `operations.ts` is no defence, because the
containment is relative to a repo the attacker named. It was a real hole on my own instance for
about an hour and I verified it there before fixing it. The general shape is worth more than the
specific bug: every boundary in a system was drawn against an assumption about who is on the other
side of it, and none of them re-derive themselves when you let a new kind of person in.

**macOS unix sockets are capped near 104 bytes.** ssh connection multiplexing died with
`unix_listener: path too long` on every single call, because the default `ControlPath` combines the
per-user TMPDIR with ssh's `%C` hash. A deliberately short path fixed it, and an investigation that
makes a dozen remote calls in a minute stopped paying a handshake for each one.

## Accomplishments I'm proud of

The verification step. It would have been easy — and more impressive-looking in a demo — to let the
agent report success. Instead an incident can only be closed by re-running the same probe that
opened it, in code, with no model involved, and the reading's id is stored on the incident as the
proof. The number the console shows for "down" is measured to that reading, not to the moment of the
fix, which is the number an agent would prefer to report.

The red-team test. `src/agent/__tests__/gates.test.ts` takes a deliberately jailbroken sequence and
pushes each call through the real hook and the real tool callback, with `execFile` replaced by a
recorder and `fetch` by a spy that throws. After each attempt it asserts that nothing was spawned,
nothing left the machine, no model was called, and no row was written. Then it runs a control that
*does* all four, because a red-team test passing against a broken harness proves nothing.

And two bugs the test suite found on its own, both invisible from the outside: the `AfterToolCall`
hook read only `textBlock` while the `act` tool returns an object, so "no acting past a refusal"
never armed in production; and the sweep still read `row.restarts` after the parser renamed the field,
so every healthy reading rendered as "online, undefined restarts".

## What I learned

An autonomous agent is mostly a question about who decides. I kept finding that the interesting work
was not the prompt — it was moving a decision out of the model and into code where it could be
tested: what may happen (the policy), whether it worked (the probe), what has already been tried
(the actions table rather than the agent's memory), how long something was down (measured to a
reading).

The corollary is that a good prompt is mostly a description of the boundaries the code already
enforces. Every time I found myself writing "you must not…" into a system prompt, that was the
signal to write it as a hook instead.

I also learned that honest escalation is a feature, not a fallback. The agent's `give_up` tool
exists so that "here is what I found, here is what I tried, here is what you need to do" is a
first-class outcome. An operator that escalates well at 3am has done a night's work.

## What's next

- Move the deployed instance onto Bedrock and make the `ModelRouter` fallback earn its keep in
  production rather than in configuration.
- Exercise the disruptive path: `redeploy_previous` is `ask` in the default policy and has not yet
  been the thing that fixed a real outage.
- More probe kinds — a queue depth, a certificate expiry, a disk threshold — since every one of them
  is also a verification step, which is where they pay for themselves.
- Something better than a signed cookie for identity. It is enough to keep one visitor's services
  out of another's hands and it is not an account: clear the cookie and they are unreachable.
- A second host, so the ssh path is tested somewhere other than the machine that also runs Warden.

## Built with

TypeScript · Strands Agents SDK · Amazon Bedrock (`BedrockModel`, `ModelRouter`, `FallbackStrategy`)
· Next.js 15 · React 19 · SQLite + drizzle · zod · vitest · pm2 · Node 22 · MiniMax-M3 through an
OpenAI-compatible gateway · nginx

---

## For the judges

**Live, no sign-up, nothing to install:** https://warden.80.225.209.190.sslip.io — the demo fleet is
public on purpose.

**The claim you should be most sceptical of is "the policy is code, not a prompt". This command is
the answer, and it needs no API key, no network and no model:**

```bash
npm install --legacy-peer-deps
npx vitest run src/agent/__tests__/gates.test.ts
```

Three things to look at first, in this order:

1. **An incident page on the live site.** Scroll to *Everything it ran*. Every row is one named
   operation with its risk, the policy verdict, the **rule** that decided it, the exact command and
   the exit time. Copy any command and run it yourself. At the bottom: the incident is resolved
   because the same check that failed was run again and passed.
2. **`src/lib/ops/policy.ts`** — about 150 lines, one pure function. `decide()` has no clock, no
   model and no network, which is why `policy.test.ts` can prove every branch of it by hand. Note
   the order of the branches: unknown before anything, forbidden before the policy is consulted at
   all, `never` beating `may`, caps last.
3. **`src/agent/__tests__/gates.test.ts`** — the red team, described above. Then the control at the
   bottom of the file, which does the legitimate thing through the same harness.

If you want to watch it work end to end, the CLI prints the same run the console streams:

```bash
npx tsx --env-file=.env scripts/warden.ts register
npx tsx --env-file=.env scripts/warden.ts sweep
npx tsx --env-file=.env scripts/warden.ts handle <incidentId>
```

## Honest limitations

- **The deployed instance is not on Bedrock.** Bedrock is wired as the primary of a `ModelRouter`
  with a `FallbackStrategy` and switches on with `BEDROCK_MODEL_ID`; the live instance runs
  MiniMax-M3 through an OpenAI-compatible gateway, and the console says which model ran.
- **It has fixed one class of failure in production: a process that is down.** The catalogue can
  also run tests and roll back to the previous build. Neither has closed a real incident yet.
- **The halt has not fired on the live fleet.** The interrupt → answer → resume path is exercised by
  the test suite (including a cooldown case that raises a real interrupt and leaves a real question
  in the decisions table) and by the CLI. None of the three live services has needed to ask anything
  yet.
- **Confidence is the model's self-report.** The 0.5 floor keeps the obviously unsure from acting.
  It does not make a confident wrong answer right — that is what the probe is for, afterwards.
- **One VM, three services, SQLite, no sign-up.** Anything you register yourself sits behind a
  signed cookie. That is enough for what this is and would not be enough for a product with
  customers.
- **This repository began on 8 September 2026 as a different product and was re-aimed twice.** The
  git history is public and intact. The design tokens, the drizzle ledger shape, the SSE console and
  the Strands plumbing were carried forward; the catalogue, the policy, the guards, the graph, the
  verification step and every test named here are new.
