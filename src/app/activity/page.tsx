import Link from "next/link";
import { currentOwner } from "@/lib/auth/session";
import { allServices, listActions, listEvents, listIncidents, listServices } from "@/lib/db/warden";
import "./activity.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Activity — Warden",
  description: "Every operation Warden has run, with the rule that permitted it.",
};

/**
 * EVERYTHING WARDEN HAS DONE, in one column, newest first.
 *
 * The incident page proves one incident. This proves the habit: every command across every service,
 * the policy rule behind each one, and what came back. It is the page you would open if you wanted
 * to find out whether an agent you gave permissions to has been behaving — so it shows the refusals
 * as prominently as the acts, and it never summarises a command, it prints it.
 */
export default async function ActivityPage() {
  const owner = await currentOwner();
  const mine = owner ? listServices(owner.key) : [];
  const demo = allServices().filter((s) => s.ownerKey === "demo");
  const services = [...mine, ...demo];
  const byId = new Map(services.map((s) => [s.id, s]));

  // Every operation, then the most recent page of them. Rendering two hundred with their output
  // made a page thirty-five thousand pixels tall that nobody scrolls to the bottom of, and the
  // complete record of any one incident is on that incident's own page anyway.
  const SHOWN = 60;
  const every = services
    .flatMap((s) => listIncidents(s.id, 60))
    .flatMap((i) => listActions(i.id).map((a) => ({ ...a, incident: i })))
    .sort((a, b) => b.at - a.at);
  const rows = every.slice(0, SHOWN);

  const humans = services
    .flatMap((s) => listEvents(s.id, 40))
    .filter((e) => e.actor === "human")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20);

  // Counted over everything, not over the page — a total that changes when you scroll is not one.
  const acted = every.filter((r) => r.verdict === "allow" && r.risk !== "read").length;
  const refused = every.filter((r) => r.verdict === "refuse").length;
  const asked = every.filter((r) => r.verdict === "ask").length;

  return (
    <main className="ac">
      <p className="in-crumb micro">
        <Link href="/">warden</Link> / activity
      </p>

      <header className="ac-head">
        <h1 className="ac-h1">Everything it has done.</h1>
        <p className="ac-lede">
          Every operation Warden has run across {services.length} service{services.length === 1 ? "" : "s"}, newest first, with the
          policy rule that permitted each one and exactly what came back. Copy any command and run it yourself — that is what the
          column is for.
        </p>
        <div className="ac-stats">
          <span className="ac-stat"><b>{every.length}</b> operations</span>
          <span className="ac-stat"><b>{acted}</b> that changed something</span>
          <span className="ac-stat"><b>{asked}</b> stopped to ask</span>
          <span className="ac-stat"><b>{refused}</b> refused</span>
        </div>
      </header>

      {humans.length ? (
        <section className="ac-sec">
          <h2 className="in-h2">What people changed</h2>
          <ul className="ac-humans">
            {humans.map((e) => (
              <li key={e.id}>
                <span className="micro ac-kind">{e.kind.replace(/\./g, " ")}</span>
                <span className="ac-h-svc">{byId.get(e.serviceId)?.name ?? "a service"}</span>
                <span className="ac-h-d">{e.detail}</span>
                <span className="mono ac-when">{ago(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="ac-sec">
        <h2 className="in-h2">
          What Warden ran
          {every.length > SHOWN ? (
            <span className="in-count mono">
              the most recent {SHOWN} · each incident&rsquo;s own page has all of its
            </span>
          ) : null}
        </h2>
        {rows.length === 0 ? (
          <p className="ac-empty">
            Nothing yet. Warden has not needed to do anything — which, for an operator, is the normal state and the good one.
          </p>
        ) : (
          <ol className="ac-rows">
            {rows.map((a) => (
              <li key={a.id} className={`ac-row is-${a.verdict}`}>
                <span className="ac-dot" aria-hidden="true" />
                <div className="ac-body">
                  <p className="ac-line">
                    <span className="mono ac-op">{a.op}</span>
                    <span className={`chip ${a.verdict === "allow" ? (a.risk === "read" ? "is-unknown" : "is-accent") : a.verdict === "ask" ? "is-warn" : "is-down"}`}>
                      {a.verdict === "allow" ? (a.risk === "read" ? "read" : "changed something") : a.verdict === "ask" ? "stopped to ask" : "refused"}
                    </span>
                    <Link href={`/s/${a.serviceId}`} className="ac-svc">{byId.get(a.serviceId)?.name ?? "a service"}</Link>
                    <span className="mono ac-when">{ago(a.at)}{a.ms ? ` · ${a.ms}ms` : ""}</span>
                  </p>
                  {a.command ? <pre className="well ac-cmd">{a.command}</pre> : null}
                  <p className="ac-why">
                    <span className="micro">{a.rule}</span>
                    {a.reason}
                  </p>
                  {a.output ? <pre className="well ac-out">{a.output.slice(0, 400)}</pre> : null}
                  <Link href={`/i/${a.incidentId}`} className="ac-inc">
                    {a.incident.title.replace(`${byId.get(a.serviceId)?.name ?? ""}: `, "")} →
                  </Link>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
