# Agents for Humans: nobody is checking the dresser in your child's room

I spent the last stretch of the AWS "Agents for Humans" hackathon building an agent called Vigil. It
watches the physical objects in a house — the car, the cot, the dresser, the baby monitor, what is in
the medicine drawer — against live US federal safety data, and wakes you only when one of them
becomes dangerous.

This post is why that is a real problem, and why it needs an agent rather than an app. The second
post is how it is built on the Strands Agents SDK. The third is the four things that broke.

## The notice goes to the wrong house

A recall notice is posted to the address the manufacturer had when the product was new.

That is the whole problem, stated completely. It is not where you live. It was never where you lived
if you bought the thing second-hand, or if it was handed down, or if it came from a liquidator, or if
you moved. The manufacturer's owner list is a list of first purchasers who filled in a card, and the
recall system is built on top of it.

The numbers that follow from that are worse than most people expect:

- Roughly **nine in ten recalled consumer products are never returned, repaired or thrown out**.
- **Car-seat recall completion sits near 30%** — and a car seat is a product people are, by any
  measure, motivated to care about.
- NHTSA issues on the order of **a thousand vehicle recall campaigns a year**, covering tens of
  millions of vehicles.

And underneath those, the part that is structural rather than statistical: second-hand and
hand-me-down goods are **invisible to the entire system**. Nobody registered them, so nobody can be
told. Those are exactly the goods that circulate through neighbourhood networks, through Facebook
groups, through families with the least money and the most need to buy used.

Here is a real example I did not have to hunt for. In May 2026, Walmart recalled Mainstays 9-drawer
fabric dressers — about 165,000 of them, for "Risk of Serious Injury or Death from Tip-Over and
Entrapment". In August 2026, CPSC re-announced the same recall, because Walmart had distributed
recalled dressers *after* the recall, through liquidators, to consumers. Two recall numbers, 26522
and 26726, for the same object. If you bought one from a liquidator, you are on nobody's list at all,
and the notice about it is in somebody else's letterbox.

Nobody is checking on your behalf. Not ever, and not for the four years it might take before the
recall on the thing in your child's room even gets published.

## Why an app cannot do this

The obvious product here is a website with a search box. Those exist. They do not solve the problem,
and the reason is simple: an app is a thing you have to remember to open.

The event you are trying to catch is a recall being published, months or years after you acquired the
object, on a day you have no reason to think about it. To catch that with a search box you would have
to search every product you own, every week, forever. Nobody does that. Nobody should have to.

What that shape actually calls for is something that:

- runs on a schedule with nobody present, for years;
- knows what you own well enough to ask the right question of the right agency;
- can read a four-hundred-word regulatory notice and decide whether it is about *your* unit;
- is trustworthy enough to be silent almost every night;
- and interrupts you exactly once, on the night it matters, with a question you can actually answer.

That is an agent. Not because agents are fashionable this year, but because every one of those
bullets is a thing a cron job plus a `LIKE` query cannot do, and a chat window will not do either.

## What Vigil actually does

**You tell it what is in your house. Once.** A sentence, a photo of a shelf, a VIN typed on a phone.
An intake agent with a forced output schema turns that into things it can watch, and is made to
declare what it could *not* read rather than filling the gap in. If it cannot tell how old the
dresser is, that becomes a recorded unknown, not a guessed year. A VIN is never interpreted by the
model at all — it goes to NHTSA's vPIC decoder and comes back as fact.

**Then it does nothing visible, for months.** A cron runs a pass every six hours over every household
whose last look is older than the gap. Each pass asks four public federal sources about every thing in
the house — NHTSA recalls, NHTSA owner complaints, the CPSC product recall corpus, openFDA enforcement
reports — and records every question it asked: the URL, whether the source answered, the row count,
the latency. A source that times out is recorded as **unchecked**, never as clear. Silence is not
safety, and a watch that quietly treated a timeout as "nothing wrong" would be worse than no watch.

**And when it cannot be sure, it stops.** This is the part I think is actually novel, and it is the
part I would point a judge at first.

## The best thing in the project is a question

Here is a real production pass over the demo household: a 2019 Honda Accord (VIN decoded live by
NHTSA vPIC), a second-hand Mainstays 9-drawer fabric dresser, a Babysense Max View VBM55 baby
monitor, and a bottle of vitafusion melatonin gummies. Four ordinary things.

The pass read **4,336 government records across 6 source calls in 166.6 seconds** and wrote five
findings — among them NHTSA campaign 20V314000, where in NHTSA's own words "the engine can stall
while driving, increasing the risk of a crash" across 135,995 vehicles, and CPSC 26307, where the
Babysense display unit "can overheat and/or spark when charging" across about 81,800 units.

Then it halted, with this:

> **On the label under the dresser's top panel, is the Tracking/Lot manufacture date in MM/YYYY
> between 09/2023 and 12/2025?**

The CPSC record says the dressers were "manufactured from September 2023 through December 2025" and
that "the Tracking/Lot and the manufacture date in MM/YYYY format are printed on a label under the
dresser's top panel". The household's dresser came from the owner's sister. There is no receipt, no
serial number, no owner record anywhere.

So there is genuinely no way to know whether this dresser is one of the recalled ones — except by
having a person walk into the room and look under the top panel.

The agent could have guessed either way. Guessing "yes" produces a false alarm and burns the one
piece of attention this product will ever get. Guessing "no" leaves a dresser that may tip over onto
a child in that child's bedroom, with a green tick next to it. Those errors are not symmetric and
they are both wrong.

So it stops. Not a UI state — the run genuinely halts, `stopReason: interrupt`, the state is written
to the database, and it stays halted across process restarts until somebody taps one of three
buttons. The scheduled sweep skips a household that is waiting on an answer, because the question
*is* the work. And what the person answers is kept in their own words as a standing rule, so it is
never asked twice.

"I cannot tell, and here is the one thing that would settle it" may be the most undervalued output an
agent can produce. Everything pushes toward producing an answer. In a safety product an honest halt
is worth more than a confident one — and it has to be made of real machinery, persisted state and a
resumable run, rather than a hedge in the prose.

## Who it is for

Anyone with a child, a car, or a second-hand anything. It is aimed hardest at the people the recall
system already fails: families who bought used, and the person running a home daycare with eleven
cots and four car seats that nobody ever registered.

It is live at **https://vigil.80.225.209.190.sslip.io** and needs nothing from you — no sign-up, no
key. Every finding on the demo house is a real government record you can look up yourself. The source
is MIT at **https://github.com/shariqazeem/vigil**.

Next post: the Strands Agents SDK underneath it — the graph with conditional edges, the tool-raised
interrupt and its resume, hooks as enforcement rather than instruction, and the completeness-gate
pattern that turned out to matter more than any of them.
