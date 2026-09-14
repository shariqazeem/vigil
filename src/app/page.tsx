import Link from "next/link";
import { allServices, listIncidents, listProbes, openIncidents, pendingDecisions, policyOf, readingsFor } from "@/lib/db/warden";
import { POSTURE_WORDS, posture } from "@/lib/ops/policy";
import type { Service } from "@/lib/db/schema";
import "./home.css";
import { chipClass, statusChip } from "@/lib/incident-status";

export const dynamic = "force-dynamic";

/**
 * THE CONSOLE. Every service Warden watches, and what it has done about them.
 *
 * The default state of this page is the point of the product: a column of green, a row of quiet
 * nights, and nothing asking for you. It is designed to be boring, and to stop being boring in
 * exactly one way — an amber card at the top when Warden has stopped and needs an answer.
 */
export default async function Console() {
  const services = allServices();
  const waiting = pendingDecisions();
  const open = openIncidents();

  const looks = services.reduce((n, s) => n + listProbes(s.id).reduce((m, p) => m + readingsFor(p.id, 200).length, 0), 0);
  const all = services.flatMap((s) => listIncidents(s.id, 200));
  const fixed = all.filter((i) => i.status === "resolved");
  // Deliberately not an uptime percentage. This fleet is broken on purpose several times a day to
  // test the operator, so a "% clean" figure would say more about the testing than the software.
  const medianDown = median(fixed.map((i) => i.downSeconds ?? 0).filter(Boolean));

  return (
    <main className="hm">
      <header className="hm-hero">
        <p className="hm-brand micro">Warden</p>
        <h1 className="hm-h1">Your software should not need you awake to keep running.</h1>
        <p className="hm-lede">
          Warden watches the things you have running, investigates them when they break, fixes what your policy lets it fix, proves
          the fix by re-running the check that failed — and wakes you only when the answer is genuinely yours to give.
        </p>
        <div className="hm-stats">
          <Stat n={String(services.length)} of="services watched" />
          <Stat n={looks.toLocaleString()} of="checks run" />
          <Stat n={String(all.length)} of={`incident${all.length === 1 ? "" : "s"}`} />
          <Stat n={String(fixed.length)} of={`closed without waking anyone${medianDown ? ` · median ${fmt(medianDown)} down` : ""}`} />
        </div>
      </header>

      {waiting.length > 0 ? (
        <section className="hm-waiting">
          {waiting.map((d) => {
            const svc = services.find((s) => s.id === d.serviceId);
            return (
              <Link key={d.id} href={d.incidentId ? `/i/${d.incidentId}` : "/"} className="hm-wait card">
                <p className="micro hm-wait-k">Warden stopped · {svc?.name ?? "a service"}</p>
                <p className="hm-wait-q">{d.question}</p>
                {d.because ? <p className="hm-wait-w">{d.because}</p> : null}
                <span className="hm-wait-go">Answer it →</span>
              </Link>
            );
          })}
        </section>
      ) : null}

      <section className="hm-fleet">
        {services.map((s) => (
          <ServiceCard key={s.id} service={s} />
        ))}
        {services.length === 0 ? (
          <p className="hm-empty">
            Nothing is registered yet. Run <code className="mono">npx tsx --env-file=.env scripts/warden.ts register</code> to point
            Warden at something.
          </p>
        ) : null}
      </section>

      {open.length === 0 && waiting.length === 0 && services.length > 0 ? (
        <p className="hm-quiet">Everything is up. Warden is watching, and there is nothing for you to do.</p>
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
  const stance = POSTURE_WORDS[posture(policy)];

  const state = open.length ? "down" : probes.length ? "ok" : "unknown";

  return (
    <article className={`sv card is-${state}`}>
      <header className="sv-head">
        <div>
          <h2 className="sv-name"><Link href={`/s/${service.id}`}>{service.name}</Link></h2>
          {service.matters ? <p className="sv-matters">{service.matters}</p> : null}
        </div>
        <span className={`chip ${state === "ok" ? "is-ok" : state === "down" ? "is-down" : "is-unknown"}`}>
          {state === "ok" ? "up" : state === "down" ? `${open.length} open` : "no checks"}
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
