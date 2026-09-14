/**
 * THE FOOTAGE. Drives a real Vigil and records it, so the demo video is the product working rather
 * than a slideshow about it.
 *
 * It does not fake anything: it clicks the same buttons a person clicks, waits for the same server
 * events, and records whatever actually happens — including the waiting. Timings are generous
 * because a real federal API is at the other end.
 *
 *   node scripts/shoot.mjs                      # every scene, against http://localhost:3100
 *   node scripts/shoot.mjs --base https://vigil.80.225.209.190.sslip.io --only board
 *   node scripts/shoot.mjs --house hh_xxx       # a household that is already halted on a question
 *
 * Playwright is borrowed from the sibling SAGE checkout rather than added as a dependency here —
 * this is a recording tool, not part of the product. Point PLAYWRIGHT_FROM elsewhere if needed.
 *
 * Output: var/shots/<scene>.webm plus stills. Convert with:
 *   ffmpeg -i var/shots/board.webm -c:v libx264 -crf 18 -pix_fmt yuv420p var/shots/board.mp4
 */
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

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
  return i > -1 ? process.argv[i + 1] : fallback;
};
const BASE = arg("base", "http://localhost:3100").replace(/\/$/, "");
const ONLY = arg("only", null);
const OUT = join(process.cwd(), "var", "shots");
const SIZE = { width: 1512, height: 945 };

const house =
  arg("house", null) ??
  (existsSync("var/demo-household.txt") ? readFileSync("var/demo-household.txt", "utf8").trim() : null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scene(name, run) {
  if (ONLY && ONLY !== name) return;
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 2,
    recordVideo: { dir: OUT, size: SIZE },
    colorScheme: "dark",
  });
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await run(page);
  } catch (e) {
    console.error(`  ${name}: ${e.message}`);
  }
  await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
  const video = page.video();
  await ctx.close();
  await browser.close();
  if (video) {
    const from = await video.path();
    console.log(`  ${name}: ${Math.round((Date.now() - t0) / 1000)}s → ${from}`);
  }
}

/** Scroll like a person reading, not like a scrollbar being dragged. */
async function readDown(page, px, step = 90, pause = 90) {
  for (let y = 0; y < px; y += step) {
    await page.mouse.wheel(0, step);
    await sleep(pause);
  }
}

await scene("landing", async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 90_000 });
  await sleep(2500);
  await readDown(page, 2600);
  await sleep(1200);
});

await scene("drop", async (page) => {
  await page.goto(`${BASE}/new`, { waitUntil: "networkidle", timeout: 60_000 });
  await sleep(1200);
  await page.fill('input[name="name"]', "Our flat");
  await sleep(400);
  const text = [
    "We've got a 2019 Honda Accord.",
    "Ayesha's room has a Mainstays 9-drawer fabric dresser — my sister gave it to us, so I don't know how old it is.",
    "There's a Babysense Max View VBM55 baby monitor next to the cot.",
    "And vitafusion melatonin gummies in the kitchen drawer.",
  ].join("\n");
  for (const line of text.split("\n")) {
    await page.type('textarea[name="text"]', `${line}\n`, { delay: 18 });
    await sleep(350);
  }
  await sleep(1500);
});

// The board as it stands: a real pass, real findings, and a question it stopped on.
await scene("board", async (page) => {
  if (!house) throw new Error("no household id — pass --house or seed one");
  await page.goto(`${BASE}/h/${house}`, { waitUntil: "networkidle", timeout: 90_000 });
  await sleep(4000);
  await readDown(page, 3400, 80, 80);
  await sleep(1500);
});

// The watch itself. This is the long one and the only one that spends money.
await scene("watch", async (page) => {
  if (!house) throw new Error("no household id");
  await page.goto(`${BASE}/h/${house}`, { waitUntil: "networkidle", timeout: 90_000 });
  await sleep(1500);
  const go = page.getByRole("button", { name: /watch now/i });
  if (await go.count()) {
    await go.first().click();
    // Stay on the field while the lamp moves. A pass is minutes; record six of them.
    await sleep(360_000);
  } else {
    // Already halted on a question: show the replay instead, which is honest and fast.
    const replay = page.getByRole("button", { name: /replay/i });
    if (await replay.count()) {
      await replay.first().click();
      await sleep(120_000);
    }
  }
});

// The audit: every URL the last watch actually called.
await scene("pass", async (page) => {
  if (!house) throw new Error("no household id");
  await page.goto(`${BASE}/h/${house}`, { waitUntil: "networkidle", timeout: 90_000 });
  const link = page.getByRole("link", { name: /everything the last watch asked/i });
  if (await link.count()) {
    await link.first().click();
    await page.waitForLoadState("networkidle");
    await sleep(2500);
    await readDown(page, 1400, 70, 70);
    await sleep(1200);
  }
});

console.log(`\nstills and video in ${OUT}`);
