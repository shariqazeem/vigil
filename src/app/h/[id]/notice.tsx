import type { Finding, Thing } from "@/lib/db/schema";

/**
 * A finding, set like the notice it is. The record number is the loudest thing on the card after
 * the hazard, because it is the part you can check: type it into the agency's own search and the
 * same words come back.
 *
 * The division is deliberate and it is the product's honesty made visible. Above the rule, the
 * government's words — quoted, never paraphrased, never summarised by a model. Below it, in smaller
 * type and clearly attributed, Vigil's own sentence about why this record is about YOUR unit. A
 * reader can always tell which is which.
 */
export function Notice({ finding, thing }: { finding: Finding; thing: Thing | null }) {
  const agency =
    finding.source === "nhtsa-recalls" ? "NHTSA" : finding.source === "nhtsa-complaints" ? "NHTSA · owner complaints" : finding.source === "cpsc-recalls" ? "CPSC" : "FDA";
  const isPattern = finding.kind === "pattern";

  return (
    <article className={`nt is-${finding.severity} ${isPattern ? "is-pattern" : ""}`}>
      <header className="nt-head">
        <p className="nt-id mono">{finding.sourceId}</p>
        <p className="nt-agency mono">{agency}</p>
        <p className={`nt-sev mono is-${finding.severity}`}>
          {finding.severity === "critical" ? "serious injury or death" : finding.severity === "high" ? "safety recall" : "watch"}
        </p>
      </header>

      <h3 className="nt-title serif">{finding.title}</h3>

      {thing ? (
        <p className="nt-thing">
          on <strong>{thing.label}</strong>
          {[thing.year, thing.make, thing.model].filter(Boolean).length ? (
            <span className="mono"> · {[thing.year, thing.make, thing.model].filter(Boolean).join(" ")}</span>
          ) : null}
        </p>
      ) : null}

      {finding.consequence ? (
        <blockquote className="nt-hazard">
          <p>{finding.consequence}</p>
          <cite className="mono">— {isPattern ? "counted from the complaint records themselves" : `${agency}, verbatim`}</cite>
        </blockquote>
      ) : null}

      {finding.remedy ? (
        <div className="nt-remedy">
          <p className="nt-remedy-k mono">what to do</p>
          <p>{finding.remedy}</p>
        </div>
      ) : null}

      <dl className="nt-facts mono">
        {finding.component ? (
          <div>
            <dt>part</dt>
            <dd>{finding.component}</dd>
          </div>
        ) : null}
        {finding.unitsAffected ? (
          <div>
            <dt>units affected</dt>
            <dd>{finding.unitsAffected.toLocaleString()}</dd>
          </div>
        ) : null}
        <div>
          <dt>found</dt>
          <dd>{new Date(finding.createdAt).toISOString().slice(0, 10)}</dd>
        </div>
      </dl>

      {finding.matchReason ? (
        <div className="nt-why">
          <p className="nt-why-k mono">why Vigil says this is yours · {Math.round(finding.confidence * 100)}% sure</p>
          <p>{finding.matchReason}</p>
        </div>
      ) : null}

      {finding.sourceUrl ? (
        <a className="nt-src mono" href={finding.sourceUrl} target="_blank" rel="noreferrer">
          read the record at {agency} →
        </a>
      ) : null}
    </article>
  );
}
