import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, sep } from "node:path";
import { z } from "zod";

const run = promisify(execFile);

/**
 * WHAT WARDEN IS ABLE TO DO, EXHAUSTIVELY.
 *
 * There is no shell here. An agent cannot compose a command, pipe one into another, or reach
 * anything not named in this file — it can only invoke one of these operations, by name, with
 * arguments that pass a zod schema and a character allowlist. Every one is spawned with
 * `execFile`, so an argument containing `;` is an argument containing a semicolon and nothing more.
 *
 * Each operation declares its own RISK, and that is what the per-service policy grants or refuses:
 *
 *   read        looking at something. Cannot change the world.
 *   reversible  changes the world in a way that undoes itself — a restart, a rebuild.
 *   disruptive  changes the world in a way that does not — a rollback, a redeploy.
 *   forbidden   Warden may never do this, whatever a policy says, whatever a model asks.
 *               These are declared rather than omitted so the product can show you the line.
 */

export type Risk = "read" | "reversible" | "disruptive" | "forbidden";

export interface Target {
  /** "local", or an ssh destination Warden already holds a key for */
  host: string;
  sshKey?: string | null;
  /** absolute path to the service's checkout, when it has one */
  repo?: string | null;
  /** the pm2 process name, when it is a pm2 service */
  process?: string | null;
  /** the node binary the service runs under, when it is not on PATH */
  nodeBin?: string | null;
}

export interface OpResult {
  op: string;
  ok: boolean;
  /** the exact thing that was run, printable and checkable by a human */
  command: string;
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
  /** structured, when the operation parses its own output */
  data?: unknown;
  error?: string;
}

/* ── argument hygiene ─────────────────────────────────────────────── */

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
const REF = /^[A-Za-z0-9._/-]{1,80}$/;

/** A path is only ever accepted relative to the service's own checkout, and never above it. */
/* exported for testing */
export function insideRepo(repo: string, path: string): string {
  const full = resolve(repo, path);
  const root = resolve(repo);
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`path escapes the service checkout: ${path}`);
  return full;
}

/** Single-quote for the remote shell. Only used for ssh, where a shell is unavoidable. */
const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * Where ssh keeps the multiplexed control socket. Deliberately short: a unix socket path is capped
 * near 104 bytes, and macOS's per-user TMPDIR plus ssh's %C hash sails past it — which fails as
 * `unix_listener: path too long` on every single call.
 */
const SSH_MUX = "/tmp/.wd-%C";

/* ── the catalogue ────────────────────────────────────────────────── */

interface Spawn {
  file: string;
  args: string[];
  /** ms; a hung operation must not hold an incident open */
  timeout?: number;
  /** bytes of stdout kept */
  max?: number;
}

export interface OperationDef<I extends z.ZodTypeAny> {
  name: string;
  risk: Risk;
  /** exit codes that still count as an answer — grep's 1 means "no matches", not "broken" */
  okCodes?: number[];
  /** how this reads in an incident timeline, in plain words */
  describe: (input: z.infer<I>, t: Target) => string;
  input: I;
  /** null means the operation is implemented in-process rather than as a command */
  spawn: ((input: z.infer<I>, t: Target) => Spawn) | null;
  parse?: (r: { stdout: string; stderr: string; code: number | null }) => unknown;
  /** in-process implementations (the HTTP probe) */
  direct?: (input: z.infer<I>, t: Target) => Promise<{ ok: boolean; data: unknown; detail: string }>;
}

const def = <I extends z.ZodTypeAny>(d: OperationDef<I>) => d;

const pm2 = (t: Target) => (t.nodeBin ? { file: t.nodeBin, pre: ["/usr/bin/pm2"] } : { file: "pm2", pre: [] });

