import Link from "next/link";
import { currentOwner } from "@/lib/auth/session";
import { allServices, listIncidents, listProbes, listServices, openIncidents, pendingDecisions, policyOf, readingsFor } from "@/lib/db/warden";
import { POSTURE_WORDS, posture } from "@/lib/ops/policy";
import type { Service } from "@/lib/db/schema";
import { BreakIt } from "@/components/break-it";
import { breakableService } from "@/lib/demo-break";
import { stanceOf } from "@/lib/ops/local";
import { CheckNow } from "@/components/check-now";
import { chipClass, statusChip } from "@/lib/incident-status";
import "./fleet.css";

export const dynamic = "force-dynamic";

/**
 * THE CONSOLE. Every service Warden watches for you, and what it has done about them.
 *
 * The default state of this page is the point of the product: a column of green, a row of quiet
 * nights, and nothing asking for you. It is designed to be boring, and to stop being boring in
 * exactly one way — an amber card at the top when Warden has stopped and needs an answer.
 *
 * Two fleets, and the distinction is load-bearing. YOURS is whatever you have registered, kept
 * behind a signed cookie. THE PUBLIC FLEET is the three services registered under the owner key
 * "demo", which anyone may watch and nobody but their owner may change — it is the live proof, and
 * it is the first thing a person sees before they have anything of their own.
 */
export default async function FleetPage() {
  const owner = await currentOwner();
  const mine = owner ? listServices(owner.key) : [];
  const demo = allServices().filter((s) => s.ownerKey === "demo");
  const visible = [...mine, ...demo];
  const waiting = pendingDecisions().filter((d) => visible.some((s) => s.id === d.serviceId));
  const open = openIncidents().filter((i) => visible.some((s) => s.id === i.serviceId));

  const fleet = mine.length ? mine : demo;
  const looks = fleet.reduce((n, s) => n + listProbes(s.id).reduce((m, p) => m + readingsFor(p.id, 200).length, 0), 0);
  const all = fleet.flatMap((s) => listIncidents(s.id, 200));
  const fixed = all.filter((i) => i.status === "resolved");
  // Deliberately not an uptime percentage. The public fleet is broken on purpose several times a day
  // to test the operator, so a "% clean" figure would say more about the testing than the software.
  const medianDown = median(fixed.map((i) => i.downSeconds ?? 0).filter(Boolean));

  // The one service an operator has set aside to be broken on purpose, if any. Offered only while
  // the fleet is quiet: a visitor arriving mid-incident already has the interesting thing to watch.
  const breakable = breakableService(process.env.WARDEN_DEMO_BREAKABLE, demo);
  const canBreak = breakable && open.length === 0 && waiting.length === 0 && openIncidents(breakable.id).length === 0;

  return (
    <main className="hm">
      <header className="hm-hero">
        <div className="hm-top">
          <div>
            <p className="hm-brand micro">{mine.length ? "Your fleet" : "The public fleet"}</p>
            <h1 className="hm-h1">{mine.length ? "Everything you have asked Warden to watch." : "Three real services, one machine, no sign-up."}</h1>
          </div>
          <div className="hm-do">
            <Link href="/new" className="btn btn-accent">{mine.length ? "Watch something else" : "Watch something of yours"}</Link>
            <CheckNow />
          </div>
        </div>
        <p className="hm-lede">
          {mine.length
            ? "Each card is one service: what Warden checks on it, every reading it has taken, and what your policy lets it do when a check fails."
            : "This is the fleet this Warden actually watches, live. It is not a screenshot, the incidents in it really happened, and the button below really stops one of them."}
        </p>
        <div className="hm-stats">
          <Stat n={String(fleet.length)} of={mine.length ? "yours, watched" : "services watched"} />
          <Stat n={looks.toLocaleString()} of="checks run" />
          <Stat n={String(all.length)} of={`incident${all.length === 1 ? "" : "s"}`} />
          <Stat n={String(fixed.length)} of={`closed without waking anyone${medianDown ? ` · median ${fmt(medianDown)} down` : ""}`} />
        </div>
      </header>

      {waiting.length > 0 ? (
        <section className="hm-waiting" id="waiting">
          {waiting.map((d) => {
            const svc = visible.find((s) => s.id === d.serviceId);
            return (
              <Link key={d.id} href={d.incidentId ? `/i/${d.incidentId}` : "/fleet"} className="hm-wait card">
                <p className="micro hm-wait-k">Warden stopped · {svc?.name ?? "a service"}</p>
                <p className="hm-wait-q">{d.question}</p>
                {d.because ? <p className="hm-wait-w">{d.because}</p> : null}
                <span className="hm-wait-go">Answer it →</span>
              </Link>
            );
          })}
        </section>
      ) : null}

      {canBreak && breakable ? <BreakIt name={breakable.name} /> : null}

      {mine.length ? (
        <section className="hm-fleet">
          <h2 className="hm-h2">Yours</h2>
          {mine.map((s) => (
            <ServiceCard key={s.id} service={s} />
          ))}
        </section>
      ) : (
        <section className="hm-start card">
          <h2 className="hm-start-h">Nothing of yours yet.</h2>
          <p className="hm-start-p">
            Give Warden a URL and it starts checking. Give it the machine and the process as well and it can read the logs, the
            process table and the last few commits when that URL stops answering — and, if you let it, put the thing back up and
            prove it by asking the check again.
          </p>
          <p className="hm-start-p">
            No account and no email: a signed cookie makes a service yours. Below is the fleet this Warden actually watches, live —
            it is not a screenshot, and the incidents in it really happened.
          </p>
          <Link href="/new" className="btn btn-accent">Point it at something</Link>
        </section>
      )}

      {demo.length ? (
        <section className="hm-fleet">
          <h2 className="hm-h2">
            {mine.length ? "The public fleet" : "Watching, right now"}
            <span className="hm-h2-n">anyone can watch these · nobody but their owner can change them</span>
          </h2>
          {demo.map((s) => (
            <ServiceCard key={s.id} service={s} />
          ))}
        </section>
      ) : null}

      <footer className="hm-foot">
        <p>
          Warden has no shell. It can only invoke named operations from a fixed catalogue, and a per-service policy decides whether
          each one happens, is refused, or stops the run and asks you. Every call it makes is on the incident page with the exact
          command and the rule that permitted it.
        </p>
        <p className="mono">
          <a href="https://github.com/shariqazeem/warden" rel="noreferrer">source</a> · MIT · built on the Strands Agents SDK
        </p>
      </footer>
    </main>
  );
}

