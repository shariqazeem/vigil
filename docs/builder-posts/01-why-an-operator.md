# Agents for Humans: I did not want another monitor, I wanted an operator

I run three small services on one VM. Two are mine; one belongs to someone else and I am only
allowed to look at it. Between them they have the usual monitoring — an HTTP check, a process check,
a notification when something stops answering.

Monitoring works. That is not the complaint. The complaint is that monitoring's entire job is to
wake me up, and what I do after it wakes me up is almost always the same four things in the same
order:

1. Is the process actually running, or has it stopped?
2. What do the last hundred lines of the log say?
3. What deployed recently, and does the timing line up?
4. Does the smallest reversible act — usually a restart — fix it?

That is not judgement. That is a runbook I execute badly at 3am on a phone. Most of the time step
one is the answer and steps two through four are me being careful. The genuinely hard cases — the
ones where I have to decide whether to roll back a deploy, or whether the data is in a state I can
live with — are rare, and they are exactly the cases where I would not want anything acting on my
behalf.

So I built Warden: an agent that does the first four steps, stops where my judgement actually
begins, and can prove what it did.

## Why nobody builds this

The reason this is not a solved problem is not that the steps are hard. It is that the automation is
scarier than the outage. An agent with a shell on a production box is a strictly worse problem than
a site being down for twenty minutes: a model given `run_command` and told firmly, in a system
prompt, to only run safe things is one confusing log line away from doing something creative.

So this is a question about boundaries, not about prompting. I decided up front that two things
would never be the model's to decide:

- **whether an act happens** — a per-service policy, written by a human, evaluated in code;
- **whether it worked** — the check that failed, re-run, with no model anywhere near it.

Everything else in Warden follows from those two sentences.

## The policy is a document I would defend

Each service carries a policy. It lists operations under `may`, `ask` and `never`, plus a cap on how
many acts one incident may contain, and a cooldown so a granted permission does not become an
unbounded one.

```
may      Warden does it, and tells you afterwards.
ask      Warden works out exactly what it would do, then stops and asks. The run halts.
never    Warden refuses, and says which rule refused it.
```

The decision is one pure function. It takes an operation name, a policy and two numbers — how many
acts have happened on this incident, how many minutes since the last act on this service — and
returns a verdict, the rule that decided, and a sentence addressed to the person who wrote the
policy. No clock, no network, no model, so every branch is proved by a unit test that runs in
milliseconds. The order of those branches is itself a tested property: an unknown operation is
refused before anything else; forbidden risk is refused before the policy is consulted at all;
`never` beats `may`; the caps are checked last.

The most useful policy I have written is the one that does nothing. One of the three services Warden
watches is not mine. It is someone else's production, entered in two competitions I have no part in.
Its policy grants every read and names every act under `never`, with an action cap of zero:

> Watch and diagnose. Touch nothing — this service is not ours to operate.

Warden probes it every ten minutes. If it broke, Warden would investigate it and write down what it
found, and then stop. The card in the console says `observe only`. That card is the reason I am
willing to let an agent restart the other two.

## There is no shell, and there is no way to compose one

Under the policy sits the thing that makes the policy meaningful. Warden cannot run a command. It
can invoke one of twenty **named operations** from a fixed catalogue — `pm2_list`, `pm2_logs`,
`git_log`, `git_show`, `read_file`, `grep_repo`, `disk_free`, `http_probe`, `pm2_restart`,
`pm2_start`, `run_tests`, `redeploy_previous` — with arguments validated by a zod schema, spawned
with `execFile`. No string is ever concatenated into a shell. A semicolon in an argument is a
semicolon.

Four more operations are in that catalogue and can never run: `db_migrate`, `delete_data`,
`rotate_secret`, `destroy_infra`. They are *declared rather than omitted*, which was a deliberate
product decision. If they were simply absent, I would be asking you to trust a list you cannot see.
Because they are present and marked forbidden, the console can show you the line, the test suite can
prove that the most permissive policy anybody could write still cannot reach them, and the refusal
names the rule: `forbidden-always`.

A path handed to `read_file` or `grep_repo` is resolved against the service's own checkout and
rejected if it escapes it. In the run below, the agent tried to read
`/home/ubuntu/.pm2/logs/vigil-error.log`, which is outside the repo, and the operation refused it.
The model did not decide to be careful. The path check did.

## The part that makes it an operator

The difference between an operator and a button is that nobody presses an operator.

pm2 runs the sweep every ten minutes: ask every probe on every service, write down every answer
including the boring ones, open an incident when a check has failed twice in a row, and hand that
incident straight to the agent. No human is present for any of it. Most passes write a row saying
everything answered, and that is the product working. The claim Warden makes most often is "it has
been fine", and that claim needs rows behind it.

