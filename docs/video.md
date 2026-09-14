# Vigil — demo video script

Screen recording with voiceover. **Hard cap 5:00** (AWS "Agents for Humans" allows up to 5 minutes).
A **2:45 cut** is marked below: it ends on the halt and is the version to use anywhere a shorter
video is wanted.

Everything on screen is the real product against real federal APIs. Nothing is mocked, and nothing is
sped up except where a beat says so out loud.

---

## Before you record

- [ ] Production is up: `curl -o /dev/null -w "%{http_code}\n" https://vigil.80.225.209.190.sslip.io`
      → `200`. Same for `/new` and the demo board.
- [ ] The demo house is **halted on the dresser question** — the board shows
      `stopReason: interrupt` and the buttons Yes / No / I can't tell. If someone has already
      answered it, run a fresh pass (`Watch now`) or re-seed before recording. **The halt is the
      film.** Do not record without it.
- [ ] The demo house has its five findings and the four things, and the pass link
      ("See everything the last watch asked") resolves.
- [ ] `npx vitest run` is green locally (108 passed, 6 skipped) if you want the test beat as B-roll.
- [ ] Terminal ready in a second window: large font, dark theme, one line of history, `jq` installed.
- [ ] Browser: 1512×945, dark colour scheme, no bookmarks bar, no extensions, no other tabs.
- [ ] Phone on silent. Notifications off. Do a full dry run once before the take.

**Capture help.** `node scripts/shoot.mjs --only board` drives the real board with Playwright
(borrowed from a sibling checkout via `PLAYWRIGHT_FROM`) and records `var/shots/board.webm` plus a
still. The other scenes are `--only landing`, `--only drop`, `--only replay`, `--only watch` and
`--only pass`; `--base https://vigil.80.225.209.190.sslip.io` points them at production, and
`--house hh_…` picks the household.

For beats 4 and 5 use **`--only replay`**: it plays a recorded pass back at its own pace — the lamp
travels, the endpoint log ticks, nodes resolve with their real row counts, and the field freezes on
the real question — and the board labels it a replay on screen throughout. `--only watch` runs a
genuinely new pass and deliberately refuses to start on a household that is halted on a question,
which the demo house is. Either is honest; the replay is free and does not consume the halt.

```bash
ffmpeg -i var/shots/board.webm -c:v libx264 -crf 18 -pix_fmt yuv420p var/shots/board.mp4
```

Use the shoot for the long, unglamorous takes. Record the cuts you need to talk over by hand, so the
voice and the motion land together.

---

## Beat sheet

### 1 — The problem (0:00 – 0:24)

**DO** — Open on the landing page, already loaded, at the top. Hold still for two seconds on the
headline "Nobody is checking on your behalf." Then scroll slowly, one screen, to the lede.

**SAY**

> A recall notice goes to the address the manufacturer had when the thing was new. That is not where
> you live. And it never was, if you bought it second-hand.
>
> So nine out of ten recalled products are never returned. The notice about the dresser in your
> child's room arrives at somebody else's house.

---

### 2 — It is real data, and that is the point (0:24 – 0:50)

**DO** — Scroll to the recall card on the landing page. Let it sit. Move the cursor to the small
mono line underneath — `GET api.nhtsa.gov/recalls/recallsByVehicle… → 6 rows · Nms` — and rest there
for a beat. Then highlight the campaign number `20V314000` and the quoted consequence.

**SAY**

> This card is not an illustration. It was fetched from NHTSA while this page loaded, and the URL and
> the latency are printed underneath it.
>
> Campaign 20V314000. In NHTSA's own words: if the fuel pump fails, the engine can stall while
> driving, increasing the risk of a crash. A hundred and thirty-five thousand, nine hundred and
> ninety-five vehicles.
>
> Everything Vigil ever shows you about a hazard is lifted from a record like this one, with the
> record number beside it. It does not summarise, and it does not write hazards of its own.

---

### 3 — Who it is for, and telling it what you own (0:50 – 1:22)

**DO** — Click **Tell it what's in your home**. On `/new`, type the household name, then type the
drop line by line at a human speed:

