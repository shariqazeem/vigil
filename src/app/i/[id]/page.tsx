import Link from "next/link";
import { notFound } from "next/navigation";
import { canView, currentOwner } from "@/lib/auth/session";
import { decisionsFor, getIncident, getProbe, getService, listActions, parseOptions, pendingDecisions } from "@/lib/db/warden";
import { Live, type OpenQuestion } from "./live";
import "./incident.css";
import { chipClass, statusChip } from "@/lib/incident-status";
import { canOperate } from "@/lib/ops/local";
import { opWord, riskWord, ruleWord, verdictTone, verdictWord } from "@/lib/words";

export const dynamic = "force-dynamic";

/**
 * ONE INCIDENT. What failed, what Warden did about it, and — at the bottom, where a claim belongs —
 * the exact commands it ran with the policy rule that let each one through.
 *
 * The audit table is the point of this page. Anyone can say an agent fixed something; this shows
 * the argv, the exit code and the sentence from the policy that permitted it.
 */
export default async function IncidentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { id } = await params;
  // Arriving straight from "break it and watch": start the run rather than making somebody who
  // just broke something on purpose press a second button to find out what happened.
  const auto = "go" in (await searchParams);
  const incident = getIncident(id);
  if (!incident) notFound();
  const service = getService(incident.serviceId);
  if (!service) notFound();
  const owner = await currentOwner();
  if (!canView(service.ownerKey, owner)) notFound();

  const probe = getProbe(incident.probeId);
  const acts = listActions(id);
  const decided = decisionsFor(id);
  const open = pendingDecisions(service.id).find((d) => d.incidentId === id) ?? null;
  const question: OpenQuestion | null = open
    ? { id: open.id, question: open.question, proposal: open.proposal, because: open.because, options: parseOptions(open) }
    : null;

  const resolved = incident.status === "resolved";
  const changed = acts.filter((a) => a.verdict === "allow" && a.risk !== "read");

  return (
    <main className="in">
      <p className="in-crumb micro">
        <Link href="/fleet">warden</Link> / <Link href={`/s/${service.id}`}>{service.name}</Link> / problem
      </p>

      <header className="in-head">
        <div>
          <h1 className="in-title">{incident.title}</h1>
          <p className="in-sub">
            <span className={chipClass(incident.status)}>{statusChip(incident.status).label}</span>
            <span className="mono in-when">opened {when(incident.openedAt)}</span>
            {incident.downSeconds !== null ? <span className="mono in-down">down {fmt(incident.downSeconds)}</span> : null}
          </p>
        </div>
      </header>

      <div className="in-symptom card">
        <p className="micro">what the check said</p>
        <p className="in-symptom-t">
          <span className="in-probe">{probe?.label ?? "the check"}</span> — {incident.symptom}
        </p>
      </div>

      {incident.diagnosis ? (
        <div className="in-dx card">
          <p className="micro">
            Warden&rsquo;s diagnosis{incident.confidence !== null ? ` · ${Math.round(incident.confidence * 100)}% sure of the cause` : ""}
          </p>
          <p className="in-dx-t">{incident.diagnosis}</p>
          {incident.suspect ? <p className="in-suspect mono">suspect · {incident.suspect}</p> : null}
        </div>
      ) : null}

      {!canOperate(service) ? (
        <p className="sp-reach">
          <b>This service is watched over the network only.</b> Warden can ask the network about it — does the name resolve, what
          answers, is that the app or a proxy&rsquo;s error page, is the certificate fine — and it will say which. What it cannot do
          is bring it back: there are no logs, no process table and nothing to restart.{" "}
          <Link href={`/s/${service.id}`}>Give it a deploy or restart hook</Link> and that becomes the one act it has.
        </p>
      ) : null}

      <Live incidentId={id} open={question} canRun={!resolved} resolved={resolved} autoStart={auto && !resolved && !question} />

      {incident.resolution ? (
        <p className={`in-outcome ${resolved ? "is-ok" : "is-warn"}`}>{incident.resolution}</p>
      ) : null}

      {decided.filter((d) => d.answeredAt).length ? (
        <section className="in-sec">
          <h2 className="in-h2">What you decided</h2>
          <ul className="in-decisions">
            {decided
              .filter((d) => d.answeredAt)
              .map((d) => (
                <li key={d.id} className="card">
                  <p className="in-dq">{d.question}</p>
                  <p className="in-da">
                    <span className={`chip ${d.answer === "approve" ? "is-ok" : "is-unknown"}`}>{d.answer}</span>
                    {d.answerNote ? <span className="in-dn">{d.answerNote}</span> : null}
                  </p>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <section className="in-sec">
        <h2 className="in-h2">
          Everything it ran
          <span className="in-count mono">
            {acts.length} call{acts.length === 1 ? "" : "s"} · {changed.length} changed something
          </span>
        </h2>
        <p className="in-lede">
          Warden has no shell. Each row below is one named action from a fixed list, spawned without a shell, with the rule of
          yours that permitted it. Copy any command and run it yourself.
        </p>
        <div className="in-table-wrap">
          <table className="in-table">
            <thead>
              <tr>
                <th>what</th>
                <th>how safe</th>
                <th>your rule</th>
                <th>command</th>
                <th className="in-num">ms</th>
              </tr>
            </thead>
            <tbody>
              {acts.map((a) => (
                <tr key={a.id} className={a.verdict === "refuse" ? "is-refused" : a.verdict === "ask" ? "is-asked" : a.ok === false ? "is-failed" : ""}>
                  <td className="in-op">
                    {opWord(a.op)} <code className="mono in-op-raw">{a.op}</code>
                  </td>
                  <td>
                    <span className={`chip ${a.risk === "read" ? "is-unknown" : a.risk === "reversible" ? "is-accent" : "is-warn"}`}>{riskWord(a.risk)}</span>
                  </td>
                  <td className="in-rule-cell">
                    <span className={`chip is-${verdictTone(a.verdict)}`}>{verdictWord(a.verdict)}</span>
                    <span className="in-rule mono" title={a.rule}>{ruleWord(a.rule)}</span>
                  </td>
                  <td className="mono in-cmd">{a.command ?? <span className="in-never">{a.reason}</span>}</td>
                  <td className="in-num mono">{a.ms ?? "—"}</td>
                </tr>
              ))}
              {acts.length === 0 ? (
                <tr>
                  <td colSpan={5} className="in-empty">
                    Nothing has been run on this problem yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <p className="in-note">
          {resolved && incident.verifiedByReadingId ? (
            <>
              This incident is marked resolved because <strong>{probe?.label ?? "the check"}</strong> — the same check that failed —
              was run again and passed. Nothing Warden believed about its own fix could have closed it.
            </>
          ) : (
            <>
              A problem is only ever closed by re-running the check that opened it. Warden does not get to say it fixed something.
            </>
          )}
        </p>
      </section>
    </main>
  );
}

function when(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 2) return "just now";
  if (m < 90) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
}
const fmt = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