function Stat({ n, of }: { n: string; of: string }) {
  return (
    <div className="hm-stat">
      <span className="hm-stat-n">{n}</span>
      <span className="hm-stat-o">{of}</span>
    </div>
  );
}

function ServiceCard({ service }: { service: Service }) {
  const probes = listProbes(service.id);
  const open = openIncidents(service.id);
  const policy = policyOf(service);
  const history = listIncidents(service.id, 60);
  const stance = stanceOf(service, POSTURE_WORDS[posture(policy)]);
  const paused = service.state === "paused";

  const state = paused ? "unknown" : open.length ? "down" : probes.length ? "ok" : "unknown";

  return (
    <article className={`sv card is-${state}`}>
      <header className="sv-head">
        <div>
          <h3 className="sv-name"><Link href={`/s/${service.id}`}>{service.name}</Link></h3>
          {service.matters ? <p className="sv-matters">{service.matters}</p> : null}
        </div>
        <span className={`chip ${state === "ok" ? "is-ok" : state === "down" ? "is-down" : "is-unknown"}`}>
          {paused ? "paused" : state === "ok" ? "up" : state === "down" ? `${open.length} open` : "no checks"}
        </span>
      </header>

      <ul className="sv-probes">
        {probes.map((p) => {
          const rs = readingsFor(p.id, 60);
          const last = rs[0];
          return (
            <li key={p.id} className="sv-probe">
              <span className={`sv-led ${last ? (last.ok ? "is-ok" : "is-down") : "is-unknown"}`} aria-hidden="true" />
              <span className="sv-probe-l">{p.label}</span>
              {/* one mark per look, newest on the right. Mostly green is what a watch looks like. */}
              <span className="sv-spark" aria-hidden="true">
                {rs
                  .slice(0, 40)
                  .reverse()
                  .map((r) => (
                    <i key={r.id} className={r.ok ? "is-ok" : "is-down"} title={`${new Date(r.at).toISOString().slice(11, 16)} · ${r.detail}`} />
                  ))}
              </span>
              <span className="sv-probe-d mono">{last ? last.detail.slice(0, 40) : "never looked"}</span>
            </li>
          );
        })}
        {probes.length === 0 ? <li className="sv-probe sv-none">No checks yet — nothing can be said about this one honestly.</li> : null}
      </ul>

      <footer className="sv-foot">
        <span className={`chip is-${stance.tone}`}>{stance.label}</span>
        <span className="sv-policy">{policy.note}</span>
      </footer>

      {history.length ? (
        <ul className="sv-incidents">
          {history.slice(0, 4).map((i) => (
            <li key={i.id}>
              <Link href={`/i/${i.id}`}>
                <span className={chipClass(i.status)}>{statusChip(i.status).label}</span>
                <span className="sv-inc-t">{i.title.replace(`${service.name}: `, "")}</span>
                {i.downSeconds !== null ? <span className="mono sv-inc-d">{fmt(i.downSeconds)}</span> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

const fmt = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}
