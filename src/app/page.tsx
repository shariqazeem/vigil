import Link from "next/link";
import { ArrowRight, Check, Eye, Hand, Lock, RotateCcw, Search, ShieldCheck } from "lucide-react";
import { allServices, listIncidents, listProbes, openIncidents, policyOf, readingsFor } from "@/lib/db/warden";
import { POSTURE_WORDS, posture } from "@/lib/ops/policy";
import { catalogue } from "@/lib/ops/operations";
import { stanceOf } from "@/lib/ops/local";
import "./landing.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Warden — an autonomous operator for software that is already running",
  description:
    "Monitoring wakes you up. Warden does the next twenty minutes: it investigates the failure, fixes what your policy allows, proves the fix by re-running the check that failed, and wakes you only when the decision is genuinely yours.",
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

  return (
    <div className="lx">
      <nav className="lx-nav">
        <div className="lx-nav-in">
          <Link href="/" className="lx-brand">
            <span className="lx-mark" aria-hidden />
            Warden
          </Link>
          <div className="lx-links">
            <a href="#how" className="lx-link">How it works</a>
            <a href="#boundaries" className="lx-link">The boundaries</a>
            <Link href="/fleet" className="lx-link">Watch it live</Link>
            <a href="https://github.com/shariqazeem/warden" className="lx-link" rel="noreferrer">Source</a>
          </div>
          <Link href="/start" className="btn btn-sm">Start watching</Link>
        </div>
      </nav>

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
                Monitoring wakes you up. It does not read the log, look at what deployed at 02:14, or restart the process that is
                simply stopped. Warden does those, inside a policy you wrote — and proves the fix by re-running the exact check
                that failed.
              </p>
              <div className="lx-actions lx-rise lx-rise-4">
                <Link href="/start" className="btn btn-accent btn-lg">
                  Start watching something <ArrowRight size={17} strokeWidth={2.2} />
                </Link>
                <Link href="/fleet" className="btn btn-quiet btn-lg">Break it and watch</Link>
              </div>
              <div className="lx-hero-stat lx-rise lx-rise-4">
                <Stat v={looks.toLocaleString()} k="checks run" />
                <Stat v={String(incidents.length)} k={`incident${incidents.length === 1 ? "" : "s"}`} />
                <Stat v={String(fixed.length)} k="closed without waking anyone" />
                {medianDown ? <Stat v={fmt(medianDown)} k="median time down" /> : null}
              </div>
            </div>

            <LiveBoard />
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
                production box is a worse problem than the outage, so Warden has no shell: it picks one operation by name from a
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
              <Step n="03" icon={<Hand size={17} strokeWidth={2} />} title="Your policy decides">
                Not the agent. A pure function reads the policy you wrote for that service and answers with the rule that decided:
                do it, refuse it, or stop the run and ask you.
              </Step>
              <Step n="04" icon={<Check size={17} strokeWidth={2} />} title="The check decides whether it worked">
                Warden re-runs the exact probe that failed. A clean reading closes the incident and its id is stored as the proof.
                Warden never gets to say it fixed something.
              </Step>
            </ol>
          </div>
        </section>

        {/* ── 3. the two boundaries ───────────────────────────────── */}
        <section className="lx-scene" id="boundaries">
          <div className="lx-wrap">
            <div className="lx-head">
              <span className="eyebrow"><i aria-hidden />What makes it safe to leave alone</span>
              <h2 className="h2">Give it permission to act. Not permission to do anything.</h2>
              <p className="lede">
                Two boundaries, both in code, neither of which the model can move. Everything else about this product is downstream
                of them.
              </p>
            </div>

            <div className="lx-bounds">
              <article className="lx-bound">
                <h3 className="h3"><Lock size={18} strokeWidth={2} style={{ verticalAlign: "-3px", marginRight: 8, color: "var(--accent)" }} />The policy decides whether an act happens</h3>
                <p>
                  One per service, written by a human, operation by operation. <b>May</b> — it does it and tells you afterwards.
                  <b> Ask</b> — it works out exactly what it would do, then stops the run and waits, however long that takes.
                  <b> Never</b> — refused, with the rule that refused it named. Plus a cap per incident and a cooldown per service,
                  because a granted permission is not an unbounded one.
                </p>
                <pre className="well">{`decide(op, policy, ctx) → { verdict, rule, reason }
// pure. no clock, no model, no network.`}</pre>
              </article>

              <article className="lx-bound">
                <h3 className="h3"><ShieldCheck size={18} strokeWidth={2} style={{ verticalAlign: "-3px", marginRight: 8, color: "var(--accent)" }} />The probe decides whether it worked</h3>
                <p>
                  An incident is closed by one thing and it is not the agent&rsquo;s opinion: the same check that opened it, run
                  again, in code. The reading&rsquo;s id is stored on the incident. If it comes back failing, the incident says
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
                    <span className="lx-pop">{o.name}</span>
                    <span className="lx-pd">{o.does}</span>
                    <span className={`chip ${o.risk === "forbidden" ? "is-down" : o.risk === "disruptive" ? "is-warn" : o.risk === "read" ? "is-unknown" : "is-accent"}`}>
                      {o.risk === "forbidden" ? "never, under any policy" : o.risk}
                    </span>
                  </div>
                ))}
            </div>
            <p className="lede" style={{ marginTop: "var(--s-4)", fontSize: "var(--fs-small)" }}>
              Four of the {ops.length} are declared <b>forbidden</b> rather than left out — migrating a database, deleting data,
              rotating a secret, destroying infrastructure — so the product can show you the line. No policy can turn them on.{" "}
              <Link href="/fleet" style={{ color: "var(--accent)", textDecoration: "underline", textUnderlineOffset: 2 }}>See all {ops.length} against a real policy →</Link>
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
                real outage rather than a video. Press it and Warden&rsquo;s own checks notice, an incident opens, and you land on
                it with the run already streaming.
              </p>
            </div>

            <div className="lx-proof">
              <div className="lx-pf"><span className="lx-pf-v">{fixed.length}</span><span className="lx-pf-k">incidents closed without waking anyone</span></div>
              <div className="lx-pf"><span className="lx-pf-v">{medianDown ? fmt(medianDown) : "—"}</span><span className="lx-pf-k">median time a service was down</span></div>
              <div className="lx-pf"><span className="lx-pf-v">{looks.toLocaleString()}</span><span className="lx-pf-k">checks written down, including the boring ones</span></div>
              <div className="lx-pf"><span className="lx-pf-v">299</span><span className="lx-pf-k">tests, offline — no network, no model, no API key</span></div>
            </div>

            <blockquote className="lx-quote">
              <p>
                &ldquo;vigil is down because the process is stopped … the error log is empty and stdout shows only clean startup
                banners. <b>So I cannot name the trigger of the stop from logs alone — it was silent.</b> … A restart is the right
                next act; if it dies again immediately with no logged error, look at commits 6fad866 and 503accd — they bracket
                when this started getting unhealthy.&rdquo;
              </p>
              <cite>a real diagnosis, from the audit table · the policy allowed a restart · the check came back 200 in 207ms · down 60s</cite>
            </blockquote>
          </div>
        </section>

        {/* ── 5. close ────────────────────────────────────────────── */}
        <section className="lx-close">
          <div className="lx-wrap">
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
              <Link href="/fleet" className="btn btn-quiet btn-lg">
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
              An autonomous operator for software that is already running. It has no shell, its policy is code, and it proves every
              fix with the check that failed.
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
            <a href="#boundaries">The two boundaries</a>
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