```
We've got a 2019 Honda Accord.
Ayesha's room has a Mainstays 9-drawer fabric dresser — my sister gave it to us, so I don't know how old it is.
There's a Babysense Max View VBM55 baby monitor next to the cot.
And vitafusion melatonin gummies in the kitchen drawer.
```

Pause on the finished textarea.

**SAY**

> This is for anyone with a child, a car, or a second-hand anything. It is aimed hardest at the
> people the recall system already fails — families who bought used, and the person running a home
> daycare with eleven cots that nobody ever registered.
>
> You tell it what is in the house once. A sentence, a photo of a shelf, a VIN typed on a phone.
>
> An intake agent turns that into things it can watch — and it is forced by its schema to declare
> what it could not read, rather than filling the gap in. It does not know how old that dresser is,
> so it writes that down as an unknown instead of guessing. A VIN is never interpreted by the model
> at all: it goes to NHTSA's own decoder and comes back as fact.

---

### 4 — The watch running (1:22 – 2:06)

**DO** — Cut to the demo house board, mid-watch. Stay on the field. The lamp travels between the four
things; rings sweep as answers land; the endpoint log at the bottom ticks:

```
GET api.nhtsa.gov/recalls/recallsByVehicle · 2019 HONDA Accord
200 nhtsa-recalls → 6 rows · 1ms
GET saferproducts.gov/RestWebServices/Recall · since 2023-01-01
200 cpsc-recalls → 1483 rows · 39ms
```

Let it run. Do not cut away every two seconds — the point is that it is genuinely working.

If you are recording the **replay** rather than a live pass, the status bar reads "Playing back a
watch that already happened". Leave it visible and say so in one clause — "this is a recording of a
real pass, played back at its own pace" — rather than cropping it out. The events, the row counts and
the timings are the real ones either way, and a video that hides the label is a video that made a
claim the product refuses to make.

**SAY**

> Then it does nothing visible, for months. On a cron, at three in the morning, with nobody present.
>
> What you are watching is the real thing. The lamp is on that object because an HTTP request to a
> federal API just went out for it. The row counts are what came back. Nothing here is on a timer.
>
> One pass, four things, four federal sources: NHTSA recalls, NHTSA owner complaints, the CPSC
> product recall corpus, and openFDA enforcement. Four thousand three hundred and thirty-six
> government records, in under three minutes.
>
> And every single question is written down first — the URL, whether the source answered, the row
> count, the latency — before the agent sees a single row. A source that times out is recorded as
> unchecked. Never as clear. Silence is not safety.

---

### 5 — A node goes red (2:06 – 2:26)

**DO** — The car node turns red and stamps `20V314000` on itself. Hold on it. Then the baby monitor
node turns red and stamps `26307`.

**SAY**

> There. The car. That stamp is a campaign number, and that number is why you can check this
> yourself.
>
> And the baby monitor — CPSC 26307. The display unit can overheat and spark while charging. Eighty-
> one thousand eight hundred units.

---

### 6 — It stops (2:26 – 2:52)

**DO** — The field freezes. The scrim comes down. The pill reads `stopReason: interrupt` and the
question appears:

> On the label under the dresser's top panel, is the Tracking/Lot manufacture date in MM/YYYY
> between 09/2023 and 12/2025?

Hold on it for a full four seconds without speaking. Then scroll one notch to show the record below
it and the three buttons.

**SAY**

> And then it stops.
>
> *(silence — 4s)*
>
> That dresser came from the owner's sister. No receipt, no owner record, nothing. The CPSC recall
> covers units manufactured between September 2023 and December 2025 — risk of serious injury or
> death from tip-over and entrapment — and nothing in the world can tell Vigil whether this
> particular dresser is one of them. Except the person standing in the room.
>
> So it asks them. Once. In the record's own words about where the label is.
>
> This is a real halt. `stopReason: interrupt` — a Strands interrupt, raised from inside a tool. The
> run's state is written to the database and it stays stopped. It survives the process. The cron will
> skip this household entirely, because the question *is* the work.

> **▸ 2:45 CUT ENDS HERE.** For the short version, go straight from the end of this beat to the
> closing line in beat 10, and drop beats 7, 8 and 9. Recorded length ≈ 2:44.

