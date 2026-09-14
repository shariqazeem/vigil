import Link from "next/link";
import { ArrowRight, Bell, Check, Eye, Globe, Hand, Lock, RotateCcw, Search, ShieldCheck, Webhook } from "lucide-react";
import { LandingNav } from "@/components/landing-nav";
import { FleetPulse, type PulseLine, type PulseService } from "@/components/fleet-pulse";
import { CountUp } from "@/components/count-up";
import { opWord, riskWord } from "@/lib/words";
import { tickerLines } from "@/components/ticker-lines";
import { allServices, listIncidents, listProbes, openIncidents, policyOf, readingsFor } from "@/lib/db/warden";
import { POSTURE_WORDS, posture } from "@/lib/ops/policy";
import { catalogue } from "@/lib/ops/operations";
import { stanceOf } from "@/lib/ops/local";
import "./landing.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Warden — an autonomous operator for software that is already running",
  description:
    "When your app goes down, Warden works out why, brings it back the way you allowed, checks it is really back, and tells you. You hear from it only when the decision is yours.",
  alternates: { canonical: "/" },
};

/**
 * THE FRONT DOOR.
 *
 * One arc, five scenes: what it is, what it does about it, the two boundaries it is built on,
 * that it is real, and where to start. Every number here comes from the live fleet — the same
 * rows the console renders — because a landing page for a product about honest evidence cannot
 * open on a figure somebody typed.
 */
