import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE WRITE SURFACE, ATTACKED.
 *
 * Until today nothing about Warden could be changed from a browser: registering a service meant
 * editing a file on the machine it runs on, so whoever did it already had a shell there. Now the
 * console IS the product, which means a stranger on the internet can reach the code that decides
 * what an agent may do to a production system.
 *
 * These are the four things that must stay true, run against the real route handlers:
 *   the public fleet is READ-ONLY to everyone but its owner — nobody takes SAGE off OBSERVE_ONLY
 *   a probe cannot be pointed at cloud metadata, or (by default) anywhere inside the network
 *   a policy cannot grant a forbidden operation, whatever JSON arrives
 *   an ssh key is chosen by name from the server's own list, never by path from a form
 */
const env = vi.hoisted(() => {
  const dir = `${(process.env.TMPDIR ?? "/tmp").replace(/\/$/, "")}/warden-api-${process.pid}-${Date.now()}`;
  process.env.WARDEN_DB_PATH = `${dir}/warden.db`;
  process.env.WARDEN_SESSION_DIR = `${dir}/sessions`;
  process.env.WARDEN_SESSION_SECRET = "test-secret-for-signing-owner-cookies";
  delete process.env.WARDEN_ALLOW_PRIVATE_TARGETS;
  delete (globalThis as { __wardenDb?: unknown }).__wardenDb;
  return { dir };
});

/** The cookie jar the route handlers read. One line here is the whole identity of a request. */
const jar = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "warden_owner" && jar.value ? { name, value: jar.value } : undefined) }),
}));

import { rmSync } from "node:fs";
import { POST as registerService } from "../services/route";
import { DELETE as deleteService, PATCH as patchService } from "../services/[id]/route";
import { POST as addProbeRoute } from "../services/[id]/probes/route";
import { addService, getService, listProbes, policyOf } from "@/lib/db/warden";
import { OBSERVE_ONLY } from "@/lib/ops/policy";
import { encodeOwner } from "@/lib/auth/session";

afterAll(() => rmSync(env.dir, { recursive: true, force: true }));

