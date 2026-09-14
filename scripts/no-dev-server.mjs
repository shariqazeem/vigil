/**
 * REFUSE TO BUILD INTO A .next THAT A DEV SERVER IS USING.
 *
 * `next build` and `next dev` write to the same directory. Running the build while the dev server
 * is up corrupts it, and the failure is not a build error — it is the dev server serving
 * "Internal Server Error" for every route afterwards, with a stack about a missing
 * `_buildManifest.js.tmp.*` that reads like something else entirely.
 *
 * This has cost this project an hour on three separate days, which is two more than a note in a
 * file deserves, so it is a check instead.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const PORTS = [3100, 3000, 3200];

const pids = new Set();
for (const port of PORTS) {
  try {
    const { stdout } = await run("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]);
    for (const pid of stdout.split("\n").filter(Boolean)) pids.add(`${pid}:${port}`);
  } catch {
    /* nothing listening there, which is the answer we want */
  }
}

const dev = [];
for (const entry of pids) {
  const [pid, port] = entry.split(":");
  try {
    const { stdout } = await run("ps", ["-o", "command=", "-p", pid]);
    // `next dev` reports itself as "next-server (vX)" — the same name `next start` uses, with no
    // "dev" anywhere in it. On this machine that distinction does not matter: production runs on
    // the VM, so any Next server listening here is a development one.
    if (/next[- ]server|next dev/.test(stdout)) dev.push(`  pid ${pid} on :${port} — ${stdout.trim().slice(0, 90)}`);
  } catch {
    /* it exited between the two calls */
  }
}

if (dev.length) {
  console.error(
    `\nA Next dev server is running, and a production build writes into the same .next:\n\n${dev.join("\n")}\n\n` +
      `Stop it first. If you have already done this and the dev server is now 500ing on every route:\n\n` +
      `  rm -rf .next && npm run dev -- -p 3100\n`,
  );
  process.exit(1);
}
