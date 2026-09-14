/**
 * THE SWEEP, on a clock. What makes Warden a watch rather than a button.
 *
 * pm2 runs this every few minutes with nobody present. It asks every probe on every service, opens
 * an incident when something has failed twice in a row, and — this is the part that matters — hands
 * the new incident straight to the agent. Nobody is woken up. Most nights it writes a row saying
 * everything answered, and that is the product working.
 *
 *   npx tsx --env-file=.env scripts/sweep.ts
 */
import { allServices, autoRunsToday, logEvent, openIncidents, pendingDecisions } from "../src/lib/db/warden";
import { sweepService } from "../src/lib/ops/sweep";
import { handleIncident } from "../src/agent/warden";

const AUTO = process.env.WARDEN_AUTO_HANDLE !== "0";
/**
 * A ceiling on how many incidents Warden takes on by itself, per owner, per day. Not a licence
 * limit — a bound on what a URL that is always down can cost. Past it, the incident still opens and
 * still sits on the board with a "Hand it to Warden" button; only the unattended part stops.
 */
const DAILY = Number(process.env.WARDEN_AUTO_HANDLE_DAILY ?? 40);
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

async function main() {
  const services = allServices().filter((s) => s.state === "watching");
  console.log(`[${stamp()}] sweep: ${services.length} service(s)`);

  for (const service of services) {
    const waiting = pendingDecisions(service.id);
    if (waiting.length) {
      console.log(`  ${service.name}: waiting on an answer since ${new Date(waiting[0]!.createdAt).toISOString().slice(0, 16)} — not touching it`);
      continue;
    }

    const r = await sweepService(service, (e) => {
      if (e.kind === "probe.done" && !e.ok) console.log(`  ${service.name} · ${e.label}: ${e.detail}`);
      if (e.kind === "incident.open") console.log(`  ${service.name}: INCIDENT ${e.title} — ${e.symptom}`);
      if (e.kind === "incident.resolved") console.log(`  ${service.name}: back after ${e.downSeconds}s`);
    });

    if (!AUTO) continue;
    for (const incident of r.opened) {
      const used = autoRunsToday(service.ownerKey);
      if (used >= DAILY) {
        console.log(`  ${service.name}: ${used} runs in the last day is the ceiling — ${incident.id} is open and waiting for a person`);
        logEvent(service.id, "system", "auto.capped", `Warden has investigated ${used} incidents for this owner in a day. ${incident.id} was left for a person to hand over.`, incident.id);
        continue;
      }
      console.log(`  → handing ${incident.id} to Warden`);
      try {
        const out = await handleIncident(incident.id, (e) => {
          if (e.kind === "diagnosis") console.log(`     diagnosis ${Math.round(e.confidence * 100)}%: ${e.text.split("\n")[0]!.slice(0, 140)}`);
          if (e.kind === "policy") console.log(`     policy ${e.verdict} ${e.op} (${e.rule})`);
          if (e.kind === "acted") console.log(`     ${e.op} ${e.ok ? "done" : "failed"}`);
          if (e.kind === "verify") console.log(`     verify: ${e.ok ? "passes" : "still failing"} — ${e.detail}`);
          if (e.kind === "decision") console.log(`     STOPPED — ${e.question}`);
        });
        console.log(`  ${incident.id}: ${out.status} · ${out.summary}`);
      } catch (e) {
        console.log(`  ${incident.id}: FAILED ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const still = openIncidents();
  console.log(`[${stamp()}] done · ${still.length} still open · ${pendingDecisions().length} waiting on a human`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
