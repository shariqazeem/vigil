import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPERATIONS, OPERATION_NAMES, catalogue, execute, insideRepo, riskOf, withServiceDefaults, type OperationName, type Target } from "../operations";

/**
 * WARDEN HAS NO SHELL. This file is the evidence.
 *
 * `execFile` is replaced here with a recorder, so every one of these tests can say something
 * stronger than "it returned an error": it can say *nothing was spawned*, or *this exact argv was*.
 * A test that only checks the return value cannot tell a refusal apart from a command that ran and
 * failed, and that is the distinction the whole claim rests on.
 */

const proc = vi.hoisted(() => {
  const spawned: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
  const state = {
    reply: async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: "", stderr: "" }),
  };
  return {
    spawned,
    /** what the next spawn resolves (or rejects) with */
    set(reply: () => Promise<{ stdout: string; stderr: string }>) {
      state.reply = reply;
    },
    call(file: string, args: string[], options: Record<string, unknown>) {
      spawned.push({ file, args, options });
      return state.reply();
    },
  };
});

vi.mock("node:child_process", () => {
  const custom = Symbol.for("nodejs.util.promisify.custom");
  const execFile = Object.assign(
    () => {
      throw new Error("callback-style execFile should never be reached: operations.ts promisifies it");
    },
    { [custom]: (file: string, args: string[], options: Record<string, unknown>) => proc.call(file, args, options) },
  );
  return { execFile, default: { execFile } };
});

const LOCAL: Target = { host: "local", repo: "/srv/app", process: "demo", sshKey: null, nodeBin: null };
const REMOTE: Target = { host: "ubuntu@10.0.0.1", repo: "/srv/app", process: "demo", sshKey: "/keys/id", nodeBin: null };

const shellMeta = [";", "&&", "$(whoami)", "|", "\n", "`id`", "||", ">", "&"];

beforeEach(() => {
  proc.spawned.length = 0;
  proc.set(async () => ({ stdout: "", stderr: "" }));
});

afterEach(() => {
  vi.clearAllMocks();
});

/* ── paths ─────────────────────────────────────────────────────────── */

describe("insideRepo — a path is only ever inside the service's own checkout", () => {
  it("resolves a legitimate nested path", () => {
    expect(insideRepo("/srv/app", "src/lib/ops/policy.ts")).toBe("/srv/app/src/lib/ops/policy.ts");
    expect(insideRepo("/srv/app", "./package.json")).toBe("/srv/app/package.json");
    expect(insideRepo("/srv/app", "a/b/../c")).toBe("/srv/app/a/c");
  });

  it("allows the checkout root itself", () => {
    expect(insideRepo("/srv/app", ".")).toBe("/srv/app");
    expect(insideRepo("/srv/app/", ".")).toBe("/srv/app");
  });

  it("throws on every way out of the checkout", () => {
    for (const path of ["../../etc/passwd", "..", "../", "../app-other/secrets", "src/../../etc/shadow", "/etc/passwd", "/", "a/../../../root/.ssh/id_rsa"]) {
      expect(() => insideRepo("/srv/app", path), path).toThrow(/escapes the service checkout/);
    }
  });

  it("does not let a sibling directory with the same prefix through", () => {
    expect(() => insideRepo("/srv/app", "../app-staging/.env")).toThrow(/escapes the service checkout/);
    expect(() => insideRepo("/srv/app", "/srv/app-staging/.env")).toThrow(/escapes the service checkout/);
  });

  it("refuses an escaping path before anything is spawned", async () => {
    const res = await execute("read_file", { path: "../../etc/passwd" }, LOCAL);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/escapes the service checkout/);
    expect(proc.spawned).toHaveLength(0);
  });

  it("refuses a grep pointed outside the checkout before anything is spawned", async () => {
    const res = await execute("grep_repo", { pattern: "PRIVATE KEY", path: "../../../root/.ssh" }, LOCAL);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/escapes the service checkout/);
    expect(proc.spawned).toHaveLength(0);
  });

  it("refuses a repo-less service's file operations rather than guessing a root", async () => {
    for (const op of ["read_file", "grep_repo", "git_log", "git_show", "run_tests"] as const) {
      proc.spawned.length = 0;
      const res = await execute(op, { path: "x", pattern: "xx", ref: "HEAD" }, { host: "local", repo: null, process: "demo" });
      expect(res.ok, op).toBe(false);
      expect(res.error, op).toMatch(/no checkout/);
      expect(proc.spawned, op).toHaveLength(0);
    }
  });
});