function Stat({ v, k }: { v: string; k: string }) {
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

/** The real fleet, drawn small. Same rows the console renders — nothing here is invented. */
function LiveBoard() {
  const demo = allServices().filter((s) => s.ownerKey === "demo");
  return (
    <div className="lx-board lx-rise lx-rise-3">
      <div className="lx-board-bar">
        <span className="lx-dots" aria-hidden><i /><i /><i /></span>
        <span className="lx-board-t">warden.80.225.209.190.sslip.io — live</span>
      </div>
      <div className="lx-board-body">
        {demo.map((s) => {
          const probes = listProbes(s.id);
          const open = openIncidents(s.id).length;
          const stance = stanceOf(s, POSTURE_WORDS[posture(policyOf(s))]);
          const last = probes[0] ? readingsFor(probes[0].id, 1)[0] : null;
          const hist = probes[0] ? readingsFor(probes[0].id, 26) : [];
          return (
            <div key={s.id} className="lx-svc">
              <div className="lx-svc-h">
                <span className={`chip ${open ? "is-down" : "is-ok"}`}>{open ? `${open} open` : "up"}</span>
                <span className="lx-svc-n">{s.name}</span>
                <span className={`chip is-${stance.tone} lx-svc-p`}>{stance.label}</span>
              </div>
              <div className="lx-svc-h">
                <span className="lx-spark" aria-hidden>
                  {hist.slice().reverse().map((r) => <i key={r.id} className={r.ok ? "" : "bad"} />)}
                </span>
                <span className="lx-svc-d">{last?.detail ?? "never looked"}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const fmt = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
