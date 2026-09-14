/**
 * Renders docs/architecture.mmd to a PNG. mermaid-cli's bundled Chromium does not launch on this
 * machine, so this drives mermaid in a page through the Playwright that the sibling SAGE checkout
 * already has. It is a docs tool, not part of the product.
 *
 *   node scripts/render-diagram.mjs [in.mmd] [out.png]
 */
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { chromium } = req("/Users/macbookair/projects/SAGE/node_modules/playwright");
const src = readFileSync(process.argv[2] ?? "docs/architecture.mmd", "utf8");
const out = process.argv[3] ?? "docs/architecture.png";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 2000, height: 1200 }, deviceScaleFactor: 2 });
await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">
<div id="c" style="padding:28px"></div>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad:false, theme:"base", fontFamily:"Inter, system-ui, sans-serif",
  themeVariables:{ fontSize:"15px", lineColor:"#64748b", primaryTextColor:"#0f172a" }, flowchart:{ htmlLabels:true, curve:"basis", nodeSpacing:44, rankSpacing:58 } });
const { svg } = await mermaid.render("g", ${JSON.stringify(src)});
document.getElementById("c").innerHTML = svg;
const s = document.querySelector("#c svg"); s.removeAttribute("height"); s.style.width="1900px";
window.__done = true;
</script></body></html>`, { waitUntil: "networkidle" });
await page.waitForFunction(() => window.__done === true, { timeout: 60000 });
await page.waitForTimeout(1200);
const el = await page.$("#c");
mkdirSync("docs", { recursive: true });
await el.screenshot({ path: out });
await browser.close();
console.log("rendered", out);
