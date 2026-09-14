/**
 * Vigil's ground truth, live. `npx tsx --env-file=.env scripts/sources-smoke.ts [--cached]`
 *
 * Calls every federal source Vigil depends on and prints what came back: the exact URL, whether the
 * source answered, how many rows, how long it took. By default every call is `fresh` — the on-disk
 * cache is bypassed so the latencies are real. Exits 1 if any source failed, so it can gate a deploy.
 */
import {
  cpscRecent,
  isoDaysAgo,
  nhtsaComplaintsByVehicle,
  nhtsaDecodeVin,
  nhtsaRecallsByVehicle,
  nhtsaUnitsAffected,
  openFdaEnforcement,
  type SourceResult,
} from "../src/lib/sources";

/** `--cached` uses the on-disk cache, which is how you see "as of" report an older fetch time. */
// Piping into `head` closes stdout early; that is not a source failure.
process.stdout.on("error", () => {});

const fresh = !process.argv.includes("--cached");

interface Line {
  source: string;
  endpoint: string;
  ok: boolean;
  rows: number;
  latencyMs: number;
  /** What the UI would print as "as of": the moment the data was fetched, not the moment it was shown. */
  fetchedAt: number;
  error?: string;
  note?: string;
}

function line(res: SourceResult<unknown>, note?: string): Line {
  return { source: res.source, endpoint: res.endpoint, ok: res.ok, rows: res.rowCount, latencyMs: res.latencyMs, fetchedAt: res.fetchedAt, error: res.error, note };
}

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

(async () => {
  const results: Line[] = [];

  const recalls = await nhtsaRecallsByVehicle({ make: "honda", model: "accord", modelYear: 2019 }, { fresh });
  results.push(line(recalls, recalls.rows[0] ? `first: ${recalls.rows[0].campaignNumber} ${recalls.rows[0].component?.slice(0, 40)}` : undefined));

  const campaign = recalls.rows[0]?.campaignNumber ?? "20V314000";
  const units = await nhtsaUnitsAffected(campaign, { fresh });
  results.push(line(units.result, `campaign ${campaign} · potentialUnitsAffected ${units.units ?? "not stated"}`));

  const complaints = await nhtsaComplaintsByVehicle({ make: "honda", model: "accord", modelYear: 2019 }, { fresh });
  const withDeaths = complaints.rows.filter((r) => (r.numberOfDeaths ?? 0) > 0).length;
  results.push(line(complaints, `crash ${complaints.rows.filter((r) => r.crash).length} · fire ${complaints.rows.filter((r) => r.fire).length} · deaths reported in ${withDeaths}`));

  const vin = await nhtsaDecodeVin("1HGCV1F34KA123456", { fresh });
  const v = vin.rows[0];
  results.push(line(vin, v ? `${v.modelYear ?? "?"} ${v.make ?? "?"} ${v.model ?? "?"} · ErrorCode ${v.errorCode ?? "-"}` : undefined));

  const since = isoDaysAgo(180);
  const cpsc = await cpscRecent(since, { fresh });
  results.push(line(cpsc, `since ${since}${cpsc.rows[0] ? ` · newest ${cpsc.rows[0].recallDate?.slice(0, 10)} ${cpsc.rows[0].title?.slice(0, 40)}` : ""}`));

  const fda = await openFdaEnforcement({ domain: "food", terms: ["infant formula"], limit: 10 }, { fresh });
  results.push(line(fda, fda.rows[0] ? `first: ${fda.rows[0].recallNumber} ${fda.rows[0].classification}` : "no matches (openFDA answers 404 for zero results)"));

  const w = { source: 17, endpoint: 56, ok: 4, rows: 6, ms: 7, asOf: 8 };
  console.log("");
  console.log(`${pad("source", w.source)}  ${pad("endpoint", w.endpoint)}  ${pad("ok", w.ok)}  ${"rows".padStart(w.rows)}  ${"ms".padStart(w.ms)}  ${pad("as of", w.asOf)}`);
  console.log("-".repeat(w.source + w.endpoint + w.ok + w.rows + w.ms + w.asOf + 10));
  for (const r of results) {
    console.log(
      `${pad(r.source, w.source)}  ${pad(r.endpoint.replace(/^https:\/\//, ""), w.endpoint)}  ${pad(r.ok ? "yes" : "NO", w.ok)}  ${String(r.rows).padStart(w.rows)}  ${String(r.latencyMs).padStart(w.ms)}  ${pad(new Date(r.fetchedAt).toISOString().slice(11, 19), w.asOf)}`,
    );
  }
  console.log("");
  for (const r of results) {
    if (r.note) console.log(`  ${r.source}: ${r.note}`);
    if (r.error) console.log(`  ${r.source}: FAILED — ${r.error}`);
  }
  console.log("");
  console.log("full endpoints (curl these):");
  for (const r of results) console.log(`  ${r.endpoint}`);
  console.log("");

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log(`${failed.length} of ${results.length} sources did not answer.`);
    process.exit(1);
  }
  console.log(`all ${results.length} calls answered.`);
})();