/* ── argument hygiene ──────────────────────────────────────────────── */

describe("argument hygiene — the schema is the allowlist", () => {
  const processOps = ["pm2_logs", "pm2_restart", "pm2_start", "redeploy_previous"] as const;

  it("rejects a process name carrying shell metacharacters, on every operation that takes one", () => {
    for (const op of processOps) {
      for (const meta of shellMeta) {
        const bad = `demo${meta}rm -rf /`;
        expect(OPERATIONS[op].input.safeParse({ process: bad }).success, `${op} ← ${JSON.stringify(bad)}`).toBe(false);
      }
      expect(OPERATIONS[op].input.safeParse({ process: "demo app" }).success, op).toBe(false);
      expect(OPERATIONS[op].input.safeParse({ process: "" }).success, op).toBe(false);
      expect(OPERATIONS[op].input.safeParse({ process: "a".repeat(65) }).success, op).toBe(false);
    }
  });

  it("accepts the process names real services actually have", () => {
    for (const op of processOps) {
      for (const good of ["warden", "owed-sweep", "sage.web", "app_2", "a"]) {
        expect(OPERATIONS[op].input.safeParse({ process: good }).success, `${op} ← ${good}`).toBe(true);
      }
    }
  });

  it("rejects a git ref with a space, and anything else outside the ref alphabet", () => {
    for (const bad of ["HEAD~1 ; ls", "HEAD ", " HEAD", "$(git log)", "a|b", "a;b", "a&&b", "a\nb", "a'b", 'a"b', "a".repeat(81)]) {
      expect(OPERATIONS.git_show.input.safeParse({ ref: bad }).success, JSON.stringify(bad)).toBe(false);
    }
    for (const good of ["HEAD", "d4704e0", "origin/main", "v1.2.3", "refs/heads/main"]) {
      expect(OPERATIONS.git_show.input.safeParse({ ref: good }).success, good).toBe(true);
    }
  });

  it("keeps the ref alphabet narrow enough to exclude git's own expression syntax", () => {
    // `~` and `^` are not in the alphabet, so `HEAD~3` and `HEAD^` are refused. That costs the
    // agent nothing — it reads git_log first and asks for a sha — and it keeps the accepted set to
    // characters that mean nothing to any shell. Documented here so that widening it is deliberate.
    for (const expr of ["HEAD~3", "HEAD^", "HEAD@{1}", ":/fix"]) {
      expect(OPERATIONS.git_show.input.safeParse({ ref: expr }).success, expr).toBe(false);
    }
  });

  it("turns a rejected argument into a refusal, not a command", async () => {
    const res = await execute("pm2_restart", { process: "demo; rm -rf /" }, LOCAL);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/^bad arguments for pm2_restart/);
    expect(proc.spawned).toHaveLength(0);
  });

  it("keeps the argument the model wrote as ONE argument when it is a free-text field", async () => {
    // grep's pattern is free text on purpose — you cannot search for a stack trace without
    // punctuation. It is safe because it is an argv element, never a line for a shell to read.
    await execute("grep_repo", { pattern: "$(whoami); rm -rf /" }, LOCAL);
    expect(proc.spawned).toHaveLength(1);
    expect(proc.spawned[0].file).toBe("grep");
    expect(proc.spawned[0].args).toContain("$(whoami); rm -rf /");
    expect(proc.spawned[0].args).not.toContain("-c");
  });

  it("never asks a shell to interpret a string, for any operation in the catalogue", () => {
    const samples: Record<string, Record<string, unknown>> = {
      pm2_list: {},
      pm2_logs: { process: "demo" },
      git_log: {},
      git_show: { ref: "HEAD" },
      read_file: { path: "src/x.ts" },
      grep_repo: { pattern: "TypeError" },
      disk_free: {},
      pm2_restart: { process: "demo" },
      pm2_start: { process: "demo" },
      run_tests: { script: "test" },
      redeploy_previous: { process: "demo" },
    };
    for (const name of OPERATION_NAMES) {
      const op = OPERATIONS[name];
      if (!op.spawn) continue;
      const input = op.input.parse(samples[name] ?? {});
      const plan = (op.spawn as (i: unknown, t: Target) => { file: string; args: string[] })(input, LOCAL);
      expect(["df", "git", "grep", "sed", "npm", "pm2", "bash"], name).toContain(plan.file);
      // `bash` appears once, running a script FILE by path. Never `-c`, which is the only way a
      // string becomes a command line.
      if (plan.file === "bash") expect(plan.args[0], name).toMatch(/\.sh$/);
      for (const flag of ["-c", "-lc", "-ec", "--command", "eval"]) expect(plan.args, `${name} ← ${flag}`).not.toContain(flag);
    }
  });
});