export default async function Landing() {
  const demo = allServices().filter((s) => s.ownerKey === "demo");
  const incidents = demo.flatMap((s) => listIncidents(s.id, 200));
  const fixed = incidents.filter((i) => i.status === "resolved");
  const looks = demo.reduce((n, s) => n + listProbes(s.id).reduce((m, p) => m + readingsFor(p.id, 400).length, 0), 0);
  const medianDown = median(fixed.map((i) => i.downSeconds ?? 0).filter(Boolean));
  const ops = catalogue();
  const lines: PulseLine[] = tickerLines();

  return (
    <div className="lx">
      <LandingNav />

      <main>
        {/* ── 1. what it is ───────────────────────────────────────── */}
        <section className="lx-hero">
          <div className="lx-wrap lx-hero-in">
            <div className="lx-hero-copy">
              <span className="eyebrow lx-rise lx-rise-1">
                <i aria-hidden />
                Watching {demo.length} real services right now
              </span>
              <h1 className="display lx-rise lx-rise-2">
                Your software should not need you awake
                <br />
                <span className="soft">to keep running.</span>
              </h1>
              <p className="lede lx-rise lx-rise-3">
                When your app goes down, Warden works out why, brings it back the way you allowed, checks it is really back, and
                tells you. You hear from it only when the decision is yours.
              </p>
              <div className="lx-actions lx-rise lx-rise-4">
                <Link href="/start" className="btn btn-accent btn-lg">
                  Start watching something <ArrowRight size={17} strokeWidth={2.2} />
                </Link>
                <Link href="/fleet" className="btn btn-quiet btn-lg">Break it and watch</Link>
              </div>
              <div className="lx-hero-stat lx-rise lx-rise-4">
                <Stat v={<CountUp value={looks} />} k="checks run" />
                <Stat v={<CountUp value={incidents.length} />} k={`problem${incidents.length === 1 ? "" : "s"}`} />
                <Stat v={<CountUp value={fixed.length} />} k="closed without waking anyone" />
                {medianDown ? <Stat v={fmt(medianDown)} k="median time down" /> : null}
              </div>
            </div>

            <FleetPulse services={pulse(demo)} initial={lines} />
          </div>
        </section>

        {/* ── 1b. all it needs ────────────────────────────────────── */}
        <section className="lx-scene" id="needs">
          <div className="lx-wrap">
            <div className="lx-head">
              <span className="eyebrow"><i aria-hidden />All it needs</span>
              <h2 className="h2">A URL, your deploy hook, and where to reach you.</h2>
            </div>
            <div className="lx-needs">
              <Need icon={<Globe size={18} strokeWidth={2} />} title="A URL">
                Warden loads it on a clock. Two failures in a row open a problem; one blip does not.
              </Need>
              <Need icon={<Webhook size={18} strokeWidth={2} />} title="A deploy hook">
                Render, Railway, Vercel and Coolify each give you a URL that redeploys the app when POSTed. Warden calls it when
                your rules allow, and only then.
              </Need>
              <Need icon={<Bell size={18} strokeWidth={2} />} title="Where to reach you">
                A Slack or Discord webhook. You hear when something breaks and when Warden stops to ask. Nothing else.
              </Need>
            </div>
          </div>
        </section>

        {/* ── 2. what it does about it ────────────────────────────── */}
        <section className="lx-scene" id="how">
          <div className="lx-wrap">
            <div className="lx-head">
              <span className="eyebrow"><i aria-hidden />The twenty minutes after the alert</span>
              <h2 className="h2">The work is mechanical. That is why it is worth automating — and why it is frightening.</h2>
              <p className="lede">
                At 3am, from a phone, a person does the same four things in the same order. An agent with a shell on your
                production box is a worse problem than the outage, so Warden has no shell: it picks one action by name from a
                fixed list of {ops.length}, the arguments are validated, and it is spawned without a shell.
              </p>
            </div>

            <ol className="lx-steps">
              <Step n="01" icon={<Search size={17} strokeWidth={2} />} title="It looks">
                The process table, the logs, what landed recently, the diff of the one commit that looks relevant. Ten looks, and
                an investigation that keeps reading is avoiding a conclusion.
              </Step>
              <Step n="02" icon={<Eye size={17} strokeWidth={2} />} title="It commits to a cause">
                In plain words, quoting what it actually read, with a number for how sure it is. Under fifty per cent it does not
                get to act at all.
              </Step>
              <Step n="03" icon={<Hand size={17} strokeWidth={2} />} title="Your rules decide">
                Not the agent. A pure function reads the rules you wrote for that service and answers with the one that decided:
                do it, refuse it, or stop the run and ask you.
              </Step>
              <Step n="04" icon={<Check size={17} strokeWidth={2} />} title="The check decides whether it worked">
                Warden re-runs the exact check that failed. A clean reading closes the problem and its id is stored as the proof.
                Warden never gets to say it fixed something.
              </Step>
            </ol>
          </div>
        </section>

        {/* ── 3. the two boundaries ───────────────────────────────── */}
        <section className="lx-scene" id="boundaries">
          <div className="lx-wrap">
            <div className="lx-head">
              <span className="eyebrow"><i aria-hidden />What it may do, and how it proves it</span>
              <h2 className="h2">Give it permission to act. Not permission to do anything.</h2>
              <p className="lede">
                Two boundaries, both in code, neither of which the model can move. Everything else about this product is downstream
                of them.
              </p>
            </div>

            <div className="lx-bounds">
              <article className="lx-bound">
                <h3 className="h3"><Lock size={18} strokeWidth={2} style={{ verticalAlign: "-3px", marginRight: 8, color: "var(--accent)" }} />Your rules decide whether an act happens</h3>
                <p>
                  One set per service, written by a human, action by action. <b>May</b> — it does it and tells you afterwards.
                  <b> Ask</b> — it works out exactly what it would do, then stops the run and waits, however long that takes.
                  <b> Never</b> — refused, with the rule that refused it named. Plus a cap per problem and a cooldown per service,
                  because a granted permission is not an unbounded one.
                </p>
                <pre className="well">{`decide(op, policy, ctx) → { verdict, rule, reason }
// pure. no clock, no model, no network.`}</pre>
              </article>

              <article className="lx-bound">
                <h3 className="h3"><ShieldCheck size={18} strokeWidth={2} style={{ verticalAlign: "-3px", marginRight: 8, color: "var(--accent)" }} />The check decides whether it worked</h3>
                <p>
                  A problem is closed by one thing and it is not the agent&rsquo;s opinion: the same check that opened it, run
                  again, in code. The reading&rsquo;s id is stored on the problem. If it comes back failing, the problem says
                  <i> &ldquo;Warden acted, but the check still fails&rdquo;</i> — and you are woken.
                </p>
                <pre className="well">{`resolveIncident(id, reading, resolution)
// verifiedByReadingId — the proof, not a claim.`}</pre>
              </article>
            </div>

            <div className="lx-policy">
              {ops
                .filter((o) => ["pm2_restart", "redeploy_previous", "tls_expiry", "delete_data", "destroy_infra"].includes(o.name))
                .map((o) => (
                  <div key={o.name} className={`lx-prow ${o.risk === "forbidden" ? "locked" : ""}`}>
                    <span className="lx-pop">{opWord(o.name)}</span>
                    <span className="lx-pd">{o.does}</span>
                    <span className={`chip ${o.risk === "forbidden" ? "is-down" : o.risk === "disruptive" ? "is-warn" : o.risk === "read" ? "is-unknown" : "is-accent"}`}>
                      {riskWord(o.risk)}
                    </span>
                  </div>
                ))}
            </div>
            <p className="lede" style={{ marginTop: "var(--s-4)", fontSize: "var(--fs-small)" }}>
              Four of the {ops.length} are declared <b>forbidden</b> rather than left out — migrating a database, deleting data,
              rotating a secret, destroying infrastructure — so the product can show you the line. No rule can turn them on.{" "}
              <Link href="/fleet" style={{ color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: 2 }}>See all {ops.length} against a real set of rules →</Link>
            </p>
          </div>
        </section>

        {/* ── 4. it is real ───────────────────────────────────────── */}
        <section className="lx-scene">
          <div className="lx-wrap">
            <div className="lx-head">
              <span className="eyebrow"><i aria-hidden />Not a recording</span>
              <h2 className="h2">There is a button on the board that really stops a real service.</h2>
              <p className="lede">
                A working operator has a boring board, which is a genuine presentation problem, and the honest answer to it is a
                real outage rather than a video. Press it and Warden&rsquo;s own checks notice, a problem opens, and you land on
                it with the run already streaming.
              </p>
            </div>

            <div className="lx-proof">
              <div className="lx-pf"><span className="lx-pf-v"><CountUp value={fixed.length} /></span><span className="lx-pf-k">problems closed without waking anyone</span></div>
              <div className="lx-pf"><span className="lx-pf-v">{medianDown ? fmt(medianDown) : "—"}</span><span className="lx-pf-k">median time a service was down</span></div>
              <div className="lx-pf"><span className="lx-pf-v"><CountUp value={looks} /></span><span className="lx-pf-k">checks written down, including the boring ones</span></div>
              <div className="lx-pf"><span className="lx-pf-v">327</span><span className="lx-pf-k">tests, offline — no network, no model, no API key</span></div>
            </div>

            <blockquote className="lx-quote">
              <p>
                &ldquo;vigil is down because the process is stopped … the error log is empty and stdout shows only clean startup
                banners. <b>So I cannot name the trigger of the stop from logs alone — it was silent.</b> … A restart is the right
                next act; if it dies again immediately with no logged error, look at commits 6fad866 and 503accd — they bracket
                when this started getting unhealthy.&rdquo;
              </p>
              <cite>a real diagnosis, from the audit table · the rules allowed a restart · the check came back 200 in 207ms · down 60s</cite>
            </blockquote>
          </div>
        </section>

        {/* ── 5. close ────────────────────────────────────────────── */}
        <section className="lx-close">
          <div className="lx-wrap lx-close-in">
            <h2 className="display">A URL is the whole sign-up.</h2>
            <p className="lede">
              No account, no email, nothing to install. Give Warden something you have running and it starts checking. Tell it the
              machine as well and it can read the logs, the process table and the last few commits when that URL stops answering —
              and, if you let it, put the thing back up and prove it.
            </p>
            <div className="lx-actions">
              <Link href="/start" className="btn btn-accent btn-lg">
                Start watching something <ArrowRight size={17} strokeWidth={2.2} />
              </Link>
              <Link href="/fleet" className="btn btn-lg lx-close-ghost">
                <RotateCcw size={16} strokeWidth={2} /> Watch it work first
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="lx-foot">
        <div className="lx-wrap lx-foot-in">
          <div>
            <Link href="/" className="lx-brand"><span className="lx-mark" aria-hidden />Warden</Link>
            <p className="lx-foot-tag">
              An autonomous operator for software that is already running. It has no shell, your rules are code, and it proves
              every fix with the check that failed.
            </p>
          </div>
          <nav className="lx-fc"><h4>Product</h4>
            <Link href="/start">Start watching</Link>
            <Link href="/fleet">The live fleet</Link>
            <Link href="/activity">Everything it has run</Link>
            <Link href="/settings">Where it reaches you</Link>
          </nav>
          <nav className="lx-fc"><h4>How it works</h4>
            <a href="#how">The four steps</a>
            <a href="#boundaries">What it may do</a>
            <a href="https://github.com/shariqazeem/warden#the-console" rel="noreferrer">The console</a>
            <a href="https://github.com/shariqazeem/warden#what-is-honest-about-this" rel="noreferrer">What is honest about this</a>
          </nav>
          <nav className="lx-fc"><h4>Source</h4>
            <a href="https://github.com/shariqazeem/warden" rel="noreferrer">GitHub</a>
            <a href="https://github.com/shariqazeem/warden/blob/main/docs/architecture.png" rel="noreferrer">Architecture</a>
            <a href="https://github.com/strands-agents" rel="noreferrer">Strands Agents SDK</a>
          </nav>
        </div>
        <div className="lx-foot-base">
          <span>MIT</span>
          <span>·</span>
          <span>Built on the Strands Agents SDK</span>
          <span>·</span>
          <a href="https://github.com/shariqazeem/warden" rel="noreferrer">github.com/shariqazeem/warden</a>
        </div>
      </footer>
    </div>
  );
}

