import Link from "next/link";
import { notFound } from "next/navigation";
import { canView, currentOwner } from "@/lib/auth/session";
import { getHousehold, getPass, listChecks, listFindings, listThings } from "@/lib/db/vigil";
import { SOURCE_LABELS } from "@/lib/sources";
import type { SourceName } from "@/lib/sources/types";
import "../../board.css";
import "./pass.css";

export const dynamic = "force-dynamic";

/**
 * ONE WATCH, IN FULL. Every question the agent put to a government API that night: the exact URL,
 * whether it answered, how many rows came back and how long it took.
 *
 * This page exists because "we checked and it was fine" is a claim, and a claim about a child's cot
 * should be checkable by the person it is made to. Copy any line below into a terminal and you get
 * the same answer Vigil got.
 */
export default async function PassPage({ params }: { params: Promise<{ id: string; passId: string }> }) {
  const { id, passId } = await params;
  const household = getHousehold(id);
  const pass = getPass(passId);
  if (!household || !pass || pass.householdId !== id) notFound();
  const owner = await currentOwner();
  if (!canView(household.ownerKey, owner)) notFound();

  const checks = listChecks(passId);
  const things = listThings(id, { includeRetired: true });
  const found = listFindings(id).filter((f) => f.passId === passId);
  const label = (tid: string) => things.find((t) => t.id === tid)?.label ?? tid;
  const ms = pass.finishedAt ? pass.finishedAt - pass.startedAt : null;

  return (
    <main className="ps">
      <p className="bd-eyebrow mono">
        <Link href="/">vigil</Link> / <Link href={`/h/${id}`}>{household.name}</Link> / watch
      </p>
      <h1 className="ps-h1">
        {new Date(pass.startedAt).toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" })}
      </h1>
      <p className="ps-sub">
        <span className={`ps-status is-${pass.status}`}>{pass.status}</span>
        {" · "}
        <span className="mono">{pass.rowsSeen.toLocaleString()}</span> government records read ·{" "}
        <span className="mono">{pass.sourcesOk}</span> sources answered
        {pass.sourcesFailed ? (
          <>
            {" · "}
            <span className="mono ps-failed">{pass.sourcesFailed} did not</span>
          </>
        ) : null}
        {ms ? ` · ${(ms / 1000).toFixed(1)}s` : ""} · started by {pass.trigger}
      </p>

      {found.length > 0 ? (
        <p className="ps-found">
          This watch found {found.length} record{found.length === 1 ? "" : "s"}:{" "}
          {found.map((f) => (
            <span key={f.id} className="mono">
              {f.sourceId}{" "}
            </span>
          ))}
        </p>
      ) : null}

      <h2 className="bd-h2 ps-h2">Every question it asked</h2>
      <p className="bd-lede">
        These are the real URLs. They are public and need no key — paste one into a terminal and you will get what Vigil got.
      </p>

      <table className="ps-table">
        <thead>
          <tr>
            <th>thing</th>
            <th>source</th>
            <th className="ps-num">rows</th>
            <th className="ps-num">ms</th>
            <th>endpoint</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((c) => (
            <tr key={c.id} className={c.ok ? "" : "is-failed"}>
              <td>{label(c.thingId)}</td>
              <td className="mono">
                <span className={`ps-dot ${c.ok ? "is-ok" : "is-err"}`} aria-hidden="true" />
                {SOURCE_LABELS[c.source as SourceName]?.agency ?? c.source}
              </td>
              <td className="ps-num mono">{c.ok ? c.rowCount.toLocaleString() : "—"}</td>
              <td className="ps-num mono">{c.latencyMs}</td>
              <td className="mono ps-url">{c.ok ? c.endpoint : `${c.endpoint} — ${c.error ?? "no answer"}`}</td>
            </tr>
          ))}
          {checks.length === 0 ? (
            <tr>
              <td colSpan={5} className="ps-empty">
                This watch recorded no source calls.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <p className="ps-note">
        A source that did not answer is shown as <strong>unchecked</strong>, never as clear. Silence is not safety, and a watch that
        quietly treated a timeout as &ldquo;nothing wrong&rdquo; would be worse than no watch at all.
      </p>
    </main>
  );
}
