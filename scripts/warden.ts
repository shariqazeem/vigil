/**
 * Warden from a terminal — the same code the console runs, printed as it happens.
 *
 *   npx tsx --env-file=.env scripts/warden.ts register            # the fleet on the VM
 *   npx tsx --env-file=.env scripts/warden.ts sweep               # ask every probe once
 *   npx tsx --env-file=.env scripts/warden.ts handle <incidentId> # work one incident
 *   npx tsx --env-file=.env scripts/warden.ts answer <decId> approve
 *   npx tsx --env-file=.env scripts/warden.ts policy <svcId> may|ask|observe
 *   npx tsx --env-file=.env scripts/warden.ts show
 *   npx tsx --env-file=.env scripts/warden.ts break <svcId>       # stop a service on purpose
 */
import {
  addProbe,
  addService,
  allServices,
  getService,
  listIncidents,
  listProbes,
  listServices,
  openIncidents,
  parseOptions,
  pendingDecisions,
  readingsFor,
  serviceView,
  targetOf,
  touchService,
} from "../src/lib/db/warden";
import { ASK_BEFORE_ACTING, DEFAULT_POLICY, OBSERVE_ONLY } from "../src/lib/ops/policy";
import { execute } from "../src/lib/ops/operations";
import { sweepService, type SweepEmit } from "../src/lib/ops/sweep";
import { handleIncident, resumeWithAnswer } from "../src/agent/warden";
import type { WardenEmit } from "../src/agent/incident-context";

const arg = (n: number) => process.argv[n + 2];
const OWNER = process.env.WARDEN_OWNER ?? "demo";
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  b: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  amber: (s: string) => `\x1b[33m${s}\x1b[0m`,
  blue: (s: string) => `\x1b[34m${s}\x1b[0m`,
};

function print(e: WardenEmit | SweepEmit): void {
  switch (e.kind) {
    case "run.start": return void console.log(c.b(`\n▌ ${e.title}`) + c.dim(`  ${e.incidentId} · ${e.model}\n`));
    case "node.start": return void console.log(c.b(`\n▶ ${e.node}`) + c.dim(` — ${e.label}`));
    case "node.done": return void console.log(c.dim(`  ${e.node} ${e.status} in ${e.ms}ms`));
    case "probe.start": return void console.log(c.dim(`  →  ${e.label}  ${e.command}`));
    case "probe.done": return void console.log(`  ${e.ok ? c.green("✓") : c.red("✗")}  ${e.label.padEnd(26)} ${e.detail.slice(0, 90)} ${c.dim(`${e.ms}ms`)}`);
    case "incident.open": return void console.log(c.red(c.b(`  ⬤ INCIDENT ${e.title}`)) + c.dim(`\n     ${e.symptom}  (${e.incidentId})`));
    case "incident.resolved": return void console.log(c.green(c.b(`  ✓ RESOLVED after ${e.downSeconds}s`)));
    case "sweep.note": return void console.log(c.dim(`  ·  ${e.message}`));
    case "look": return void console.log(c.blue(`  ?  ${e.op}`) + c.dim(`  ${e.command}   — ${e.why}`));
    case "looked": return void console.log(c.dim(`     ${e.ok ? "" : "(failed) "}${e.summary.replace(/\n/g, " ").slice(0, 130)}`));
    case "diagnosis": return void console.log(c.b(`\n  ◆ DIAGNOSIS ${Math.round(e.confidence * 100)}%`) + (e.suspect ? c.dim(`  suspect ${e.suspect}`) : "") + `\n    ${e.text.replace(/\n/g, "\n    ").slice(0, 500)}\n`);
    case "policy": return void console.log((e.verdict === "allow" ? c.green : e.verdict === "ask" ? c.amber : c.red)(`  § policy ${e.verdict}`) + c.dim(`  ${e.op} · ${e.rule} — ${e.reason.slice(0, 110)}`));
    case "act": return void console.log(c.amber(c.b(`  ⚙ ACT ${e.op}`)) + c.dim(`  ${e.command}\n     ${e.why}`));
    case "acted": return void console.log(`     ${e.ok ? c.green("done") : c.red("failed")} ${c.dim(`${e.ms}ms · ${e.summary.replace(/\n/g, " ").slice(0, 110)}`)}`);
    case "verify": return void console.log((e.ok ? c.green : c.red)(c.b(`  ⟳ VERIFY ${e.label}: ${e.ok ? "passes" : "still failing"}`)) + c.dim(` — ${e.detail.slice(0, 90)}`));
    case "decision": return void console.log(c.amber(c.b(`\n  ⏸ STOPPED — ${e.question}`)) + c.dim(`\n     because: ${e.because ?? ""}\n     ${e.decisionId}\n`));
    case "run.done": return void console.log(c.b(`\n▌ ${e.status}`) + `  ${e.summary}\n`);
    case "error": return void console.log(c.red(`  ✗ ${e.message}`));
    default: return;
  }
}

const KEY = process.env.WARDEN_SSH_KEY ?? `${process.env.HOME}/Documents/ssh-key3.key`;
const HOST = process.env.WARDEN_HOST ?? "ubuntu@80.225.209.190";
const NODE22 = "/home/ubuntu/.nvm/versions/node/v22.23.2/bin/node";

