import Link from "next/link";
import { AlertTriangle, Check, Hand, MessageCircleQuestion, Radio } from "lucide-react";
import { CountUp } from "@/components/count-up";
import { currentOwner } from "@/lib/auth/session";
import { allServices, listIncidents, listServices, pendingDecisions } from "@/lib/db/warden";
import { statusChip } from "@/lib/incident-status";
import { WaitingBanner } from "@/components/shell/rail";
import "./incidents.css";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Incidents — Warden",
  description: "Everything that has gone wrong, what Warden did about it, and how long it was down.",
};

/**
 * EVERY INCIDENT, NEWEST FIRST.
 *
 * The fleet page answers "is anything wrong now". This one answers the question you ask afterwards:
 * what has gone wrong, how often, and what happened about it — which is the question that decides
 * whether you widen a policy or narrow it.
 */
export default async function IncidentsPage() {
  const owner = await currentOwner();
  const mine = owner ? listServices(owner.key) : [];
  const demo = allServices().filter((s) => s.ownerKey === "demo");
  const services = [...mine, ...demo];
  const byId = new Map(services.map((s) => [s.id, s]));
  const waiting = pendingDecisions().filter((d) => byId.has(d.serviceId));

  const rows = services
    .flatMap((s) => listIncidents(s.id, 60))
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, 80);

  const fixed = rows.filter((i) => i.status === "resolved");
  const open = rows.filter((i) => !i.resolvedAt);
  const downs = fixed.map((i) => i.downSeconds ?? 0).filter(Boolean);

  return (
    <main className="iq">
      <header className="iq-head">
        <h1 className="iq-h1">What has gone wrong.</h1>
        <p className="iq-lede">
          Every problem across {services.length} service{services.length === 1 ? "" : "s"}, newest first — what failed, what
          Warden did about it, and how long the thing was actually down, measured to the reading that proved it back rather than
          to the moment of the fix.
        </p>
        <div className="iq-stats">
          <Stat v={<CountUp value={rows.length} />} k={rows.length === 1 ? "problem" : "problems"} />
          <Stat v={<CountUp value={fixed.length} />} k="closed without waking anyone" />
          <Stat v={<CountUp value={open.length} />} k="still open" />
          <Stat v={downs.length ? fmt(median(downs)) : "—"} k="median time down" />
        </div>
      </header>

      {waiting.length ? <WaitingBanner waiting={waiting.length} href={waiting[0]!.incidentId ? `/i/${waiting[0]!.incidentId}` : "/fleet"} /> : null}

      {rows.length === 0 ? (
        <p className="iq-empty">
          Nothing has gone wrong yet — which, for an operator, is the normal state and the good one.{" "}
          <Link href="/fleet">Watch the board</Link>, or <Link href="/new">point Warden at something</Link>.
        </p>
      ) : (
        <ol className="tl">
          {rows.map((i) => {
            const svc = byId.get(i.serviceId);
            const chip = statusChip(i.status);
            const live = !i.resolvedAt;
            const Icon = i.status === "resolved" ? Check : i.status === "waiting" ? MessageCircleQuestion : i.status === "escalated" ? Hand : live ? Radio : AlertTriangle;
            return (
              <li key={i.id}>
                <Link href={`/i/${i.id}`} className={`tl-row is-link is-${chip.tone}`}>
                  <span className="tl-ic" aria-hidden><Icon size={14} strokeWidth={2.2} /></span>
                  <span className="tl-body">
                    <span className="tl-t">{i.title.replace(`${svc?.name ?? ""}: `, "")}</span>
                    <span className="tl-m">
                      <b>{svc?.name ?? "a service"}</b> · {chip.label} · {i.symptom}
                      {i.downSeconds !== null ? ` · down ${fmt(i.downSeconds)}` : ""}
                    </span>
                  </span>
                  <span className="tl-side">{live ? <span className="tl-live">live</span> : ago(i.openedAt)}</span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}

function Stat({ v, k }: { v: React.ReactNode; k: string }) {
  return (
    <div className="iq-stat">
      <span className="iq-stat-v">{v}</span>
      <span className="iq-stat-k">{k}</span>
    </div>
  );
}

const fmt = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