/* ── forbidden operations ──────────────────────────────────────────── */

describe("forbidden operations — declared, refused, never spawned", () => {
  const forbidden = OPERATION_NAMES.filter((n) => riskOf(n) === "forbidden");

  it("names all four, and no others", () => {
    expect([...forbidden].sort()).toEqual(["db_migrate", "delete_data", "destroy_infra", "rotate_secret"]);
  });

  it("gives every forbidden operation a null spawn — there is nothing to run", () => {
    for (const name of forbidden) {
      expect(OPERATIONS[name].spawn, name).toBeNull();
      expect((OPERATIONS[name] as { direct?: unknown }).direct, name).toBeUndefined();
    }
  });

  it("refuses each one by name, without spawning anything", async () => {
    for (const name of forbidden) {
      proc.spawned.length = 0;
      const res = await execute(name, {}, LOCAL);
      expect(res.ok, name).toBe(false);
      expect(res.error, name).toContain(name);
      expect(res.error, name).toContain("forbidden");
      expect(res.error, name).toContain("not a policy setting");
      // The shape of a refusal that never reached a process: no command line, no exit code, no
      // output, and the operation's own name where the command would have been.
      expect(res.command, name).toBe(name);
      expect(res.code, name).toBeNull();
      expect(res.stdout, name).toBe("");
      expect(res.stderr, name).toBe("");
      expect(proc.spawned, name).toHaveLength(0);
    }
  });

  it("refuses them whatever arguments are smuggled in, and whatever host is named", async () => {
    for (const name of forbidden) {
      for (const target of [LOCAL, REMOTE]) {
        proc.spawned.length = 0;
        const res = await execute(name, { process: "demo", path: "/", pattern: "x", ref: "HEAD", url: "http://127.0.0.1/" }, target);
        expect(res.ok, name).toBe(false);
        expect(proc.spawned, name).toHaveLength(0);
      }
    }
  });
});

/* ── how a command actually leaves the process ─────────────────────── */