export const OPERATIONS = {
  /* ── read ───────────────────────────────────────────────────────── */

  http_probe: def({
    name: "http_probe",
    risk: "read",
    input: z.object({
      url: z.string().url(),
      expectStatus: z.coerce.number().int().min(100).max(599).default(200),
      expectContains: z.string().max(200).nullable().default(null),
      timeoutMs: z.coerce.number().int().min(500).max(30_000).default(10_000),
    }),
    describe: (i) => `GET ${i.url}`,
    spawn: null,
    direct: async (i) => {
      const t0 = Date.now();
      try {
        const res = await fetch(i.url, { signal: AbortSignal.timeout(i.timeoutMs), redirect: "follow" });
        const body = await res.text();
        const statusOk = res.status === i.expectStatus;
        const bodyOk = !i.expectContains || body.includes(i.expectContains);
        return {
          ok: statusOk && bodyOk,
          data: { status: res.status, ms: Date.now() - t0, bytes: body.length },
          detail: statusOk
            ? bodyOk
              ? `${res.status} in ${Date.now() - t0}ms`
              : `${res.status} but the page did not contain "${i.expectContains}"`
            : `expected ${i.expectStatus}, got ${res.status}`,
        };
      } catch (e) {
        return { ok: false, data: { ms: Date.now() - t0 }, detail: e instanceof Error ? e.message : String(e) };
      }
    },
  }),

  pm2_list: def({
    name: "pm2_list",
    risk: "read",
    input: z.object({}),
    describe: () => "pm2 jlist",
    spawn: (_i, t) => {
      const { file, pre } = pm2(t);
      return { file, args: [...pre, "jlist"], timeout: 45_000, max: 400_000 };
    },
    parse: (r) => {
      try {
        const rows = JSON.parse(r.stdout) as { name: string; pm2_env: { status: string; restart_time: number; pm_uptime: number; pm_cwd?: string } }[];
        return rows.map((a) => ({
          name: a.name,
          status: a.pm2_env.status,
          // Cumulative since the process was added to pm2 — a deploy bumps it. On its own it is
          // not evidence of anything; `lastStartedAt` is what says whether it is looping now.
          restartsSinceAdded: a.pm2_env.restart_time,
          lastStartedAt: a.pm2_env.pm_uptime ? new Date(a.pm2_env.pm_uptime).toISOString() : null,
          cwd: a.pm2_env.pm_cwd ?? null,
        }));
      } catch {
        return null;
      }
    },
  }),

  pm2_logs: def({
    name: "pm2_logs",
    risk: "read",
    input: z.object({
      process: z.string().regex(NAME),
      lines: z.coerce.number().int().min(10).max(200).default(80),
      errorsOnly: z.coerce.boolean().default(false),
    }),
    describe: (i) => `pm2 logs ${i.process} --lines ${i.lines}${i.errorsOnly ? " (errors only)" : ""}`,
    spawn: (i, t) => {
      const { file, pre } = pm2(t);
      return {
        file,
        args: [...pre, "logs", i.process, "--lines", String(i.lines), "--nostream", ...(i.errorsOnly ? ["--err"] : [])],
        timeout: 60_000,
        max: 200_000,
      };
    },
  }),

  git_log: def({
    name: "git_log",
    risk: "read",
    input: z.object({ count: z.coerce.number().int().min(1).max(30).default(10) }),
    describe: (i) => `git log -n ${i.count}`,
    spawn: (i, t) => {
      if (!t.repo) throw new Error("this service has no checkout");
      return { file: "git", args: ["-C", t.repo, "log", "-n", String(i.count), "--format=%h|%ad|%an|%s", "--date=iso-strict"], timeout: 40_000 };
    },
    parse: (r) =>
      r.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, date, author, ...rest] = line.split("|");
          return { sha, date, author, subject: rest.join("|") };
        }),
  }),

  git_show: def({
    name: "git_show",
    risk: "read",
    input: z.object({ ref: z.string().regex(REF), maxBytes: z.coerce.number().int().min(500).max(20_000).default(6_000) }),
    describe: (i) => `git show ${i.ref}`,
    spawn: (i, t) => {
      if (!t.repo) throw new Error("this service has no checkout");
      return { file: "git", args: ["-C", t.repo, "show", "--stat", "--patch", "--no-color", i.ref], timeout: 45_000, max: i.maxBytes };
    },
  }),

  read_file: def({
    name: "read_file",
    risk: "read",
    input: z.object({ path: z.string().min(1).max(300), maxBytes: z.coerce.number().int().min(200).max(80_000).default(20_000) }),
    describe: (i) => `read ${i.path}`,
    spawn: (i, t) => {
      if (!t.repo) throw new Error("this service has no checkout");
      const full = insideRepo(t.repo, i.path);
      return { file: "sed", args: ["-n", "1,1200p", full], timeout: 30_000, max: i.maxBytes };
    },
  }),

  grep_repo: def({
    name: "grep_repo",
    risk: "read",
    // grep exits 1 when it simply found nothing. That is an answer, not a failure.
    okCodes: [0, 1],
    input: z.object({ pattern: z.string().min(2).max(120), path: z.string().max(200).default("."), maxBytes: z.coerce.number().int().min(200).max(40_000).default(12_000) }),
    describe: (i) => `grep -rn ${JSON.stringify(i.pattern)} ${i.path}`,
    spawn: (i, t) => {
      if (!t.repo) throw new Error("this service has no checkout");
      const where = insideRepo(t.repo, i.path);
      return {
        file: "grep",
        args: ["-rn", "--binary-files=without-match", "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=.next", "-m", "40", "-e", i.pattern, where],
        timeout: 45_000,
        max: i.maxBytes,
      };
    },
  }),

  disk_free: def({
    name: "disk_free",
    risk: "read",
    input: z.object({}),
    describe: () => "df -h /",
    spawn: () => ({ file: "df", args: ["-h", "/"], timeout: 25_000 }),
  }),

  /* ── reversible ─────────────────────────────────────────────────── */

  pm2_restart: def({
    name: "pm2_restart",
    risk: "reversible",
    input: z.object({ process: z.string().regex(NAME) }),
    describe: (i) => `restart ${i.process}`,
    spawn: (i, t) => {
      const { file, pre } = pm2(t);
      return { file, args: [...pre, "restart", i.process, "--update-env"], timeout: 90_000 };
    },
  }),

  pm2_start: def({
    name: "pm2_start",
    risk: "reversible",
    input: z.object({ process: z.string().regex(NAME) }),
    describe: (i) => `start ${i.process}`,
    spawn: (i, t) => {
      const { file, pre } = pm2(t);
      return { file, args: [...pre, "start", i.process], timeout: 90_000 };
    },
  }),

  run_tests: def({
    name: "run_tests",
    risk: "reversible",
    input: z.object({ script: z.enum(["test", "typecheck", "lint"]).default("test") }),
    describe: (i) => `npm run ${i.script}`,
    spawn: (i, t) => {
      if (!t.repo) throw new Error("this service has no checkout");
      return { file: "npm", args: ["--prefix", t.repo, "run", i.script, "--silent"], timeout: 300_000, max: 60_000 };
    },
  }),

  /* ── disruptive ─────────────────────────────────────────────────── */

  redeploy_previous: def({
    name: "redeploy_previous",
    risk: "disruptive",
    input: z.object({ process: z.string().regex(NAME) }),
    describe: (i) => `roll ${i.process} back to the previous build`,
    spawn: (i, t) => {
      if (!t.repo) throw new Error("this service has no checkout");
      // The deploy keeps the last good build beside the live one; this swaps it back and reloads.
      return { file: "bash", args: [`${t.repo}/scripts/rollback.sh`, i.process], timeout: 300_000 };
    },
  }),

  /* ── forbidden. Declared so the product can show you the line. ──── */

  db_migrate: def({
    name: "db_migrate",
    risk: "forbidden",
    input: z.object({}),
    describe: () => "run a database migration",
    spawn: null,
  }),
  delete_data: def({
    name: "delete_data",
    risk: "forbidden",
    input: z.object({}),
    describe: () => "delete data",
    spawn: null,
  }),
  rotate_secret: def({
    name: "rotate_secret",
    risk: "forbidden",
    input: z.object({}),
    describe: () => "rotate a credential",
    spawn: null,
  }),
  destroy_infra: def({
    name: "destroy_infra",
    risk: "forbidden",
    input: z.object({}),
    describe: () => "destroy or replace infrastructure",
    spawn: null,
  }),
} as const;

