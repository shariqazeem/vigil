import Link from "next/link";
import type { Pass } from "@/lib/db/schema";

/**
 * THE NIGHTS. One mark per watch, oldest on the left.
 *
 * This is the only picture in the product of the thing the product actually is: a long row of
 * nights when nothing happened, and the one where something did. Every mark's height is the number
 * of government records that watch read, so a quiet night is still a tall mark — Vigil looked, and
 * looking is the work. A red mark is a watch that found something; an amber one stopped to ask.
 */
export function Nights({ passes }: { passes: Pass[] }) {
  const ordered = [...passes].reverse();
  const max = Math.max(1, ...ordered.map((p) => p.rowsSeen));
  const quiet = ordered.filter((p) => p.status === "clean").length;
  const found = ordered.filter((p) => p.status === "found").length;

  return (
    <div className="ng">
      <ol className="ng-row">
        {ordered.map((p) => {
          const h = 14 + Math.round((p.rowsSeen / max) * 72);
          const state = p.status === "found" ? "found" : p.status === "interrupted" ? "asked" : p.status === "failed" ? "failed" : "quiet";
          return (
            <li key={p.id} className={`ng-mark is-${state}`}>
              <Link href={`/h/${p.householdId}/pass/${p.id}`} style={{ height: `${h}px` }} aria-label={`${state} watch, ${p.rowsSeen} records read`}>
                <span className="ng-tip mono">
                  {new Date(p.startedAt).toISOString().slice(0, 16).replace("T", " ")} · {p.rowsSeen.toLocaleString()} records ·{" "}
                  {p.sourcesOk} sources{p.sourcesFailed ? ` · ${p.sourcesFailed} failed` : ""}
                </span>
              </Link>
            </li>
          );
        })}
        {ordered.length === 0 ? <li className="ng-none">no watches yet</li> : null}
      </ol>
      {ordered.length > 0 ? (
        <p className="ng-legend mono">
          <span className="is-quiet">{quiet} quiet</span>
          {found ? <span className="is-found">{found} found something</span> : null}
          <span className="is-note">height = records read that night</span>
        </p>
      ) : null}
    </div>
  );
}