async function register() {
  if (listServices(OWNER).length) {
    console.log("already registered. `reset` first if you want them back.");
    return;
  }
  const fleet = [
    {
      name: "Warden's own console",
      matters: "If this is down, nobody can see what any of the others are doing — including this incident.",
      process: "warden",
      repo: "/home/ubuntu/warden",
      url: "https://getwarden.vercel.app/",
      // It may diagnose itself, but not restart itself unasked: an operator that reboots the
      // machine it is reasoning on loses the run it was in the middle of.
      policy: ASK_BEFORE_ACTING,
    },
    {
      name: "Vigil",
      matters: "A public site. If it is down, visitors get nothing.",
      process: "vigil",
      repo: "/home/ubuntu/vigil",
      url: "https://vigil.80.225.209.190.sslip.io/",
      policy: DEFAULT_POLICY,
    },
    {
      name: "SAGE",
      matters: "Someone else's production, and it is submitted to two competitions. Warden watches it and touches nothing.",
      process: "sage",
      repo: "/home/ubuntu/sage",
      url: "https://sagepays.xyz/",
      policy: OBSERVE_ONLY,
    },
  ];

  for (const f of fleet) {
    const svc = addService({
      ownerKey: OWNER,
      name: f.name,
      matters: f.matters,
      host: HOST,
      sshKey: KEY,
      repo: f.repo,
      process: f.process,
      nodeBin: NODE22,
      policy: f.policy,
    });
    addProbe({ serviceId: svc.id, kind: "http", label: "the site answers", spec: { url: f.url, expectStatus: 200 }, everySeconds: 120, failuresToOpen: 2 });
    addProbe({ serviceId: svc.id, kind: "process", label: "the process is up", spec: { process: f.process }, everySeconds: 120, failuresToOpen: 1 });
    console.log(`${svc.id}  ${svc.name}  ${c.dim(f.policy === OBSERVE_ONLY ? "observe only" : f.policy === ASK_BEFORE_ACTING ? "asks before acting" : "may restart itself")}`);
  }
}

async function main() {
  const cmd = arg(0) ?? "show";

  if (cmd === "register") return register();

  if (cmd === "sweep") {
    for (const s of allServices()) {
      console.log(c.b(`\n▌ ${s.name}`) + c.dim(`  ${s.host}`));
      const r = await sweepService(s, print);
      for (const i of r.opened) console.log(c.red(`   → handle it:  npx tsx --env-file=.env scripts/warden.ts handle ${i.id}`));
    }
    return;
  }

  if (cmd === "handle") {
    const iid = arg(1) ?? openIncidents()[0]?.id;
    if (!iid) return void console.log("no open incidents");
    const out = await handleIncident(iid, print);
    for (const d of pendingDecisions()) console.log(c.amber(`\nwaiting: ${d.id}\n  ${d.question}\n  ${parseOptions(d).map((o) => o.value).join(" | ")}`));
    console.log(c.dim(`\n${out.status}`));
    return;
  }

  if (cmd === "answer") {
    const out = await resumeWithAnswer(arg(1)!, arg(2) ?? "approve", arg(3), print);
    console.log(c.dim(`\n${out.status}`));
    return;
  }

  if (cmd === "policy") {
    // Change what a service's owner permits, without re-registering it. The three named postures are
    // the ones in src/lib/ops/policy.ts; anything finer is written in that file, not typed here.
    const svc = getService(arg(1) ?? "");
    if (!svc) return void console.log("no such service — run `show` for the ids");
    const named: Record<string, typeof DEFAULT_POLICY> = { may: DEFAULT_POLICY, ask: ASK_BEFORE_ACTING, observe: OBSERVE_ONLY };
    const next = named[arg(2) ?? ""];
    if (!next) return void console.log("posture must be one of: may | ask | observe");
    touchService(svc.id, { policy: JSON.stringify(next) });
    console.log(`${svc.name} → ${c.b(arg(2)!)}  ${c.dim(next.note)}`);
    return;
  }

  if (cmd === "break") {
    // Stop a service on purpose, so there is a real failure to find. This is a demo tool and it is
    // deliberately NOT one of Warden's operations — Warden cannot stop anything.
    const svc = getService(arg(1) ?? "") ?? allServices().find((s) => s.name === "Vigil");
    if (!svc) return void console.log("no such service");
    const res = await execute("pm2_list", {}, targetOf(svc));
    console.log(res.ok ? c.dim("pm2 reachable") : c.red(res.error ?? "pm2 unreachable"));
    console.log(c.amber(`\nNow, on the VM:  pm2 stop ${svc.process}\nThen:            npx tsx --env-file=.env scripts/warden.ts sweep`));
    return;
  }

  // show
  for (const s of allServices()) {
    const v = serviceView(s.id)!;
    const open = v.open.length;
    console.log(c.b(`\n${s.name}`) + c.dim(`  ${s.id} · ${s.host}`) + (open ? c.red(`  ${open} open`) : c.green("  all clear")));
    for (const p of listProbes(s.id)) {
      const last = readingsFor(p.id, 1)[0];
      const hist = readingsFor(p.id, 40);
      const up = hist.length ? Math.round((hist.filter((r) => r.ok).length / hist.length) * 100) : 0;
      console.log(`  ${last ? (last.ok ? c.green("✓") : c.red("✗")) : c.dim("·")} ${p.label.padEnd(24)} ${c.dim(`${hist.length ? `${up}% of ${hist.length} looks` : "never looked"}  ${last?.detail.slice(0, 60) ?? ""}`)}`);
    }
    for (const i of listIncidents(s.id, 6)) {
      const tag = i.status === "resolved" ? c.green(`resolved in ${i.downSeconds}s`) : c.red(i.status);
      console.log(`  ${i.id} ${tag} ${c.dim(i.title.slice(0, 70))}`);
    }
  }
  for (const d of pendingDecisions()) console.log(c.amber(`\n⏸ ${d.id}  ${d.question}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