const post = (url: string, body: unknown) => new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const patch = (url: string, body: unknown) => new Request(url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const asAnon = (key: string) => { jar.value = encodeOwner({ key, kind: "anon" }); };
const asStranger = () => { jar.value = undefined; };

let sage: string;
beforeEach(() => {
  asStranger();
  if (!sage) {
    sage = addService({ ownerKey: "demo", name: "SAGE", host: "local", policy: OBSERVE_ONLY }).id;
  }
});

describe("the public fleet is watched by anyone and changed by nobody", () => {
  const takeover = {
    policy: { may: ["destroy_infra", "pm2_restart", "delete_data"], ask: [], never: [], maxActionsPerIncident: 20, cooldownMinutes: 0, note: "owned" },
  };

  it("refuses a stranger with no cookie", async () => {
    const res = await patchService(patch(`http://x/api/services/${sage}`, takeover), params(sage));
    expect(res.status).toBe(403);
    expect(policyOf(getService(sage)!)).toEqual(OBSERVE_ONLY);
  });

  it("refuses a visitor holding a perfectly valid cookie of their own", async () => {
    asAnon("anon:someone-else");
    const res = await patchService(patch(`http://x/api/services/${sage}`, takeover), params(sage));
    expect(res.status).toBe(403);
    expect(policyOf(getService(sage)!)).toEqual(OBSERVE_ONLY);
  });

  it("refuses deleting it, and refuses adding a check to it", async () => {
    asAnon("anon:someone-else");
    expect((await deleteService(new Request("http://x", { method: "DELETE" }), params(sage))).status).toBe(403);
    expect((await addProbeRoute(post("http://x", { kind: "http", label: "x", url: "https://example.com/" }), params(sage))).status).toBe(403);
    expect(getService(sage)).not.toBeNull();
  });
});

describe("what a probe may be pointed at", () => {
  let mine: string;
  beforeEach(async () => {
    asAnon("anon:owner-1");
    const res = await registerService(post("http://x/api/services", { name: "Mine", url: "https://example.com/", posture: "ask" }));
    mine = ((await res.json()) as { id: string }).id;
  });

  it("refuses the cloud metadata service", async () => {
    const res = await addProbeRoute(post("http://x", { kind: "http", label: "keys", url: "http://169.254.169.254/latest/meta-data/" }), params(mine));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("metadata");
    expect(listProbes(mine).map((p) => p.kind).sort()).toEqual(["http", "tls"]);
  });

  it("refuses an address inside the network on an instance strangers can reach", async () => {
    const res = await addProbeRoute(post("http://x", { kind: "http", label: "internal", url: "http://10.0.0.5/admin" }), params(mine));
    expect(res.status).toBe(400);
    expect(listProbes(mine)).toHaveLength(2);
  });

  it("refuses registering a service at one in the first place", async () => {
    const res = await registerService(post("http://x/api/services", { name: "Sneaky", url: "http://169.254.169.254/", posture: "observe" }));
    expect(res.status).toBe(400);
  });

  it("accepts an ordinary public URL", async () => {
    const res = await addProbeRoute(post("http://x", { kind: "http", label: "another page", url: "https://example.com/about" }), params(mine));
    expect(res.status).toBe(200);
    expect(listProbes(mine)).toHaveLength(3);
  });
});

describe("a certificate check nobody asked for", () => {
  /**
   * It comes free with an https URL and it is the only check here that fails BEFORE anything is
   * broken — days before, while there is still time to renew. Nobody thinks to ask for it and
   * everybody wants it at 3am, which is the argument for it being a default rather than an option.
   */
  it("is added alongside the http check when the URL is https", async () => {
    asAnon("anon:cert-1");
    const made = await registerService(post("http://x/api/services", { name: "Secure", url: "https://example.com/", posture: "observe" }));
    const id = ((await made.json()) as { id: string }).id;

    const tls = listProbes(id).find((p) => p.kind === "tls")!;
    expect(tls, "an https registration should watch its own certificate").toBeTruthy();
    expect(JSON.parse(tls.spec)).toMatchObject({ url: "https://example.com/", warnDays: 14 });
    // Once a day is plenty for something measured in days, and it does not flap.
    expect(tls.everySeconds).toBeGreaterThanOrEqual(21_600);
    expect(tls.failuresToOpen).toBe(1);
  });

  it("is not added for an http URL, which has no certificate", async () => {
    asAnon("anon:cert-2");
    const made = await registerService(post("http://x/api/services", { name: "Plain", url: "http://example.com/", posture: "observe" }));
    const id = ((await made.json()) as { id: string }).id;
    expect(listProbes(id).map((p) => p.kind)).toEqual(["http"]);
  });

  it("refuses to watch a certificate on a URL that has none", async () => {
    asAnon("anon:cert-3");
    const made = await registerService(post("http://x/api/services", { name: "Plain 2", url: "http://example.com/", posture: "observe" }));
    const id = ((await made.json()) as { id: string }).id;
    const res = await addProbeRoute(post("http://x", { kind: "tls", label: "cert", url: "http://example.com/" }), params(id));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("no certificate");
  });
});

describe("what a policy can be made to say", () => {
  it("cannot be made to grant a forbidden operation from the editor", async () => {
    asAnon("anon:owner-2");
    const made = await registerService(post("http://x/api/services", { name: "Ours", url: "https://example.com/", posture: "may" }));
    const id = ((await made.json()) as { id: string }).id;

    const res = await patchService(
      patch(`http://x/api/services/${id}`, {
        policy: { may: ["delete_data", "destroy_infra", "pm2_restart"], ask: [], never: [], maxActionsPerIncident: 3, cooldownMinutes: 10, note: "" },
      }),
      params(id),
    );
    expect(res.status).toBe(200);

    const saved = policyOf(getService(id)!);
    for (const op of ["delete_data", "destroy_infra", "db_migrate", "rotate_secret"]) {
      expect(saved.may, op).not.toContain(op);
      expect(saved.never, op).toContain(op);
    }
    // and the thing they legitimately asked for did go through
    expect(saved.may).toContain("pm2_restart");
  });
});

describe("how many services one Warden will hold", () => {
  it("refuses past the global ceiling, because an identity is a cookie it mints on demand", async () => {
    // The per-owner cap bounds nothing on its own: discard the cookie and you are a new owner.
    process.env.WARDEN_MAX_SERVICES = "1";
    asAnon("anon:first");
    const first = await registerService(post("http://x/api/services", { name: "one", url: "https://example.com/", posture: "observe" }));
    // There is already a service in this database (SAGE), so even the first is over a ceiling of 1.
    expect(first.status).toBe(503);
    expect(((await first.json()) as { error: string }).error).toContain("full");

    // and a fresh identity does not get around it
    asAnon("anon:second");
    expect((await registerService(post("http://x/api/services", { name: "two", url: "https://example.com/", posture: "observe" }))).status).toBe(503);
    delete process.env.WARDEN_MAX_SERVICES;
  });
});

describe("the machine Warden itself is running on", () => {
  /**
   * The hole this closes, which was open on the live instance for about an hour.
   *
   * A service with no ssh key runs its operations LOCALLY, and `repo` and `process` are chosen by
   * whoever registers it. So {repo: "/home/ubuntu/warden", process: "warden"} points `read_file` at
   * Warden's own checkout — where the .env with the model key is — and `pm2_restart` at Warden
   * itself. Path containment is no help: the containment is relative to a repo the attacker named.
   */
  it("refuses a checkout path on a service with no machine to reach", async () => {
    asAnon("anon:attacker");
    const res = await registerService(
      post("http://x/api/services", { name: "innocent", url: "https://example.com/", repo: "/home/ubuntu/warden", posture: "may" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("its own host");
  });

  it("refuses a process name the same way", async () => {
    asAnon("anon:attacker2");
    const res = await registerService(post("http://x/api/services", { name: "innocent", url: "https://example.com/", process: "warden", posture: "may" }));
    expect(res.status).toBe(400);
  });

  it("refuses adding one by editing afterwards, which is the same door", async () => {
    asAnon("anon:attacker3");
    const made = await registerService(post("http://x/api/services", { name: "plain", url: "https://example.com/", posture: "observe" }));
    const id = ((await made.json()) as { id: string }).id;

    const res = await patchService(patch(`http://x/api/services/${id}`, { repo: "/home/ubuntu/warden" }), params(id));
    expect(res.status).toBe(400);
    expect(getService(id)!.repo).toBeNull();
  });

  it("lets the operator allow it deliberately, for somebody watching their own box", async () => {
    process.env.WARDEN_ALLOW_LOCAL_SERVICES = "1";
    asAnon("anon:self-hoster");
    const res = await registerService(
      post("http://x/api/services", { name: "mine", url: "https://example.com/", repo: "/srv/app", process: "app", posture: "may" }),
    );
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { id: string }).id;
    expect(getService(id)!.repo).toBe("/srv/app");
    expect(getService(id)!.process).toBe("app");
    delete process.env.WARDEN_ALLOW_LOCAL_SERVICES;
  });

  it("still refuses a service with no way at all of telling whether it is alright", async () => {
    asAnon("anon:attacker4");
    // A process name that is stripped leaves nothing behind, and that must be an error rather than
    // a service registered with no checks on it.
    const res = await registerService(post("http://x/api/services", { name: "nothing", process: "warden", posture: "may" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/its own host|at least one way/);
  });
});

describe("reaching a machine", () => {
  it("will not take an ssh key path from a form — only a name this Warden already holds", async () => {
    asAnon("anon:owner-3");
    const res = await registerService(
      post("http://x/api/services", { name: "Theirs", url: "https://example.com/", sshKeyName: "/root/.ssh/id_rsa", host: "ubuntu@203.0.113.10", posture: "observe" }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("does not hold a key");
  });

  it("registers over http alone, with no machine at all", async () => {
    asAnon("anon:owner-4");
    const res = await registerService(post("http://x/api/services", { name: "Just a URL", url: "https://example.com/", posture: "ask" }));
    expect(res.status).toBe(200);
    const id = ((await res.json()) as { id: string }).id;
    expect(getService(id)!.host).toBe("local");
    expect(getService(id)!.sshKey).toBeNull();
  });

  it("refuses a service with no way of telling whether it is alright", async () => {
    asAnon("anon:owner-5");
    const res = await registerService(post("http://x/api/services", { name: "Nothing to check", posture: "ask" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("at least one way");
  });
});