describe("execute — local and over ssh", () => {
  it("spawns the exact argv locally, with no shell in front of it", async () => {
    const res = await execute("disk_free", {}, LOCAL);
    expect(res.ok).toBe(true);
    expect(proc.spawned).toEqual([{ file: "df", args: ["-h", "/"], options: expect.anything() }]);
  });

  it("uses the service's own node binary for pm2 when it has one", async () => {
    await execute("pm2_list", {}, { ...LOCAL, nodeBin: "/home/ubuntu/.nvm/versions/node/v22/bin/node" });
    expect(proc.spawned[0].file).toBe("/home/ubuntu/.nvm/versions/node/v22/bin/node");
    expect(proc.spawned[0].args.slice(0, 2)).toEqual(["/usr/bin/pm2", "jlist"]);
  });

  it("hands ssh the same argv, quoted, with the host and a -- separator", async () => {
    await execute("pm2_logs", { process: "vigil", lines: 20 }, REMOTE);
    expect(proc.spawned).toHaveLength(1);
    const { file, args } = proc.spawned[0];
    expect(file).toBe("ssh");
    expect(args).toContain("-i");
    expect(args).toContain("/keys/id");
    expect(args.at(-3)).toBe(REMOTE.host);
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("'pm2' 'logs' 'vigil' '--lines' '20' '--nostream'");
    expect(args).not.toContain("-c");
  });

  it("single-quotes a remote argument that contains punctuation, so the remote shell cannot read it as syntax", async () => {
    // read_file's path is free text, so it is the one place a metacharacter can legitimately reach
    // an argument. Locally it is one argv element; remotely it is one quoted word.
    await execute("read_file", { path: "weird'; rm -rf /; echo '" }, REMOTE);
    const remote = proc.spawned[0].args.at(-1) as string;
    expect(remote).toContain(`'\\''`);
    expect(remote.startsWith("'sed' '-n' '1,1200p' '")).toBe(true);
    expect(remote.endsWith("'")).toBe(true);
  });

  it("reports a non-zero exit as a failure, keeping what the command said", async () => {
    proc.set(() => Promise.reject(Object.assign(new Error("Command failed"), { stdout: "", stderr: "no such process", code: 1 })));
    const res = await execute("pm2_restart", { process: "demo" }, LOCAL);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.stderr).toBe("no such process");
    expect(res.error).toContain("Command failed");
  });

  it("treats grep's exit 1 as an answer, because it means 'found nothing'", async () => {
    proc.set(() => Promise.reject(Object.assign(new Error("Command failed"), { stdout: "", stderr: "", code: 1 })));
    const res = await execute("grep_repo", { pattern: "nothing-matches-this" }, LOCAL);
    expect(res.ok).toBe(true);
    expect(res.code).toBe(1);
  });

  it("calls a timeout a timeout rather than an answer", async () => {
    proc.set(() => Promise.reject(Object.assign(new Error("killed"), { stdout: "", stderr: "", code: 1, killed: true })));
    const res = await execute("grep_repo", { pattern: "anything" }, LOCAL);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out after \d+ms/);
  });

  it("parses pm2's jlist into the rows the sweep reads", async () => {
    // The sweep's process probe reads `name`, `status` and the restart count off these rows. When
    // one of those names changes here and not there, the console starts saying "undefined
    // restarts" — so the shape is pinned, in full, on purpose.
    proc.set(async () => ({
      stdout: JSON.stringify([{ name: "warden", pm2_env: { status: "online", restart_time: 3, pm_uptime: 1_757_800_000_000, pm_cwd: "/srv/app" } }]),
      stderr: "",
    }));
    const res = await execute("pm2_list", {}, LOCAL);
    expect(res.data).toEqual([
      { name: "warden", status: "online", restartsSinceAdded: 3, lastStartedAt: new Date(1_757_800_000_000).toISOString(), cwd: "/srv/app" },
    ]);
  });

  it("returns null structured data rather than throwing when pm2 answers with something else", async () => {
    proc.set(async () => ({ stdout: "not json", stderr: "" }));
    const res = await execute("pm2_list", {}, LOCAL);
    expect(res.ok).toBe(true);
    expect(res.data).toBeNull();
  });
});

/* ── the in-process probe ──────────────────────────────────────────── */

