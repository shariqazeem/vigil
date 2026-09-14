/**
 * THE SWEEP. The part that makes Vigil a watch rather than a button.
 *
 * pm2 runs this on a cron with nobody present. It picks every household whose last look is older
 * than the gap and does a pass over it — which is the whole product: a recall on the thing in your
 * child's room may be published four years after you bought it, and nobody is going to remember to
 * check. A pass that stops to ask a human stays stopped; it is not retried until they answer.
 *
 *   npx tsx --env-file=.env scripts/sweep.ts
 */
import { householdsDueForPass, logEvent, openDecisions } from "../src/lib/db/vigil";
import { runPass } from "../src/agent/watch";
import type { PassEmit } from "../src/agent/pass-context";

const GAP_HOURS = Number(process.env.VIGIL_WATCH_GAP_HOURS ?? 20);
const MAX_PER_SWEEP = Number(process.env.VIGIL_MAX_PER_SWEEP ?? 6);

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);

async function main() {
  const due = householdsDueForPass(GAP_HOURS).slice(0, MAX_PER_SWEEP);
  console.log(`[${stamp()}] sweep: ${due.length} household(s) due (gap ${GAP_HOURS}h)`);

  for (const h of due) {
    // A household already waiting on a human is not woken again. The question is the work.
    const waiting = openDecisions(h.id);
    if (waiting.length > 0) {
      console.log(`  ${h.id} ${h.name}: skipped — waiting on an answer since ${new Date(waiting[0]!.createdAt).toISOString().slice(0, 16)}`);
      continue;
    }

    const seen: Record<string, number> = {};
    const note = (e: PassEmit) => {
      seen[e.kind] = (seen[e.kind] ?? 0) + 1;
      if (e.kind === "finding") console.log(`    FOUND ${e.sourceId} [${e.severity}] ${e.title.slice(0, 90)}`);
      if (e.kind === "decision") console.log(`    STOPPED — ${e.question.slice(0, 110)}`);
      if (e.kind === "error") console.log(`    error: ${e.message.slice(0, 140)}`);
    };

    const t0 = Date.now();
    try {
      const out = await runPass(h.id, "cron", note);
      console.log(`  ${h.id} ${h.name}: ${out.status} · ${out.findings} finding(s) · ${out.questions} question(s) · ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.log(`  ${h.id} ${h.name}: FAILED ${message.slice(0, 160)}`);
      logEvent(h.id, "system", "sweep.failed", message);
    }
  }
  console.log(`[${stamp()}] sweep done`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
