/**
 * The watch, from a terminal. `seed` builds a household out of ordinary things; `run` does a pass
 * over it and prints every single thing the agent does as it happens — the same event stream the
 * board draws from, so what you see here and what a person sees on screen cannot drift apart.
 *
 *   npx tsx --env-file=.env scripts/pass.ts seed [demo]
 *   npx tsx --env-file=.env scripts/pass.ts run <householdId>
 *   npx tsx --env-file=.env scripts/pass.ts show <householdId>
 *   npx tsx --env-file=.env scripts/pass.ts answer <decisionId> <yes|no|unknown>
 */
import { addThing, createHousehold, getBoard, listHouseholds, openDecisions, parseOptions } from "../src/lib/db/vigil";
import { nhtsaDecodeVin } from "../src/lib/sources";
import { runPass, resumeWithAnswer } from "../src/agent/watch";
import type { PassEmit } from "../src/agent/pass-context";

const arg = (n: number) => process.argv[n + 2];
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;

function print(e: PassEmit): void {
  switch (e.kind) {
    case "pass.start": return void console.log(bold(`\n▌ pass ${e.passId} · ${e.things} things · ${e.model}\n`));
    case "node.start": return void console.log(bold(`\n▶ ${e.node}`) + dim(` — ${e.label}`));
    case "node.done": return void console.log(dim(`  ${e.node} ${e.status} in ${e.ms}ms`));
    case "plan": return void console.log(`  plan  ${e.thingId} → ${e.sources.join(", ") || dim("nothing can know")} ${dim(e.why)}`);
    case "check.start": return void console.log(dim(`  →     ${e.source}  ${e.endpoint}`));
    case "check.done":
      return void console.log(
        `  ${e.ok ? green("✓") : red("✗")}     ${e.source.padEnd(18)} ${String(e.rows).padStart(5)} rows  ${String(e.ms).padStart(6)}ms${e.error ? red(`  ${e.error}`) : ""}`,
      );
    case "cluster": return void console.log(amber(`  ~     cluster ${e.component} × ${e.count}`));
    case "match": return void console.log(`  ${e.verdict === "covers" ? red("!") : e.verdict === "unsure" ? amber("?") : dim("·")}     ${e.sourceId} ${e.verdict} ${Math.round(e.confidence * 100)}% ${dim(e.reason.slice(0, 120))}`);
    case "finding": return void console.log(red(bold(`  ⬤ FINDING ${e.sourceId} [${e.severity}] ${e.title}`)));
    case "decision": return void console.log(amber(bold(`  ⏸ STOPPED — ${e.question}`)) + dim(`  (${e.decisionId})`));
    case "pass.done": return void console.log(bold(`\n▌ ${e.status} · ${e.findings} findings · ${e.rows} candidate rows · ${e.ms}ms · ${e.unchecked} unchecked\n`));
    case "error": return void console.log(red(`  ✗ ${e.message}`));
    default: return;
  }
}

async function main() {
  const cmd = arg(0) ?? "show";

  if (cmd === "seed") {
    const ownerKey = arg(1) === "demo" ? "demo" : `anon:cli`;
    const h = createHousehold({ ownerKey, name: "The Aslam house", place: "a two-bedroom flat with a nine-month-old in it" });
    // The VIN is decoded by NHTSA, exactly as intake does it — no seeded facts about the car.
    const VIN = "1HGCV1F34KA000000";
    const vin = await nhtsaDecodeVin(VIN);
    const v = vin.rows[0];
    addThing(h.id, {
      kind: "vehicle",
      label: "The car",
      make: v?.make ?? "HONDA",
      model: v?.model ?? "Accord",
      year: v?.modelYear ? Number(v.modelYear) : 2019,
      identifier: VIN,
      category: v?.bodyClass ?? "passenger car",
      decoded: v?.raw,
      addedVia: "vin",
    });
    console.log(`  VIN decoded by NHTSA: ${v?.modelYear} ${v?.make} ${v?.model} · ${v?.bodyClass}`);
    addThing(h.id, { kind: "product", label: "The dresser in Ayesha's room", make: "Mainstays", model: "9-Drawer Fabric Dresser", category: "clothing storage unit", secondHand: true, confidence: 0.8, unknowns: ["the manufacture date label under the top panel has not been checked"], note: "Came from my sister when she moved. Walmart, a couple of years old." });
    addThing(h.id, { kind: "product", label: "The baby monitor", make: "Babysense", model: "Max View VBM55", category: "baby monitor" });
    addThing(h.id, { kind: "ingestible", label: "The melatonin gummies", make: "vitafusion", model: "Melatonin", category: "dietary supplement" });
    console.log(`household ${h.id}  (owner ${ownerKey})`);
    console.log(`\nnpx tsx --env-file=.env scripts/pass.ts run ${h.id}`);
    return;
  }

  if (cmd === "run") {
    const hid = arg(1) ?? listHouseholds("anon:cli")[0]?.id;
    if (!hid) throw new Error("no household — run seed first");
    const out = await runPass(hid, "manual", print);
    console.log(bold("summary: ") + out.summary);
    const open = openDecisions(hid);
    for (const d of open) console.log(amber(`\nwaiting: ${d.id}\n  ${d.question}\n  ${parseOptions(d).map((o) => o.value).join(" | ")}`));
    return;
  }

  if (cmd === "answer") {
    const did = arg(1)!;
    const out = await resumeWithAnswer(did, arg(2) ?? "yes", undefined, print);
    console.log(bold("summary: ") + out.summary);
    return;
  }

  const hid = arg(1) ?? listHouseholds("anon:cli")[0]?.id ?? listHouseholds("demo")[0]?.id;
  if (!hid) return void console.log("no households yet");
  const b = getBoard(hid)!;
  console.log(bold(`${b.household.name}`) + dim(` · ${b.things.length} things · ${b.passes.length} passes`));
  for (const t of b.things) console.log(`  ${t.label.padEnd(30)} ${[t.year, t.make, t.model].filter(Boolean).join(" ")}`);
  for (const f of b.findings) console.log(red(`  ⬤ ${f.sourceId} [${f.severity}] ${f.title}`) + dim(`\n     ${(f.consequence ?? "").slice(0, 160)}`));
  for (const d of b.decisions) console.log(amber(`  ⏸ ${d.id} ${d.question}`) + (d.answer ? green(` → ${d.answer}`) : ""));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
