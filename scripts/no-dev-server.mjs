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

/*
 * The question is not "is a Next server running" — on the deployment host, production is a Next
 * server on one of these ports, and refusing there would break every deploy. The question is
 * whether a server is using THIS .next, which is exactly "is its working directory mine".
 *
 * (The VM builds in a sibling directory for an unrelated reason — a build into the live .next
 * serves 400s for old chunks while it runs — so the cwds differ there and this stays quiet.)
 */
const here = process.cwd();
const dev = [];
for (const entry of pids) {
  const [pid, port] = entry.split(":");
  try {
    const { stdout: cmd } = await run("ps", ["-o", "command=", "-p", pid]);
    if (!/next[- ]server|next dev/.test(cmd)) continue;
    const { stdout: cwd } = await run("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"]);
    const dir = (cwd.split("\n").find((l) => l.startsWith("n")) ?? "").slice(1).trim();
    if (dir === here) dev.push(`  pid ${pid} on :${port} — ${cmd.trim().slice(0, 70)}`);
  } catch {
    /* it exited between the calls, or lsof cannot see it — either way, not something to block on */
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