## How it knows it worked

Here is a real run, taken from the audit table rather than from memory.

I stopped a service on purpose. Warden's own checks opened an incident and it was handed over. The
agent read the process table, both log streams and the recent commits, and committed to a cause at
85% confidence: the site is returning 502 because the process is stopped; pm2 reports it `stopped`
with a `lastStartedAt` that sits between the last passing check and this one; the error log is empty
and stdout shows only clean Next.js startup banners. Then the sentence I care about most —
**"So I cannot name the trigger of the stop from logs alone — it was silent."** It named two commits
that bracket when the service started getting unhealthy, for a person to look at if it recurs, and
declined to blame either of them.

The policy returned `allow` under rule `policy-may`. It ran `pm2 start vigil`, which came back ok in
371ms.

And then the step the whole product rests on: Warden re-ran the exact probe that had failed. Same
check, same expectation, in code. It came back `200 in 207ms`. That reading — its database id — is
what closed the incident. The console reports the outage measured from the incident opening to that
reading, not to the moment of the fix, because the moment of the fix is the number an agent would
prefer to report.

If the reading had come back failing, the incident would say: "Warden acted, but the check still
fails. It is not calling this fixed." And I would be awake, with a full account of what it tried.

Note what this buys. The diagnosis above was *incomplete* — Warden never established why the process
stopped, and said so. It acted on the part it could establish, and something other than the model
decided whether that was enough. An agent allowed to be uncertain out loud, inside a boundary that
does not depend on its certainty, is a different kind of thing from an agent that has to sound sure.

## Writing a policy is the product, so it is a screen and not a file

For most of the build, everything real about Warden lived behind a terminal. Registering a service
meant editing a script on the server; writing a policy meant editing a TypeScript literal. The web
app was a window onto what the agent had done.

That was the wrong shape, and the reason is not convenience. The policy is the thing a person is
being asked to take responsibility for. If writing it requires a shell, ssh access and a redeploy,
then in practice one person writes it once and nobody ever looks at it again — which is exactly how
a permission that made sense in March quietly authorises something in September.

So the policy is now a screen. All twenty operations, each with a sentence saying what granting it
actually *means* — you cannot meaningfully agree to `redeploy_previous` if nothing on the page tells
you it checks out the previous commit and restarts. Three answers per line. The four operations that
are refused by name are shown **locked** rather than hidden, because "you cannot turn this on" is
information and an absence is not. Nothing applies until you press save: an agent's permissions
should not change because a finger slipped on a toggle.

Two consequences I did not anticipate but would now design for deliberately.

The first is that writing the sentences changed the catalogue. Explaining `redeploy_previous` in one
honest line — *checks out the previous commit and restarts; this changes which code is running* —
makes it obvious it belongs in a different risk class from restarting a process, which had been a
judgement call in a config file nobody read.

The second is that opening the console changed the threat model completely, and I missed part of it
for an hour. A service with no ssh key runs its operations locally, and the checkout path is chosen
by whoever registers the service — so a stranger could point the agent's `read_file` at the machine
Warden itself runs on. The containment that existed was relative to a repo the attacker named. Every
boundary in a system was drawn against an assumption about who is on the other side of it, and none
of those assumptions re-derive themselves when you let a new kind of person in.

## It has to be able to reach you

The sentence I had been writing since the first commit was "it wakes you only when the decision is
genuinely yours". For most of that time it described a screen: the run halted, a card appeared, and
it sat there until somebody happened to look at it.

An operator that cannot reach you has not woken you. An address is now a URL Warden POSTs to — a
Slack or Discord incoming webhook is exactly that, and so is anything you wrote yourself, so no
credential is stored and nothing has to be approved by anybody.

Two rules about it matter more than the feature. Delivery never fails a run: a dead webhook must not
turn a fixed incident into an error. And every attempt is written down, success or not, because a
hook that silently stopped working looks exactly like a quiet night — which is the failure mode that
would make the whole product a lie.

## What it is for

Small teams cannot afford someone awake at 3am. They can afford something that does the mechanical
first four steps carefully, inside a boundary they wrote themselves, and hands back an honest
account either way — fixed and verified, or here is what I found, what I tried, and what you need
to do.

That second outcome is a feature, not a fallback. An honest escalation at 3am is a good night's
work. Guessing at somebody's production is not.

---

*Warden is open source (MIT): https://github.com/shariqazeem/warden. It is built on the Strands
Agents SDK; the next post is about which parts of the SDK the boundaries are actually made of.*
