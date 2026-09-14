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
<link href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Manrope:wght@400;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;background:radial-gradient(120% 90% at 50% -10%,#11203a 0%,#070c16 52%,#05070d 100%);
       color:#eef2fb;font-family:Manrope,sans-serif;padding:70px;display:flex;flex-direction:column;justify-content:space-between}
  .brand{display:flex;align-items:center;gap:16px;color:#ffc76b;font-family:'JetBrains Mono',monospace;font-size:20px;letter-spacing:.42em;text-transform:uppercase}
  .dot{width:11px;height:11px;border-radius:99px;background:#ffc76b;box-shadow:0 0 26px 4px rgba(255,199,107,.55)}
  h1{font-family:'Instrument Serif',Georgia,serif;font-size:84px;line-height:.98;letter-spacing:-.02em;max-width:900px;font-weight:400}
  p.l{font-size:26px;line-height:1.45;color:#9aa9c4;max-width:880px;margin-top:22px}
  .foot{display:flex;align-items:flex-end;justify-content:space-between;gap:40px}
  .rec{border-left:3px solid #ff6b6b;padding-left:18px;max-width:760px}
  .rec .id{font-family:'JetBrains Mono',monospace;font-size:18px;color:#ff6b6b;letter-spacing:.06em}
  .rec .q{font-size:21px;color:#c5d0e4;line-height:1.4;margin-top:7px}
  .sdk{font-family:'JetBrains Mono',monospace;font-size:17px;color:#5f6d88;text-align:right;white-space:nowrap}
</style></head><body>
  <div class="brand"><span class="dot"></span>vigil</div>
  <div>
    <h1>Nobody is checking<br/>on your behalf.</h1>
    <p class="l">An agent that watches the things in your home against live federal safety data, night after night — and wakes you only when one of them becomes dangerous.</p>
  </div>
  <div class="foot">
    <div class="rec">
      <div class="id">20V314000 · NHTSA safety recall</div>
      <div class="q">“If the fuel pump fails, the engine can stall while driving, increasing the risk of a crash.”</div>
    </div>
    <div class="sdk">Strands Agents SDK<br/>NHTSA · CPSC · openFDA</div>
  </div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
mkdirSync("public", { recursive: true });
await page.screenshot({ path: "public/og.png" });
await browser.close();
console.log("wrote public/og.png");