---

### 7 — Answering it, and the run continuing (2:52 – 3:18)

**DO** — Type a short note in the box ("Checked it — the label says 11/2024"), then click **Yes**.
The scrim lifts, the field wakes, the adjudicator node lights, and the board refreshes with the
dresser now carrying its own record number.

**SAY**

> You answer it with one tap. The same run picks up where it stopped — the interrupt response goes
> back into the same conversation, which has been sitting on disk since it halted, possibly on a
> different day and certainly in a different process.
>
> And what you said is kept in your words, as a standing rule, so it never asks you that again.

---

### 8 — What it found, in the government's words (3:18 – 4:00)

**DO** — Scroll to **What it found**. Stop on the 20V314000 notice card. Move the cursor across, in
order: the verbatim consequence line and its `— NHTSA, verbatim` attribution; **what to do**; **units
affected 135,995**; **why Vigil says this is yours · 99% sure**; and the `read the record at NHTSA →`
link. Then scroll past the other cards without stopping, so the volume registers.

**SAY**

> This is what it wakes you for.
>
> The hazard, word for word from the record. What to do, including Honda's phone number, because
> that is in the record too. A hundred and thirty-five thousand, nine hundred and ninety-five
> vehicles affected — a number that only exists on NHTSA's campaign endpoint, so Vigil goes and
> fetches it rather than letting a model fill the hole in.
>
> And underneath: why it says this is yours. The record names 2018-2019 Honda Accord. The car is a
> 2019. That is the whole argument, and it is shown to you so you can disagree with it.
>
> A link to the record itself sits on every one.

---

### 9 — The nights, and proving it from a terminal (4:00 – 4:40)

**DO** — Scroll to **The nights**: one mark per watch, with the record count. Hold two seconds.
Then cut to the terminal and run, live:

```bash
curl -s "https://api.nhtsa.gov/recalls/recallsByVehicle?make=honda&model=accord&modelYear=2019" \
  | jq -r '.results[] | .NHTSACampaignNumber'
```

Let the output land. `20V314000` is in it. Optionally point at the board still visible behind, or cut
back to the stamped node for one second.

**SAY**

> One mark per watch. Almost all of them are quiet — that is the job, and it is the reason the other
> night matters. A cron runs this every six hours over every household whose last look is older than
> the gap.
>
> And none of this asks you to trust me. These are public endpoints. No key.
>
> *(run the curl)*
>
> Same campaign number. The one stamped on the car on that board came from this, and every URL the
> agent called is printed on the pass page for you to paste.

---

### 10 — Close (4:40 – 4:58)

**DO** — Cut back to the board, showing the four things quiet in the field. Hold. Fade on the footer
line.

**SAY**

> Built on the Strands Agents SDK. One pass is a Strands graph — triage, three parallel lanes behind
> conditional edges, one match agent. Six safety rules refused in hooks on the tool boundary, not
> asked for in a prompt, and there is a test that jailbreaks the model four ways and proves nothing
> reaches your screen.
>
> It is live, it needs nothing from you, and the source is MIT.
>
> Vigil. It watches your things so you don't have to remember to.

---

## Line-level notes for the take

- Say **"one three five, nine nine five"** as "a hundred and thirty-five thousand, nine hundred and
  ninety-five" — the full number lands harder than "about a hundred and thirty-six thousand", and it
  is the exact figure NHTSA returns.
- The four-second silence in beat 6 is the most important four seconds in the video. Do not fill it.
- Never say "AI-powered", "revolutionary", "seamless", or "leverage". Read it the way you would
  explain it to a friend who asked what you built this week.
- Say `stopReason: interrupt` out loud exactly once, in beat 6. Let the pill on screen do the rest.
- If a federal API is slow during the take, leave it in and say so — "that one took two seconds, and
  that is what is recorded". Honest latency is on-brand; a cut that hides it is not.
- Do not claim the deployed instance runs on Bedrock. If the model is mentioned at all, say "it runs
  on an OpenAI-compatible endpoint today; Bedrock is wired as the router's primary". Safest is not to
  mention it in the video and leave it to the written submission, which says it plainly.