describe("http_probe", () => {
  it("returns ok:false rather than throwing when the address does not answer", async () => {
    // Loopback, port 1: refused by the kernel, no packet leaves the machine, no dependency on a
    // network being there at all.
    const res = await execute("http_probe", { url: "http://127.0.0.1:1/", timeoutMs: 2000 }, LOCAL);
    expect(res.ok).toBe(false);
    expect(res.code).toBe(1);
    expect(res.stdout.length).toBeGreaterThan(0);
    expect(res.command).toBe("GET http://127.0.0.1:1/");
    expect(proc.spawned).toHaveLength(0);
  });

  it("refuses a url that is not a url, before it is fetched", async () => {
    for (const url of ["not a url", "", "127.0.0.1", "http://"]) {
      const res = await execute("http_probe", { url }, LOCAL);
      expect(res.ok, url).toBe(false);
      expect(res.error, url).toMatch(/^bad arguments for http_probe/);
      expect(proc.spawned, url).toHaveLength(0);
    }
  });

  it("cannot be turned into a file reader by a url scheme", async () => {
    // `z.string().url()` is a URL check, not an http check, so `file:` passes the schema. Two things
    // stand behind it: fetch refuses the scheme, and the `look` tool refuses any origin the service
    // does not own before it ever gets here (proved in gates.test.ts).
    for (const url of ["file:///etc/passwd", "file:///etc/shadow"]) {
      const res = await execute("http_probe", { url, timeoutMs: 2000 }, LOCAL);
      expect(res.ok, url).toBe(false);
      expect(res.stdout, url).not.toContain("root:");
      expect(proc.spawned, url).toHaveLength(0);
    }
  });
});

/* ── the catalogue as the agent is shown it ────────────────────────── */

describe("catalogue", () => {
  const cat = catalogue();

  it("lists every operation, including the forbidden ones, with its real risk", () => {
    expect(cat.map((c) => c.name)).toEqual([...OPERATION_NAMES]);
    for (const entry of cat) expect(entry.risk, entry.name).toBe(riskOf(entry.name as OperationName));
    expect(cat.filter((c) => c.risk === "forbidden").map((c) => c.name).sort()).toEqual(["db_migrate", "delete_data", "destroy_infra", "rotate_secret"]);
  });

  it("names the real schema keys under `takes`, and no invented ones", () => {
    for (const entry of cat) {
      const shape = (OPERATIONS[entry.name as OperationName].input as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(entry.takes).sort(), entry.name).toEqual(Object.keys(shape).sort());
    }
  });

  it("says of each argument whether it is required, so nothing has to be guessed", () => {
    const byName = Object.fromEntries(cat.map((c) => [c.name, c.takes]));
    expect(byName.pm2_logs.process).toMatch(/required/);
    expect(byName.pm2_logs.lines).toMatch(/optional/);
    expect(byName.git_show.ref).toMatch(/required/);
    expect(byName.read_file.path).toMatch(/required/);
    expect(byName.run_tests.script).toMatch(/optional/);
    expect(byName.db_migrate).toEqual({});
  });
});

/* ── what the service knows, so the model does not have to ─────────── */

describe("withServiceDefaults", () => {
  const needsProcess = ["pm2_logs", "pm2_restart", "pm2_start", "redeploy_previous"] as const;

  it("fills the process name in from the service for the operations that need one", () => {
    for (const op of needsProcess) {
      expect(withServiceDefaults(op, {}, LOCAL), op).toEqual({ process: "demo" });
    }
  });

  it("leaves an explicitly named process alone", () => {
    expect(withServiceDefaults("pm2_restart", { process: "other" }, LOCAL)).toEqual({ process: "other" });
  });

  it("does not invent a process when the service has none", () => {
    for (const op of needsProcess) {
      for (const target of [{ host: "local", process: null }, { host: "local" }, { host: "local", process: "" }] as Target[]) {
        expect(withServiceDefaults(op, {}, target), op).toEqual({});
      }
    }
  });

  it("adds nothing to an operation that does not take a process", () => {
    for (const op of ["pm2_list", "git_log", "git_show", "read_file", "grep_repo", "disk_free", "run_tests", "http_probe", "db_migrate"] as OperationName[]) {
      expect(withServiceDefaults(op, { a: 1 }, LOCAL), op).toEqual({ a: 1 });
    }
  });

  it("copies rather than mutating what it was handed", () => {
    const input = {};
    expect(withServiceDefaults("pm2_restart", input, LOCAL)).not.toBe(input);
    expect(input).toEqual({});
  });
});
