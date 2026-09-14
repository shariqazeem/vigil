import { z } from "zod";
import { addProbe, addService, listServices } from "@/lib/db/warden";
import { ASK_BEFORE_ACTING, DEFAULT_POLICY, OBSERVE_ONLY } from "@/lib/ops/policy";
import { sshKeyPath } from "@/lib/ops/hosts";
import { checkHost, checkProbeUrl } from "@/lib/net/targets";
import { no, ok, ownerForWrite, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * REGISTERING SOMETHING TO WATCH — the step that used to require editing a file on the server.
 *
 * A service needs one thing to be useful: a way to tell whether it is alright. Everything else —
 * the machine, the checkout, the process name — only widens what Warden can find out once it is
 * not. So a URL alone is a complete registration, and the form says so.
 *
 * The posture is chosen here rather than assembled from sixteen toggles, because the first decision
 * a person makes about an agent touching their production should be a sentence they can hold in
 * their head. The full policy is on the service page afterwards, where they can see what each one
 * actually permits before they widen it.
 */
const MAX_PER_OWNER = 25;

const Body = z.object({
  name: z.string().trim().min(1).max(60),
  matters: z.string().trim().max(200).optional().nullable(),
  url: z.string().trim().max(400).optional().nullable(),
  expectStatus: z.coerce.number().int().min(100).max(599).default(200),
  expectContains: z.string().trim().max(200).optional().nullable(),
  sshKeyName: z.string().trim().max(60).optional().nullable(),
  host: z.string().trim().max(120).optional().nullable(),
  repo: z.string().trim().max(300).optional().nullable(),
  process: z.string().trim().max(80).optional().nullable(),
  nodeBin: z.string().trim().max(300).optional().nullable(),
  everySeconds: z.coerce.number().int().min(60).max(86_400).default(300),
  posture: z.enum(["observe", "ask", "may"]).default("ask"),
});

const POLICIES = { observe: OBSERVE_ONLY, ask: ASK_BEFORE_ACTING, may: DEFAULT_POLICY };

export async function POST(req: Request) {
  const raw = await readJson<unknown>(req);
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return no(first?.message ?? "That is not a service Warden can register.", 400, String(first?.path[0] ?? ""));
  }
  const b = parsed.data;

  const fresh = await ownerForWrite();
  if (listServices(fresh.owner.key).length >= MAX_PER_OWNER) {
    return no(`One Warden watches ${MAX_PER_OWNER} services. That is not a licensing limit, it is a sweep that has to finish.`, 409);
  }

  if (!b.url && !b.process) {
    return no("Warden needs at least one way to tell whether this is alright: a URL it can ask, or a process it can look for.", 400, "url");
  }

  // ── the ssh side, which is optional and is never a path from the browser ──
  let host = "local";
  let sshKey: string | null = null;
  if (b.sshKeyName) {
    const path = sshKeyPath(b.sshKeyName);
    if (!path) return no("This Warden does not hold a key by that name.", 400, "sshKeyName");
    if (!b.host) return no("Which machine should Warden reach with that key? For example ubuntu@203.0.113.10.", 400, "host");
    const hostname = b.host.includes("@") ? b.host.slice(b.host.indexOf("@") + 1) : b.host;
    const verdict = checkHost(hostname);
    if (!verdict.ok) return no(verdict.reason!, 400, "host");
    host = b.host;
    sshKey = path;
  } else if (b.process) {
    // A process check with no machine to ask means pm2 on this machine, which is a real setup.
    host = "local";
  }

  if (b.url) {
    const verdict = checkProbeUrl(b.url);
    if (!verdict.ok) return no(verdict.reason!, 400, "url");
  }

  const service = addService({
    ownerKey: fresh.owner.key,
    name: b.name,
    matters: b.matters ?? null,
    host,
    sshKey,
    repo: b.repo ?? null,
    process: b.process ?? null,
    nodeBin: b.nodeBin ?? null,
    policy: POLICIES[b.posture],
  });

  if (b.url) {
    addProbe({
      serviceId: service.id,
      kind: "http",
      label: "the site answers",
      spec: { url: b.url, expectStatus: b.expectStatus, expectContains: b.expectContains || null },
      everySeconds: b.everySeconds,
      // One blip on a network is not an outage. A process that is gone, is gone — see below.
      failuresToOpen: 2,
    });
  }
  if (b.process) {
    addProbe({
      serviceId: service.id,
      kind: "process",
      label: "the process is up",
      spec: { process: b.process },
      everySeconds: b.everySeconds,
      failuresToOpen: 1,
    });
  }

  return ok({ id: service.id }, fresh);
}
