/**
 * The social card, rendered once to public/og.png. next/og hangs under this Turbopack dev server,
 * and an image route that can hang is worse than a file — a crawler gets one chance. Same renderer
 * as the architecture diagram: Playwright, borrowed from a sibling checkout.
 *
 *   node scripts/render-og.mjs
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { chromium } = req(process.env.PLAYWRIGHT_FROM ?? "/Users/macbookair/projects/SAGE/node_modules/playwright");

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;background:#fbfbfc;color:#14161a;font-family:Inter,system-ui,sans-serif;
       padding:72px;display:flex;flex-direction:column;justify-content:space-between;
       font-feature-settings:"tnum" 1}
  .brand{font-family:'JetBrains Mono',monospace;font-size:15px;letter-spacing:.34em;text-transform:uppercase;color:#3f3cbb}
  h1{font-size:62px;line-height:1.04;letter-spacing:-.035em;font-weight:600;max-width:19ch}
  p.l{font-size:23px;line-height:1.5;color:#5a616c;max-width:62ch;margin-top:22px;letter-spacing:-.011em}
  .tl{display:flex;gap:0;align-items:stretch;border:1px solid #e8e9ed;border-radius:14px;overflow:hidden;background:#fff}
  .step{flex:1;padding:18px 20px;border-right:1px solid #e8e9ed}
  .step:last-child{border-right:0}
  .k{font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:#8b929d}
  .v{font-size:15px;margin-top:6px;color:#14161a}
  .step.ok .k{color:#0f7a4d}
  .step.warn .k{color:#a8620a}
  .foot{display:flex;justify-content:space-between;align-items:flex-end;font-family:'JetBrains Mono',monospace;font-size:14px;color:#8b929d}
</style></head><body>
  <div class="brand">Warden</div>
  <div>
    <h1>Your software should not need you awake to keep running.</h1>
    <p class="l">An autonomous operator that investigates the thing that broke, fixes what your policy lets it fix, and proves it by re-running the check that failed.</p>
  </div>
  <div class="tl">
    <div class="step"><div class="k">it notices</div><div class="v">expected 200, got 502</div></div>
    <div class="step"><div class="k">it looks</div><div class="v">pm2 jlist · pm2 logs · git log</div></div>
    <div class="step warn"><div class="k">the policy decides</div><div class="v">allow · policy-may</div></div>
    <div class="step ok"><div class="k">it proves it</div><div class="v">200 in 1423ms — resolved</div></div>
  </div>
  <div class="foot"><span>Strands Agents SDK · no shell, ever</span><span>github.com/shariqazeem/warden</span></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
mkdirSync("public", { recursive: true });
await page.screenshot({ path: "public/og.png" });
await browser.close();
console.log("wrote public/og.png");