function Stat({ v, k }: { v: React.ReactNode; k: string }) {
  return (
    <div className="lx-hs">
      <span className="lx-hs-v">{v}</span>
      <span className="lx-hs-k">{k}</span>
    </div>
  );
}

function Step({ n, icon, title, children }: { n: string; icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <li className="lx-step">
      <span className="lx-step-n">{n}</span>
      <h3>
        <span style={{ color: "var(--accent)", marginRight: 8, verticalAlign: "-3px", display: "inline-block" }}>{icon}</span>
        {title}
      </h3>
      <p>{children}</p>
    </li>
  );
}

function Need({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <article className="lx-need">
      <span className="lx-need-ic" aria-hidden>{icon}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </article>
  );
}

/** The real fleet, as the panel needs it. Same rows the console renders — nothing here is invented. */
function pulse(demo: ReturnType<typeof allServices>): PulseService[] {
  return demo.map((s) => {
    const probes = listProbes(s.id);
    const open = openIncidents(s.id).length;
    const stance = stanceOf(s, POSTURE_WORDS[posture(policyOf(s))]);
    const last = probes[0] ? readingsFor(probes[0].id, 1)[0] : null;
    const hist = probes[0] ? readingsFor(probes[0].id, 26) : [];
    return {
      id: s.id,
      name: s.name,
      open,
      stance: { label: stance.label, tone: stance.tone },
      last: last?.detail ?? "never looked",
      lastAt: last?.at ?? null,
      spark: hist.slice().reverse().map((r) => ({ id: String(r.id), ok: r.ok })),
    };
  });
}

const fmt = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
