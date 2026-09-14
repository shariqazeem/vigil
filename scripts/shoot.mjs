/**
 * THE DEMO, FILMED AGAINST PRODUCTION.
 *
 * This does not stage anything. It stops a real service on the real VM, waits for Warden's own
 * probe to notice, and records the live console while the agent investigates, decides, acts and
 * re-runs the check. Everything on screen is the deployed instance at its public URL.
 *
 *   node scripts/shoot.mjs                     # every scene
 *   node scripts/shoot.mjs --only incident     # just the one that matters
 *   node scripts/shoot.mjs --keep-broken       # leave the service down afterwards
 *
 * Playwright is borrowed from a sibling checkout rather than added as a dependency — this is a
 * recording tool, not part of the product. Point PLAYWRIGHT_FROM elsewhere if needed.
 *
 * Output: var/shots/<scene>.webm and .png. Convert with:
 *   ffmpeg -i var/shots/incident.webm -c:v libx264 -crf 18 -pix_fmt yuv420p var/shots/incident.mp4
 */
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const run = promisify(execFile);
const require_ = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_FROM ?? "/Users/macbookair/projects/SAGE/node_modules/playwright";
let chromium;
try {
  ({ chromium } = require_(PW));
} catch {
  console.error(`Playwright not found at ${PW}. Set PLAYWRIGHT_FROM to a checkout that has it.`);
  process.exit(1);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? (process.argv[i + 1]?.startsWith("--") ? true : (process.argv[i + 1] ?? true)) : fallback;
};
const BASE = String(arg("base", "https://warden.80.225.209.190.sslip.io")).replace(/\/$/, "");
const ONLY = arg("only", null);
const KEEP_BROKEN = arg("keep-broken", false);
const TARGET = String(arg("service", "vigil"));
const OUT = join(process.cwd(), "var", "shots");
const SIZE = { width: 1512, height: 945 };

const KEY = process.env.WARDEN_SSH_KEY ?? `${process.env.HOME}/Documents/ssh-key3.key`;
const HOST = process.env.WARDEN_HOST_SSH ?? "ubuntu@80.225.209.190";
const DIR = "/home/ubuntu/warden";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run something on the VM. Nothing here is one of Warden's operations — Warden cannot stop a service. */
async function vm(command) {
  const { stdout } = await run(
    "ssh",
    ["-i", KEY, "-o", "StrictHostKeyChecking=no", "-o", "BatchMode=yes", HOST, "--", `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 22 >/dev/null 2>&1; ${command}`],
    { timeout: 600_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout.trim();
}

async function scene(name, body) {
  if (ONLY && ONLY !== name) return;
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: SIZE, deviceScaleFactor: 2, recordVideo: { dir: OUT, size: SIZE }, colorScheme: "light" });
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await body(page);
  } catch (e) {
    console.error(`  ${name}: ${e.message}`);
  }
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  const video = page.video();
  await ctx.close();
  await browser.close();
  // Playwright names videos by a content hash; save each under its scene name so an edit does not
  // begin by guessing which of four hashes is the one with the incident in it.
  if (video) {
    const to = join(OUT, `${name}.webm`);
    await video.saveAs(to);
    await video.delete().catch(() => {});
    console.log(`  ${name}: ${Math.round((Date.now() - t0) / 1000)}s → ${to}`);
  }
}

async function readDown(page, px, step = 90, pause = 90) {
  for (let y = 0; y < px; y += step) {
    await page.mouse.wheel(0, step);
    await sleep(pause);
  }
}

/* ── 1. everything is fine, and that is the point ─────────────────── */

await scene("quiet", async (page) => {
  await vm(`cd ${DIR} && pm2 start ${TARGET} >/dev/null 2>&1; npx tsx --env-file=.env scripts/sweep.ts >/dev/null 2>&1; true`);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 120_000 });
  await sleep(3500);
  await readDown(page, 1600);
  await sleep(1500);
});

/* ── 2. something breaks, for real ────────────────────────────────── */

await scene("breaks", async (page) => {
  console.log("  stopping the sweep so the recording gets there first…");
  await vm("pm2 stop warden-sweep >/dev/null 2>&1; true");
  console.log(`  stopping ${TARGET} on the VM…`);
  await vm(`pm2 stop ${TARGET} >/dev/null 2>&1; true`);
  // Warden's own probe has to notice. Two consecutive failures open the incident.
  console.log("  running two sweeps so its own probe notices…");
  await vm(`cd ${DIR} && WARDEN_AUTO_HANDLE=0 npx tsx --env-file=.env scripts/sweep.ts 2>&1 | tail -3`);
  await vm(`cd ${DIR} && WARDEN_AUTO_HANDLE=0 npx tsx --env-file=.env scripts/sweep.ts 2>&1 | tail -3`);
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 120_000 });
  await sleep(4000);
  await readDown(page, 1200);
  await sleep(2000);
});

/* ── 3. the whole loop, live ──────────────────────────────────────── */

await scene("incident", async (page) => {
  const id = await vm(
    `cd ${DIR} && npx tsx --env-file=.env -e "import('./src/lib/db/warden.ts').then(m=>{const i=m.openIncidents().find(x=>x.title.toLowerCase().includes('${TARGET}')&&x.title.includes('site'))||m.openIncidents()[0];console.log(i?i.id:'')})" 2>/dev/null | tail -1`,
  );
  if (!id) throw new Error("no open incident to film — run the `breaks` scene first");
  console.log(`  incident ${id}`);
  await page.goto(`${BASE}/i/${id}`, { waitUntil: "networkidle", timeout: 120_000 });
  await sleep(3000);
  const go = page.getByRole("button", { name: /hand it to warden/i });
  if (!(await go.count())) throw new Error("nothing to hand over — the incident may already be resolved");
  // The button is a client island: wait for hydration, or the click lands on static HTML and
  // nothing happens — which is exactly how the first take of this was silently empty.
  await go.first().waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(2500);
  await go.first().click();
  await page.locator(".chip", { hasText: /warden is working/i }).waitFor({ timeout: 30_000 });
  // The run is minutes: the investigation, the policy decision, the act, the verification.
  for (let i = 0; i < 60; i += 1) {
    await sleep(5000);
    const done = await page.locator(".chip", { hasText: /finished|waiting on you/i }).count();
    if (done) break;
  }
  await sleep(4000);
  await readDown(page, 2400, 80, 80);
  await sleep(2500);
});

/* ── 4. the receipt: every command, and the rule that permitted it ── */

await scene("audit", async (page) => {
  const id = await vm(
    `cd ${DIR} && npx tsx --env-file=.env -e "import('./src/lib/db/warden.ts').then(m=>{const i=m.recentIncidents(20).find(x=>x.status==='resolved');console.log(i?i.id:'')})" 2>/dev/null | tail -1`,
  );
  if (!id) throw new Error("no resolved incident to show yet");
  await page.goto(`${BASE}/i/${id}`, { waitUntil: "networkidle", timeout: 120_000 });
  await sleep(2500);
  await readDown(page, 2800, 70, 70);
  await sleep(2500);
});

if (!KEEP_BROKEN) {
  console.log("  restoring: starting the service and the sweep…");
  await vm(`pm2 start ${TARGET} >/dev/null 2>&1; pm2 start warden-sweep >/dev/null 2>&1; true`);
}
console.log(`\nstills and video in ${OUT}`);
