import Link from "next/link";
import { listHouseholds, listThings } from "@/lib/db/vigil";
import { nhtsaRecallsByVehicle, nhtsaUnitsAffected } from "@/lib/sources";
import { Reveal } from "@/components/reveal";
import "./home.css";

export const dynamic = "force-dynamic";

/**
 * The front door.
 *
 * The rule this page is built on: every claim gets its own artifact, and the artifact is real. The
 * recall below is not a mock-up — it is fetched from api.nhtsa.gov when the page renders, with the
 * endpoint and latency printed beside it. If NHTSA is down the card says so rather than showing a
 * picture of a recall nobody looked up.
 */
export default async function Home() {
  const demo = listHouseholds("demo")[0] ?? null;
  const demoThings = demo ? listThings(demo.id).length : 0;

  const res = await nhtsaRecallsByVehicle({ make: "honda", model: "accord", modelYear: 2019 });
  const campaign = res.rows.find((r) => r.campaignNumber === "20V314000") ?? res.rows[0] ?? null;
  const units = campaign ? await nhtsaUnitsAffected(campaign.campaignNumber) : null;

  return (
    <main className="hm">
      <div className="hm-lamp" aria-hidden="true" />

      <nav className="hm-nav">
        <p className="hm-brand mono">vigil</p>
        <div className="hm-nav-r">
          {demo ? (
            <Link href={`/h/${demo.id}`} className="hm-nav-l">
              See a real house
            </Link>
          ) : null}
          <Link href="/new" className="btn">
            Start a watch
          </Link>
        </div>
      </nav>

      <header className="hm-hero">
        <p className="hm-eyebrow mono">an autonomous agent · built on the Strands Agents SDK</p>
        <h1 className="hm-h1 serif">
          Nobody is checking
          <br />
          on your behalf.
        </h1>
        <p className="hm-lede">
          A recall notice is posted to the address the manufacturer had when the thing was new. Which is not where you live — and
          never was, if you bought it second-hand. So nine out of ten recalled products are never returned, and the notice about the
          cot in your child&rsquo;s room arrives at somebody else&rsquo;s house.
        </p>
        <p className="hm-lede hm-lede-2">
          Tell Vigil what is in your home. It checks every one of those things against live federal safety data, night after night,
          for as long as you own them — and it only wakes you when one of them becomes dangerous.
        </p>
        <div className="hm-cta">
          <Link href="/new" className="btn">
            Tell it what&rsquo;s in your home
          </Link>
          {demo ? (
            <Link href={`/h/${demo.id}`} className="btn btn-quiet">
              Watch it work on a real house
            </Link>
          ) : null}
        </div>
        {demo ? (
          <p className="hm-note mono">
            no sign-up · that house is {demoThings} ordinary things, and every finding on it is a real government record
          </p>
        ) : null}
      </header>

      <Reveal className="hm-proof">
        <div className="hm-proof-head">
          <p className="hm-k mono">this is not an example</p>
          <h2 className="hm-h2">One of the open recalls on a 2019 Honda Accord, read from NHTSA while this page loaded.</h2>
        </div>
        {campaign ? (
          <article className="hm-card">
            <header className="hm-card-h">
              <p className="hm-card-id mono">{campaign.campaignNumber}</p>
              <p className="hm-card-agency mono">NHTSA · reported {campaign.reportReceivedDate}</p>
            </header>
            <h3 className="serif hm-card-t">{campaign.component}</h3>
            <blockquote className="hm-card-q">
              <p>{campaign.consequence}</p>
              <cite className="mono">— {campaign.manufacturer}, verbatim</cite>
            </blockquote>
            {units?.units ? (
              <p className="hm-card-units">
                <span className="mono">{units.units.toLocaleString()}</span> vehicles affected
              </p>
            ) : null}
            <p className="hm-card-src mono">
              GET {res.endpoint} → {res.rowCount} rows · {res.latencyMs}ms
            </p>
          </article>
        ) : (
          <article className="hm-card is-down">
            <p>
              NHTSA did not answer when this page loaded{res.error ? `: ${res.error}` : ""}. That is what an unanswered source looks
              like here — Vigil says so rather than showing you a recall nobody read.
            </p>
            <p className="hm-card-src mono">GET {res.endpoint}</p>
          </article>
        )}
        <p className="hm-proof-foot">
          Every word Vigil shows you about a hazard is lifted from a record like this one, with the record number beside it. It does
          not summarise, and it does not write hazards of its own.
        </p>
      </Reveal>

      <section className="hm-how">
        <Reveal className="hm-step">
          <p className="hm-n mono">01</p>
          <div className="hm-say">
          <h3 className="hm-h3">You tell it what is in your house. Once.</h3>
          <p>
            A sentence, a photo of a shelf, a VIN typed on a phone. A Strands agent with a forced schema turns it into things, and is
            made to declare what it could <em>not</em> read rather than filling the gap in. A VIN is never interpreted by the model —
            it goes to NHTSA&rsquo;s own decoder and comes back as fact.
          </p>
          </div>
          <pre className="hm-pre mono">{`{ label: "The dresser in Ayesha's room",
  make: "Mainstays", model: "9-Drawer Fabric Dresser",
  category: "clothing storage unit", secondHand: true,
  confidence: 0.8,
  unknowns: ["the manufacture date label under the
              top panel has not been checked"] }`}</pre>
        </Reveal>

        <Reveal className="hm-step">
          <p className="hm-n mono">02</p>
          <div className="hm-say">
          <h3 className="hm-h3">Then it does nothing visible, for months.</h3>
          <p>
            On a schedule, with nobody watching, it asks four public federal sources about every thing you own. Every question is
            recorded with the URL it used, whether the source answered, and how many rows came back — because &ldquo;we looked and it
            was quiet&rdquo; is the answer nearly every night, and it has to be provable.
          </p>
          <p className="hm-small">
            A source that times out is marked <strong>unchecked</strong>, never clear. Silence is not safety.
          </p>
          </div>
          <pre className="hm-pre mono">{`GET api.nhtsa.gov/recalls/recallsByVehicle?make=HONDA…       6 rows
GET api.nhtsa.gov/complaints/complaintsByVehicle?make=…   682 rows
GET saferproducts.gov/RestWebServices/Recall?format=…   1,483 rows
GET api.fda.gov/food/enforcement.json?search=…             10 rows`}</pre>
        </Reveal>

        <Reveal className="hm-step">
          <p className="hm-n mono">03</p>
          <div className="hm-say">
          <h3 className="hm-h3">And when it cannot be sure, it stops.</h3>
          <p>
            A recall names a model range and a manufacture window, not your serial number. When Vigil cannot tell whether a record
            covers <em>your</em> unit, it does not guess in either direction: the run genuinely halts — a Strands interrupt,{" "}
            <span className="mono">stopReason: interrupt</span> — and stays halted, in the database, until a human answers. What you
            say is kept in your words, so it never asks twice.
          </p>
          </div>
          <div className="hm-halt">
            <p className="hm-halt-pill mono">stopReason: interrupt</p>
            <p className="serif hm-halt-q">What is the manufacture date printed on the label under the dresser&rsquo;s top panel?</p>
            <p className="hm-halt-sub">The run is stopped here. It stays stopped until you answer.</p>
          </div>
        </Reveal>
      </section>

      <Reveal className="hm-rules">
        <h2 className="hm-h2">Six things it is not allowed to do</h2>
        <p className="hm-rules-lede">
          Not asked nicely in a prompt. Refused in code on the way to the tool, and tested by pushing a deliberately jailbroken model
          output through the real path and asserting that nothing reaches your screen.
        </p>
        <ul className="hm-rule-list">
          <li>
            <b>Invent a record.</b> A finding can only be built from a row that came back from a real request during that watch.
          </li>
          <li>
            <b>Alarm you on a hunch.</b> Below 60% sure it may not say a thing is recalled. It has to ask.
          </li>
          <li>
            <b>Clear something it recognises.</b> When a record names your brand <em>and</em> your object, &ldquo;not yours&rdquo; is
            refused. A false alarm wastes five minutes; a false all-clear leaves it in the room.
          </li>
          <li>
            <b>Claim a unit it cannot identify.</b> If the record is scoped to a date code or serial range nobody has checked, it must
            ask rather than assume.
          </li>
          <li>
            <b>Escalate a tone.</b> &ldquo;Serious injury or death&rdquo; is allowed only when the record itself says so.
          </li>
          <li>
            <b>Speak to anyone but you.</b> Telling the other parents, filing to an agency — it can prepare them, never send them.
          </li>
        </ul>
      </Reveal>

      <Reveal className="hm-built">
        <h2 className="hm-h2">How it is built</h2>
        <div className="hm-built-grid">
          <div>
            <p className="hm-k mono">the agents</p>
            <p>
              A Strands <b>Graph</b>: triage decides which agency could possibly know about each thing, three lanes ask them in
              parallel, and a conditional edge routes whatever came back to a match agent — the one genuinely hard judgement here,
              because recall prose describes a production run, not your unit.
            </p>
          </div>
          <div>
            <p className="hm-k mono">the stopping</p>
            <p>
              A tool-raised <b>interrupt</b>, persisted with the run&rsquo;s state and resumable hours later from a different process.
              The brief&rsquo;s own sentence — surfaces only when there is a real decision — as an SDK primitive rather than a claim.
            </p>
          </div>
          <div>
            <p className="hm-k mono">the guarantees</p>
            <p>
              Hooks and interventions refuse the six rules above. After the graph, code compares what the agent <em>planned</em> to
              check against what it actually asked, and asks the rest itself. The agent chooses how to look; the code guarantees that
              it looked.
            </p>
          </div>
          <div>
            <p className="hm-k mono">the sources</p>
            <p>
              NHTSA recalls and owner complaints, CPSC consumer-product recalls, openFDA enforcement reports. All public, all keyless,
              all printed on screen with the URL that fetched them.
            </p>
          </div>
        </div>
      </Reveal>

      <footer className="hm-foot">
        <p className="serif hm-foot-line">It watches your things so you don&rsquo;t have to remember to.</p>
        <div className="hm-cta">
          <Link href="/new" className="btn">
            Start a watch
          </Link>
          {demo ? (
            <Link href={`/h/${demo.id}`} className="btn btn-quiet">
              See a real house
            </Link>
          ) : null}
        </div>
        <p className="hm-foot-fine mono">
          <a href="https://github.com/shariqazeem/vigil" rel="noreferrer">
            source
          </a>{" "}
          · MIT · data from NHTSA, CPSC and the FDA · not affiliated with any of them
        </p>
      </footer>
    </main>
  );
}
