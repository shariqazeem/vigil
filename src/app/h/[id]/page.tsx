import Link from "next/link";
import { notFound } from "next/navigation";
import { canView, currentOwner } from "@/lib/auth/session";
import { getBoard, parseOptions } from "@/lib/db/vigil";
import { latestRecording } from "@/agent/recording";
import { Watch, type OpenQuestion } from "./watch";
import { Nights } from "./nights";
import { Notice } from "./notice";
import type { FieldThing } from "@/components/field/field";
import "./board.css";
import "@/components/field/field.css";

export const dynamic = "force-dynamic";

/**
 * THE BOARD. What a household looks like when something is keeping an eye on it.
 *
 * The order is the point. The field first, because the thing worth watching is the agent moving
 * through your home. Then anything it is waiting on you for. Then what it found, in the
 * government's own words with the record number beside it. Then the nights — mostly nothing, which
 * is what a watch looks like when it is working.
 */
export default async function Board({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const board = getBoard(id);
  if (!board) notFound();
  const owner = await currentOwner();
  if (!canView(board.household.ownerKey, owner)) notFound();

  const { household, things, findings, decisions, passes, standing, lastChecked } = board;
  const open = decisions.find((d) => !d.answeredAt) ?? null;
  const openThing = open?.thingId ? things.find((t) => t.id === open.thingId) : null;
  const question: OpenQuestion | null = open
    ? { id: open.id, question: open.question, context: open.context, options: parseOptions(open), thingLabel: openThing?.label ?? null }
    : null;

  const fieldThings: FieldThing[] = things.map((t) => ({
    id: t.id,
    kind: t.kind,
    label: t.label,
    make: t.make,
    model: t.model,
    year: t.year,
    category: t.category,
    secondHand: t.secondHand,
    lastCheckedAt: lastChecked[t.id] ?? null,
    findings: findings.filter((f) => f.thingId === t.id && f.state !== "dismissed").map((f) => ({ sourceId: f.sourceId, severity: f.severity })),
  }));

  const finished = passes.filter((p) => p.finishedAt);
  const rowsRead = passes.reduce((n, p) => n + p.rowsSeen, 0);
  const sourcesAsked = passes.reduce((n, p) => n + p.sourcesOk + p.sourcesFailed, 0);
  const live = findings.filter((f) => f.state !== "dismissed");
  const critical = live.filter((f) => f.severity === "critical");
  const recording = latestRecording(id);

  return (
    <main className="bd">
      <header className="bd-head">
        <div>
          <p className="bd-eyebrow mono">
            <Link href="/">vigil</Link> / watching
          </p>
          <h1 className="bd-title">{household.name}</h1>
          <p className="bd-sub">
            {things.length} thing{things.length === 1 ? "" : "s"} · {finished.length} watch{finished.length === 1 ? "" : "es"} ·{" "}
            <span className="mono">{rowsRead.toLocaleString()}</span> government records read across{" "}
            <span className="mono">{sourcesAsked}</span> source calls
          </p>
        </div>
        <Link href={`/h/${id}/add`} className="btn btn-quiet">
          Add a thing
        </Link>
      </header>

      {critical.length > 0 ? (
        <p className="bd-alarm">
          <strong>{critical.length === 1 ? "One thing in this home" : `${critical.length} things in this home`}</strong> is covered by a
          safety notice that names death or serious injury. It is below.
        </p>
      ) : null}

      <Watch
        householdId={id}
        things={fieldThings}
        open={question}
        hasRecording={Boolean(recording)}
        lastPassAt={household.lastPassAt}
        canRun={things.length > 0}
      />

      {live.length > 0 ? (
        <section className="bd-sec">
          <h2 className="bd-h2">
            What it found
            <span className="bd-count mono">{live.length}</span>
          </h2>
          <p className="bd-lede">
            Every word in the hazard and remedy lines below is lifted from the government record named beside it. Vigil does not
            write these; it finds them and tells you which of your things they are about.
          </p>
          <div className="bd-notices">
            {live.map((f) => (
              <Notice key={f.id} finding={f} thing={things.find((t) => t.id === f.thingId) ?? null} />
            ))}
          </div>
        </section>
      ) : things.length > 0 ? (
        <section className="bd-sec">
          <h2 className="bd-h2">Nothing is wrong</h2>
          <p className="bd-lede">
            Vigil has read <span className="mono">{rowsRead.toLocaleString()}</span> government records about these things and none of
            them is about yours. That is the answer nearly every night, and it is the reason the other night matters.
          </p>
        </section>
      ) : null}

      <section className="bd-sec">
        <h2 className="bd-h2">The nights</h2>
        <p className="bd-lede">One mark per watch. Almost all of them are quiet — that is the job.</p>
        <Nights passes={passes} />
      </section>

      <section className="bd-sec bd-cols">
        <div>
          <h2 className="bd-h2">What it is watching</h2>
          <ul className="bd-things">
            {things.map((t) => {
              const mine = findings.filter((f) => f.thingId === t.id && f.state !== "dismissed");
              return (
                <li key={t.id} className={mine.length ? "is-alarm" : ""}>
                  <p className="bd-thing-l">{t.label}</p>
                  <p className="bd-thing-m mono">
                    {[t.year, t.make, t.model].filter(Boolean).join(" ") || t.category || t.kind}
                    {t.identifier ? ` · ${t.identifier}` : ""}
                  </p>
                  {t.secondHand ? <p className="bd-thing-n">second-hand — on no manufacturer&rsquo;s owner list</p> : null}
                  {unknowns(t.unknowns).map((u) => (
                    <p key={u} className="bd-thing-u">
                      unknown: {u}
                    </p>
                  ))}
                </li>
              );
            })}
            {things.length === 0 ? (
              <li className="bd-empty">
                Nothing here yet. <Link href={`/h/${id}/add`}>Tell Vigil what is in your home.</Link>
              </li>
            ) : null}
          </ul>
        </div>
        <div>
          <h2 className="bd-h2">What you have told it</h2>
          {standing.length ? (
            <ul className="bd-rules">
              {standing.map((s) => (
                <li key={s.id}>
                  <span className="bd-rule-q">{s.text}</span>
                  <span className="bd-rule-d mono">{new Date(s.createdAt).toISOString().slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="bd-lede">
              Nothing yet. Every question you answer becomes a rule here, in your words, so the same question is never asked twice.
            </p>
          )}
        </div>
      </section>

      <footer className="bd-foot">
        <p>
          Sources: <a href="https://api.nhtsa.gov" rel="noreferrer">NHTSA recalls and complaints</a>,{" "}
          <a href="https://www.saferproducts.gov/RestWebServices/Recall?format=json" rel="noreferrer">CPSC</a>,{" "}
          <a href="https://api.fda.gov" rel="noreferrer">openFDA</a>. All public, all keyless — every endpoint Vigil called is printed
          on the pass it called it in.
        </p>
        <p>
          {passes[0] ? (
            <Link href={`/h/${id}/pass/${passes[0].id}`} className="bd-link">
              See everything the last watch asked →
            </Link>
          ) : null}
        </p>
      </footer>
    </main>
  );
}

function unknowns(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
