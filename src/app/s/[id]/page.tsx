import Link from "next/link";
import { notFound } from "next/navigation";
import { canEdit, canView, currentOwner } from "@/lib/auth/session";
import { listIncidents, listProbes, listStanding, parseSpec, policyOf, readingsFor, getService } from "@/lib/db/warden";
import { POSTURE_WORDS, decide, posture } from "@/lib/ops/policy";
import { CheckNow } from "@/components/check-now";
import { PolicyEditor, ProbeAdder, RetireProbe, ServiceSettings } from "./manage";
import { catalogue } from "@/lib/ops/operations";
import "../../i/[id]/incident.css";
import "./service.css";
import { chipClass, statusChip } from "@/lib/incident-status";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const service = getService(id);
  if (!service) return { title: "Not found — Warden" };
  return {
    title: `${service.name} — Warden`,
    description: service.matters ?? `What Warden checks on ${service.name}, what it may do about it, and everything it has done.`,
  };
}

/**
 * ONE SERVICE. What Warden is checking, what it has been told it may do, and everything that has
 * gone wrong so far.
 *
 * The policy is printed in full, as a table of every operation Warden can perform and what this
 * service's policy says about each. It is the page you would show somebody who asked "so what can
 * this thing actually do to my box" — and the honest answer is a finite list.
 */
