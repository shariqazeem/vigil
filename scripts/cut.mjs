/**
 * A ROUGH CUT, FROM THE REAL FOOTAGE, WITH NO NARRATION.
 *
 * This is insurance rather than the deliverable. docs/video.md is the script for the film worth
 * making — a person talking over their own product is always better. But a hackathon deadline is a
 * real thing, and a submission with a silent, honest, correctly-captioned three minutes of a real
 * agent fixing a real outage beats a submission with no video at all.
 *
 *   node scripts/shoot.mjs      # first: the footage
 *   node scripts/cut.mjs        # then: var/shots/warden-demo.mp4
 *
 * Every clip here is a recording of production. The only thing added is the captions, and the only
 * thing changed is the speed — stated on the card whenever a scene is sped up, because a demo that
 * hides how long something took is the exact dishonesty this product exists to avoid.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const run = promisify(execFile);
const require_ = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_FROM ?? "/Users/macbookair/projects/SAGE/node_modules/playwright";
const { chromium } = require_(PW);

const OUT = join(process.cwd(), "var", "shots");
const TMP = join(OUT, "cut");
mkdirSync(TMP, { recursive: true });

/** scene, how much faster than real time, the card, and the line under it */
const BEATS = [
  { clip: "quiet", speed: 1.35, title: "Three real services, on one machine", sub: "Warden checks each of them every few minutes, with nobody watching. This is what a normal night looks like." },
  { clip: "console", speed: 1.0, title: "You write what it may do", sub: "Sixteen operations, each with a sentence saying what granting it means. Four are refused by name and no policy can turn them on." },
  { clip: "breaks", speed: 1.9, title: "Something breaks, for real", sub: "A real pm2 stop on the real machine. Warden's own checks notice — two failures in a row, because one blip is not an outage." },
  { clip: "incident", speed: 2.6, title: "It investigates, decides, acts — and proves it", sub: "Every command it runs, the policy verdict with the rule that decided, and then the same check, re-run." },
  { clip: "audit", speed: 1.0, title: "And the receipt", sub: "Every call it made, with the exact command and the rule that permitted each one. Copy any of them and run it yourself." },
];

const H = 944; // libx264 wants even dimensions, and 945 is not one
const CARD = (title, sub, note) => `
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap');
  * { box-sizing: border-box; margin: 0; }
  body { width: 1512px; height: ${H}px; background: #fbfbfc; color: #14161a;
         font-family: Inter, -apple-system, sans-serif; display: grid; align-content: center;
         padding: 0 140px; -webkit-font-smoothing: antialiased; }
  .k { font-family: 'JetBrains Mono', monospace; font-size: 15px; letter-spacing: .28em;
       text-transform: uppercase; color: #3f3cbb; margin-bottom: 34px; }
  h1 { font-size: 68px; line-height: 1.06; letter-spacing: -.032em; font-weight: 600; max-width: 20ch; }
  p { margin-top: 30px; font-size: 26px; line-height: 1.5; color: #5a616c; max-width: 46ch; }
  .n { margin-top: 44px; font-family: 'JetBrains Mono', monospace; font-size: 15px; color: #8b929d; }
</style>
<div class="k">Warden</div>
<h1>${title}</h1>
<p>${sub}</p>
${note ? `<div class="n">${note}</div>` : ""}
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1512, height: H }, deviceScaleFactor: 1 });

const parts = [];
for (const [i, b] of BEATS.entries()) {
  const src = join(OUT, `${b.clip}.webm`);
  if (!existsSync(src)) {
    console.error(`missing ${src} — run scripts/shoot.mjs first`);
    process.exit(1);
  }

  const note = b.speed > 1.05 ? `shown at ${b.speed}× — nothing is cut, only sped up` : "real time";
  await page.setContent(CARD(b.title, b.sub, note), { waitUntil: "networkidle" });
  const png = join(TMP, `card${i}.png`);
  await page.screenshot({ path: png });

  const card = join(TMP, `card${i}.mp4`);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-i", png, "-t", "3.4", "-r", "30",
    "-vf", `scale=1512:${H},fade=in:0:12,fade=out:90:12,format=yuv420p`, "-c:v", "libx264", "-crf", "20", card]);

  const body = join(TMP, `body${i}.mp4`);
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", src,
    "-vf", `setpts=${(1 / b.speed).toFixed(4)}*PTS,scale=1512:${H}:force_original_aspect_ratio=decrease,pad=1512:${H}:(ow-iw)/2:(oh-ih)/2:color=0xfbfbfc,fps=30,format=yuv420p`,
    "-an", "-c:v", "libx264", "-crf", "21", "-preset", "medium", body]);

  parts.push(card, body);
  console.log(`  ${b.clip}: card + ${b.speed}×`);
}

const list = join(TMP, "parts.txt");
writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
const final = join(OUT, "warden-demo.mp4");
await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", final]);

const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", final]);
console.log(`\n${final}  ${Math.round(Number(stdout))}s`);
await browser.close();
