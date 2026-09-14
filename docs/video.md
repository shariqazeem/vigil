# Warden — demo video script

> **If you run out of time, there is already a submittable video.** `node scripts/shoot.mjs` films
> production, then `node scripts/cut.mjs` stitches it into `var/shots/warden-demo.mp4` — 2:59,
> captioned, no narration, every frame a recording of the live instance. It is insurance, not the
> deliverable: a person talking over their own product is always better, and the script below is for
> that film. But a silent honest three minutes beats no video at all.

Screen recording with voiceover. **Target 4:52, hard ceiling 5:00.** A short cut ends at
**2:30** — see [The 2:30 cut](#the-230-cut).

Rules for this recording: real screens only, no slides, no stills. The cursor moves, the terminal
types, the timeline fills in. Waiting is speed-ramped in the edit, never trimmed to a jump cut that
hides a step. The two moments that play at 1× and are held are **the policy verdict** and **the
re-run of the check**. Everything else can move.

Voice: plain, unhurried, first person. Say numbers that are on screen and nothing that is not.

---

## Before you record

Do these in order. The first one has bitten this project already.

1. **Pause the sweep.**
   ```bash
   ssh ubuntu@80.225.209.190 'pm2 stop warden-sweep'
   ```
   The sweep runs every ten minutes, opens incidents and **hands them straight to the agent**. If it
   is running, Warden will find and fix your deliberate outage before the camera gets there, and you
   will be recording an incident that is already resolved with the "Hand it to Warden" button gone.
   This has happened. Pause it first.
2. **Check the cooldown.** The default policy is `cooldownMinutes: 10`, measured per service from
   the last act Warden was *allowed*. If you rehearsed a restart of Vigil less than ten minutes ago,
   the next one comes back as `ask` under rule `cooldown` and the run halts instead of fixing
   anything. Wait it out, or accept it and record the halt instead — it is a good scene, just a
   different one.
3. **Confirm the board is green.** Load https://warden.80.225.209.190.sslip.io and check all three
   cards are up and nothing is waiting on an answer.
3a. **Have a URL ready for beat 3** — something you actually run, that is actually up. Registering
   something that is already down makes the next ninety seconds confusing. And know that registering
   is permanent for that browser: it is yours until you delete it, so use a browser profile you are
   happy to leave a service in, or delete it afterwards from the bottom of its own page.
3b. **Have an address on /settings already added and working**, so beat 10's *Send one now* returns
   a result rather than a failure. Press it once before you record.
4. **Confirm Vigil is actually up** before you stop it: https://vigil.80.225.209.190.sslip.io should
   answer 200. A service that is already down has no "goes red" moment.
5. **Two windows, sized and placed**: a browser at 1440×900 with bookmarks hidden, and a terminal
   with a large font, `ssh` already connected and the prompt cleared. Never show `.env`, a key path,
   or your shell history.
6. **Zoom the browser to 110%** so the audit table's monospace is readable in the encode.
7. **Afterwards, restart the sweep:**
   ```bash
   ssh ubuntu@80.225.209.190 'pm2 start warden-sweep'
   ```

---

## The beats

### 1 · The problem, over a green board — 0:00–0:26

**DO** Open on the console, already loaded, scrolled to the top. Slow scroll down through the three
service cards and stop with all three visible. Nothing is clicked.

**SAY**
> I run three services on one machine. Right now all of them are up, and this page is boring on
> purpose — that is what a normal night looks like.
>
> The thing is, monitoring already told me this. What monitoring does not do is the part that
> happens after the alert. Is the process running. What does the log say. What deployed recently.
> Does the smallest reversible thing fix it. That is four steps, in the same order, at three in the
> morning, from a phone.

### 2 · Who it is for, and the one card that matters — 0:26–0:52

**DO** Hover the SAGE card. Punch in on the `observe only` chip and the line under it.

**SAY**
> This is for a team of one to five people who have something in production and nobody awake at 3am.
>
> And this card is the whole idea. SAGE is not mine. It is someone else's production, entered in two
> competitions I am not part of. Warden watches it and cannot touch it — every read allowed, every
> action refused by name. That is not a demo setting. It is a policy I wrote, per service, in code,
> and it is the reason I am willing to give the other two to an agent at all.

### 3 · Point it at something of yours — 0:52–1:27

This beat is the difference between a thing a judge watches and a thing a judge could use. Do not
skip it to save time; cut from beat 8 instead.

**DO** Click **Watch something**. Type a name and a URL of something you actually run. Press
**Start watching**. You land on the service page.

**SAY**
> And it is not only mine. A URL is a whole registration — that is the sign-up, there is no account
> and no email, a signed cookie makes it yours.

**DO** Scroll straight to *What it may do here*. Slow pan down the list of seventeen operations. Stop
on `redeploy_previous` and read the sentence next to it. Then click **Never** on it, and watch the
save bar rise from the bottom of the screen. Press **Save policy**.

**SAY**
> This is the part I would want to see if somebody showed me this. Every single thing the agent is
> able to do, with a sentence saying what granting it actually means — because you cannot agree to
> "redeploy previous" if nothing on the screen tells you it checks out the last commit and restarts.
>
> I can change any line of it. And nothing happens until I press save.

**DO** Scroll to the four greyed rows at the bottom and hold.

**SAY**
> Except these four. Migrate a database, delete data, rotate a secret, destroy infrastructure. They
> are in the list so you can see they are refused, and there is no setting on this page or anywhere
> else that turns them on.

### 4 · Break something on purpose — 1:27–1:51

**DO** Cut to the terminal, already `ssh`'d into the VM. Type visibly, at real speed:
```bash
pm2 stop vigil
```
Hold on pm2's table showing `vigil · stopped`.

**SAY**
> So let us break one. Vigil is a real public site running on this box. I am going to stop it — not
> simulate it, stop it — and then leave.

**DO** Run one sweep by hand, on the VM, and let it print:
```bash
cd /home/ubuntu/warden && npx tsx --env-file=.env scripts/warden.ts sweep
```
It prints each probe with a tick or a cross and ends with `INCIDENT Vigil: …` and the command to
handle it. Ramp the ssh latency in the edit; hold on the red INCIDENT line.

**SAY**
> This is the pass that normally runs every ten minutes on a cron, with nobody here — it asks every
> check on every service and writes down the answer. I am running it by hand because I paused the
> cron before recording. If I had not, Warden would have found this and fixed it before the camera
> got here.

**DO** Cut back to the browser. Reload. The Vigil card turns red, its sparkline picks up a red mark,
and the incident appears in the card's list.

### 5 · Hand it over — 1:51–2:07

**DO** Click through to the incident page. Let the page settle: the title, the red `open` chip, the
symptom `expected 200, got 502`. Move to the button and press **Hand it to Warden**. Hold on the
first row appearing.

**SAY**
> Here is the incident. What the check said, verbatim, and nothing else yet — because nothing has
> been done about it yet.
>
> One button. Everything from here happens in front of you.

### 6 · The investigation — 2:07–2:49 · *speed-ramp 3–4× in the edit*

**DO** Let the timeline fill. Keep the page scrolled so new rows are visible as they land. Ramp the
gaps between rows; do not cut any row out. Drop to 1× for the diagnosis row and hold it.

**SAY**
> It looks at the process table first, because a stopped process explains a 502 and you do not need
> to read source code to know that. Then the logs. Then what landed recently, and the diff of the
> one commit that looks relevant.
>
> Each row says what it ran and what it was hoping that would tell it. It gets ten of these. The
> service is down while it reads, and an investigation that keeps reading is avoiding a conclusion.

**DO** Hold on the diagnosis row, with the confidence percentage visible.

**SAY**
> Then it has to commit. A cause, in plain words, quoting what it actually read — and how sure it
> is. Notice what it does here: it names a commit as a suspect and then says it has not confirmed
> that commit crashed anything. It is allowed to be unsure out loud. Under fifty per cent, it does
> not get to act at all.

### 7 · The policy decides — 2:49–3:05 · **1×, held**

**DO** The `policy · allow` row lands. Punch in on the rule name — `policy-may` — and the sentence
under it.

**SAY**
> And here is the boundary. The agent asked to do something. It did not decide whether it was
> allowed. That is a pure function reading the policy I wrote for this service, and it answers with
> the rule that decided — allow, refuse, or stop and ask me.

> **← THE 2:30 CUT DROPS THIS BEAT AND EVERYTHING AFTER BEAT 8.** See below.

### 8 · The fix, and the part that makes it true — 3:05–3:42 · **1×, held**

**DO** The `acts` row: `start vigil · on ubuntu@80.225.209.190`. Then the re-runs-the-check rows.
Hold on the verify row and on the green `resolved` summary with the down time. **Read the numbers
off your own recording** — in the reference run the act came back in 371ms and the check read
`200 in 207ms`, and yours will differ.

**SAY**
> It starts the process. Under a second.
>
> And then the part I care about most. Warden does not get to tell you it fixed something. It
> re-runs the exact check that failed — the same probe, the same expectation, in code, with no model
> anywhere near it. Two hundred. That reading is what closes the incident, and its id is stored on
> the incident as the proof. If it had come back failing, this would say "Warden acted, but the
> check still fails," and I would be awake.

### 9 · Everything it ran — 3:42–4:12

**DO** Scroll to *Everything it ran*. Slow pan down the table: operation, risk, policy verdict, rule,
the exact command, milliseconds. Stop on the row where a read was refused — *path escapes the service
checkout*. Then stop on the last line of the page.

**SAY**
> At the bottom is every call it made, with the rule that permitted each one. Copy any of these and
> run it yourself; that is the point of the column.
>
> Warden has no shell. It cannot compose a command. It picks an operation by name from a fixed list
> of seventeen, the arguments are validated, and it is spawned without a shell — so a semicolon in an
> argument is a semicolon, not a second command.
>
> Look at this row. It tried to read the pm2 error log, which lives outside the service's checkout,
> and the operation refused it. Not the model deciding to be careful. The path check.
>
> And four operations in that catalogue — migrate a database, delete data, rotate a secret, destroy
> infrastructure — are in the list specifically so I can show you they are refused. No policy can
> turn them on.

### 10 · Back to boring, and it tells you — 4:12–4:32

**DO** Run one more sweep by hand on the VM (same command as beat 3) so every check is green and any
second incident closes on a clean reading. Then back to the console: the Vigil card is green again
and the incident row reads `resolved` with the down time. Hover the SAGE card once more.

**SAY**
> Board is green again, and the incident is sitting in the history with how long it was actually
> down.
>
> That is the whole product: it does the mechanical part, it proves the fix with the check instead
> of with a claim, and when the decision is genuinely mine, it stops and asks — the run actually
> halts, and it can be picked back up hours later from a different process.

**DO** Click **Reach you** in the nav. Show one address with its last delivery line. Press **Send
one now** and hold on the result appearing.

**SAY**
> And it can actually reach me. That is a webhook — Slack, Discord, or anything of your own — and
> it posts when it stops to ask, when it acted and the check still fails, and when it is handing
> something back. Not when it quietly fixed something; that is news, not an interruption.

### 11 · Why it matters — 4:32–4:52

**DO** Cut to the terminal. Run:
```bash
npx vitest run src/agent/__tests__/gates.test.ts
```
Hold on the pass line. Then a last shot of the console, green.

**SAY**
> One last thing, because "the policy is code, not a prompt" is the claim you should be most
> sceptical of. This test takes a jailbroken agent — an invented operation, a forbidden one, an
> action before any diagnosis, a probe pointed at the cloud metadata endpoint — and pushes each one
> through the real hooks and the real tools, with nothing able to spawn a process or reach the
> network. It asserts nothing ran and nothing was written. Two hundred and twenty-eight tests, offline,
> under a second.
>
> Small teams cannot afford someone awake at 3am. They can afford something that does the first four
> steps carefully, inside a boundary they wrote, and proves what it did.

---

## The 2:30 cut

Ends at **2:30**, on the held `policy · allow` frame, with one line replacing beat 6's last sentence:

**SAY** (replacing the tail of beat 6)
> That is a pure function reading the policy I wrote for this service. It allows the restart — and
> then Warden re-runs the exact check that failed and gets a two hundred, which is the only thing
> that closes an incident here.

**DO** Let beat 8's re-run row land under the voiceover, hold on the `200 in …` reading, and end on the
green console for two seconds.

Cut, in order: beat 9 (the audit table), beat 10 (back to boring), beat 11 (the test suite), and —
only if you are still over — the policy-editing half of beat 3, keeping the registration. Keep beats
1, 2 and 4–8 intact, and keep the SAGE `observe only` hover in beat 2: it is the cheapest twenty
seconds in the film.

---

## Capture notes

- Record the run once, whole. Do not stitch two attempts of the same incident together: the audit
  table on screen will not match the timeline above it, and that is precisely the thing this product
  claims cannot happen.
- If the run halts on a question instead of acting, that is a legitimate second version of the film
  — the halt, the proposal shown exactly, the approve button, and the run picking up where it
  stopped. Do not re-record to avoid it; just decide which film you are making before you start.
- The timeline is server-sent events. If you reload mid-run you lose the on-screen rows (the audit
  table survives, the live timeline does not). Do not touch the page while it is working.
- **Each service has two probes, and they open at different speeds.** The process check opens an
  incident on its first failure; the site check needs two failing sweeps. So one manual sweep after
  stopping Vigil may give you an incident titled *the process is up is failing* with the symptom
  `pm2 says "stopped"` — which is true, and gives the answer away before the investigation starts.
  Run the sweep twice, about half a minute apart, and hand over the *the site answers* incident:
  its symptom line is `expected 200, got 502`, which is what the script above reads out.
- The model's wording changes between runs. Every SAY line above describes the *shape* of what
  appears, not its exact text — read the screen you got, and if the diagnosis is short and certain,
  drop the "allowed to be unsure out loud" sentence rather than talking over a screen that does not
  show it.
- Never show `.env`, the ssh key path, the browser's other tabs, or the terminal's scrollback.