export default async function ServicePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  const welcome = "welcome" in (await searchParams);
  const service = getService(id);
  if (!service) notFound();
  const owner = await currentOwner();
  if (!canView(service.ownerKey, owner)) notFound();
  const mine = canEdit(service.ownerKey, owner);

  const probes = listProbes(id);
  const policy = policyOf(service);
  const incidents = listIncidents(id, 40);
  const standing = listStanding(id);
  const ops = catalogue();

  /**
   * What would happen if this operation came up right now, on a fresh incident. This calls the SAME
   * pure function the agent is gated by — it does not re-state the policy's ordering in JSX, which
   * is how a page like this ends up quietly describing rules the engine stopped following.
   */
  const verdictFor = (op: string): { label: string; tone: string; rule: string } => {
    const d = decide(op, policy, { actionsTaken: 0, minutesSinceLastAction: null });
    if (d.rule === "forbidden-always") return { label: "never, under any policy", tone: "is-down", rule: d.rule };
    if (d.verdict === "refuse") return { label: "never", tone: "is-down", rule: d.rule };
    if (d.verdict === "ask") return { label: "asks first", tone: "is-warn", rule: d.rule };
    return { label: "may", tone: "is-ok", rule: d.rule };
  };

  const resolved = incidents.filter((i) => i.status === "resolved");
  const totalLooks = probes.reduce((n, p) => n + readingsFor(p.id, 200).length, 0);

  return (
    <main className="sp">
      <p className="in-crumb micro">
        <Link href="/">warden</Link> / service
      </p>

      {welcome ? (
        <div className="sp-welcome card">
          <p className="micro sp-welcome-k">Registered</p>
          <p className="sp-welcome-t">
            Warden is watching this now. The next sweep picks it up on its own — or press <b>Check it now</b> to ask straight away.
          </p>
          <p className="sp-welcome-b">
            Below is everything it is able to do here, and every line of it is yours to change. Nothing on this page is a
            description of what Warden intends; it is what the policy engine will actually answer when the agent asks.
          </p>
        </div>
      ) : null}

      <header className="sp-head">
        <h1 className="sp-title">{service.name}</h1>
        {service.matters ? <p className="sp-matters">{service.matters}</p> : null}
        <p className="sp-meta mono">
          {service.host === "local" ? "on this machine" : service.host}
          {service.process ? ` · pm2 ${service.process}` : ""}
          {service.repo ? ` · ${service.repo}` : ""}
        </p>
        <div className="sp-actions">
          <span className={`chip is-${POSTURE_WORDS[posture(policy)].tone}`}>{POSTURE_WORDS[posture(policy)].label}</span>
          {service.state === "paused" ? (
            <span className="chip is-unknown">paused — no sweep touches this</span>
          ) : (
            <CheckNow serviceId={service.id} label="Check it now" />
          )}
        </div>
      </header>

      <section className="sp-sec">
        <h2 className="in-h2">
          What it checks
          <span className="in-count mono">
            {totalLooks.toLocaleString()} look{totalLooks === 1 ? "" : "s"} kept
          </span>
        </h2>
        <ul className="sp-probes">
          {probes.map((p) => {
            const rs = readingsFor(p.id, 120);
            const last = rs[0];
            const up = rs.length ? Math.round((rs.filter((r) => r.ok).length / rs.length) * 100) : null;
            const spec = parseSpec(p);
            return (
              <li key={p.id} className="card sp-probe">
                <div className="sp-probe-h">
                  <span className={`chip ${last ? (last.ok ? "is-ok" : "is-down") : "is-unknown"}`}>{last ? (last.ok ? "passing" : "failing") : "never looked"}</span>
                  <span className="sp-probe-l">{p.label}</span>
                  {up !== null ? <span className="sp-probe-up mono">{up}% of {rs.length}</span> : null}
                </div>
                <p className="sp-probe-spec mono">
                  {p.kind === "http" ? `GET ${String(spec.url ?? "")}` : `pm2 · ${String(spec.process ?? "")}`} · every {p.everySeconds}s · opens an incident after{" "}
                  {p.failuresToOpen} failure{p.failuresToOpen === 1 ? "" : "s"} in a row
                </p>
                {last ? <p className="sp-probe-last mono">{last.detail}</p> : null}
                {mine ? <RetireProbe probeId={p.id} label={p.label} /> : null}
                <span className="sp-spark" aria-hidden="true">
                  {rs
                    .slice(0, 60)
                    .reverse()
                    .map((r) => (
                      <i key={r.id} className={r.ok ? "is-ok" : "is-down"} />
                    ))}
                </span>
              </li>
            );
          })}
          {probes.length === 0 ? <li className="sp-empty">No checks yet, so there is nothing Warden can honestly say about this.</li> : null}
        </ul>
        {mine ? <ProbeAdder serviceId={service.id} hasProcess={!!service.process} /> : null}
      </section>

      <section className="sp-sec">
        <h2 className="in-h2">What it may do here</h2>
        <p className="in-lede">
          {mine
            ? "This is the whole list — there is nothing else Warden is able to do. Change any line and press save; nothing is applied until you do."
            : "This is the whole list — there is nothing else Warden is able to do."}
        </p>
        {mine ? (
          <PolicyEditor serviceId={service.id} ops={ops.map((o) => ({ name: o.name, risk: o.risk, does: o.does }))} policy={policy} />
        ) : (
          <>
            <p className="in-lede">
              {policy.note ? <em>&ldquo;{policy.note}&rdquo;</em> : null} At most {policy.maxActionsPerIncident} action
              {policy.maxActionsPerIncident === 1 ? "" : "s"} on one incident, and no acting twice within {policy.cooldownMinutes} minutes.
            </p>
            <div className="in-table-wrap">
              <table className="in-table sp-ops">
                <thead>
                  <tr>
                    <th>operation</th>
                    <th>what it does</th>
                    <th>on this service</th>
                  </tr>
                </thead>
                <tbody>
                  {ops.map((o) => {
                    const v = verdictFor(o.name);
                    return (
                      <tr key={o.name} className={o.risk === "forbidden" ? "is-refused" : ""}>
                        <td className="mono in-op">{o.name}</td>
                        <td className="sp-does">{o.does}</td>
                        <td>
                          <span className={`chip ${v.tone}`}>{v.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {standing.length ? (
        <section className="sp-sec">
          <h2 className="in-h2">What you have told it</h2>
          <ul className="sp-standing">
            {standing.map((s) => (
              <li key={s.id} className="card">
                <span>{s.text}</span>
                <span className="mono sp-when">{new Date(s.createdAt).toISOString().slice(0, 10)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="sp-sec">
        <h2 className="in-h2">
          What has gone wrong
          <span className="in-count mono">
            {incidents.length} incident{incidents.length === 1 ? "" : "s"}
            {resolved.length ? ` · ${resolved.length} fixed without a human` : ""}
          </span>
        </h2>
        <ul className="sp-incidents">
          {incidents.map((i) => (
            <li key={i.id}>
              <Link href={`/i/${i.id}`} className="card">
                <span className={chipClass(i.status)}>{statusChip(i.status).label}</span>
                <span className="sp-inc-t">{i.title.replace(`${service.name}: `, "")}</span>
                <span className="sp-inc-s mono">{i.symptom.slice(0, 60)}</span>
                <span className="sp-inc-d mono">{i.downSeconds !== null ? fmt(i.downSeconds) : "—"}</span>
              </Link>
            </li>
          ))}
          {incidents.length === 0 ? <li className="sp-empty">Nothing has gone wrong yet.</li> : null}
        </ul>
      </section>

      {mine ? (
        <section className="sp-sec">
          <h2 className="in-h2">This service</h2>
          <ServiceSettings serviceId={service.id} name={service.name} paused={service.state === "paused"} />
        </section>
      ) : null}
    </main>
  );
}

const fmt = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