export type OperationName = keyof typeof OPERATIONS;
export const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[];
export const riskOf = (name: OperationName): Risk => OPERATIONS[name].risk;

/* ── running one ──────────────────────────────────────────────────── */

/**
 * pm2 and git colour their output, and those escape codes travel all the way to a browser as
 * literal noise. Strip them here, once, at the boundary — every consumer downstream (the model's
 * context, the audit table, the live timeline) wants the text and not the terminal.
 */
const ANSI = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const clean = (s: string) => s.replace(ANSI, "");
const cap = (s: string, n: number) => {
  const t = clean(s);
  return t.length > n ? `${t.slice(0, n)}\n… [${t.length - n} more bytes]` : t;
};

/**
 * Execute one operation. The only way anything in this product touches a machine.
 *
 * It does NOT consult policy — `src/lib/ops/policy.ts` does that, and the agent's tools call the
 * policy first. Keeping the two apart means the policy decision is a separate, testable thing from
 * the mechanics of running a command.
 */
export async function execute(name: OperationName, rawInput: unknown, target: Target): Promise<OpResult> {
  const op = OPERATIONS[name] as OperationDef<z.ZodTypeAny>;
  const t0 = Date.now();
  const fail = (error: string, command: string = name): OpResult => ({ op: name, ok: false, command, stdout: "", stderr: "", code: null, ms: Date.now() - t0, error });

  if (op.risk === "forbidden") return fail(`${name} is forbidden to Warden in all circumstances. It is not a policy setting.`);

  let input: unknown;
  try {
    input = op.input.parse(rawInput ?? {});
  } catch (e) {
    return fail(`bad arguments for ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (op.direct) {
    const command = op.describe(input, target);
    try {
      const r = await op.direct(input, target);
      return { op: name, ok: r.ok, command, stdout: r.detail, stderr: "", code: r.ok ? 0 : 1, ms: Date.now() - t0, data: r.data };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e), command);
    }
  }

  if (!op.spawn) return fail(`${name} has no implementation`);

  let plan: Spawn;
  try {
    plan = op.spawn(input, target);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }

  // Local, or the same argv handed to ssh. Either way the agent never wrote a command line.
  const local = target.host === "local" || !target.host;
  const file = local ? plan.file : "ssh";
  const args = local
    ? plan.args
    : [
        ...(target.sshKey ? ["-i", target.sshKey] : []),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        // One connection, reused. An investigation makes a dozen calls in a minute and paying the
        // handshake each time is most of the wall-clock a person watches.
        "-o",
        "ControlMaster=auto",
        "-o",
        `ControlPath=${SSH_MUX}`,
        "-o",
        "ControlPersist=120",
        target.host,
        "--",
        [plan.file, ...plan.args].map(shq).join(" "),
      ];
  const command = `${op.describe(input, target)}${local ? "" : `  · on ${target.host}`}`;

  try {
    const { stdout, stderr } = await run(file, args, { timeout: plan.timeout ?? 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
    const r = { stdout: cap(stdout, plan.max ?? 100_000), stderr: cap(stderr, 8_000), code: 0 as number | null };
    return { op: name, ok: true, command, ...r, ms: Date.now() - t0, data: op.parse?.(r) };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
    const r = { stdout: cap(err.stdout ?? "", plan.max ?? 100_000), stderr: cap(err.stderr ?? "", 8_000), code: err.code ?? null };
    if (!err.killed && err.code !== undefined && (op.okCodes ?? []).includes(err.code)) {
      return { op: name, ok: true, command, ...r, ms: Date.now() - t0, data: op.parse?.(r) };
    }
    return {
      op: name,
      ok: false,
      command,
      ...r,
      ms: Date.now() - t0,
      data: op.parse?.(r),
      error: err.killed ? `timed out after ${plan.timeout ?? 60_000}ms` : (err.message ?? "failed"),
    };
  }
}

/** The catalogue, as the agent is shown it. Forbidden operations are listed on purpose. */
/**
 * The catalogue as the agent is shown it, with the exact arguments each operation takes. Handing a
 * model a list of names and letting it guess the shape is how you get `lines: "120"` and a rejected
 * call; the shape is right here, so there is nothing to guess.
 */
export function catalogue(): { name: string; risk: Risk; takes: Record<string, string> }[] {
  return OPERATION_NAMES.map((n) => {
    const o = OPERATIONS[n] as OperationDef<z.ZodTypeAny>;
    const shape = (o.input as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape ?? {};
    const takes: Record<string, string> = {};
    for (const [key, field] of Object.entries(shape)) {
      const d = field.def as { type?: string; innerType?: { def?: { type?: string } }; defaultValue?: unknown };
      const inner = d.innerType?.def?.type ?? d.type ?? "unknown";
      const optional = d.defaultValue !== undefined || field.safeParse(undefined).success;
      const note = (field.description ?? "").slice(0, 90);
      takes[key] = `${inner}${optional ? " (optional)" : " (required)"}${note ? ` — ${note}` : ""}`;
    }
    return { name: n, risk: o.risk, takes };
  });
}

/**
 * Arguments Warden fills in itself, because they are facts about the service rather than choices.
 * A model that has to remember the pm2 process name is a model with one more thing to get wrong.
 */
export function withServiceDefaults(name: OperationName, input: Record<string, unknown>, t: Target): Record<string, unknown> {
  const out = { ...input };
  const wantsProcess = ["pm2_logs", "pm2_restart", "pm2_start", "redeploy_previous"] as const;
  if ((wantsProcess as readonly string[]).includes(name) && !out.process && t.process) out.process = t.process;
  return out;
}
