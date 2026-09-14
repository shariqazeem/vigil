import { z } from "zod";
import { addProbe, addService, allServices, listServices } from "@/lib/db/warden";
import { ASK_BEFORE_ACTING, DEFAULT_POLICY, OBSERVE_ONLY } from "@/lib/ops/policy";
import { sshKeyPath } from "@/lib/ops/hosts";
import { checkHost, checkProbeUrl } from "@/lib/net/targets";
import { confineLocal } from "@/lib/ops/local";
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
 * The posture is chosen here rather than assembled from seventeen toggles, because the first decision
 * a person makes about an agent touching their production should be a sentence they can hold in
 * their head. The full policy is on the service page afterwards, where they can see what each one
 * actually permits before they widen it.
 */
const MAX_PER_OWNER = 25;
/**
 * And a ceiling across everybody, because the per-owner one bounds nothing on its own: an identity
 * here is a cookie this route mints on demand, so anyone willing to discard cookies has as many
 * owners as they like. Each service is probes running on a clock forever, against somebody else's
 * addresses, from this machine. One VM's worth is a few hundred.
 */
const maxTotal = () => Number(process.env.WARDEN_MAX_SERVICES ?? 300);

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

  if (allServices().length >= maxTotal()) {
    return no(
      "This Warden is full — it is one machine, and every service on it is checks running on a clock. Run your own: it is MIT and the readme is a page long.",
      503,
    );
  }

  const fresh = await ownerForWrite();
  if (listServices(fresh.owner.key).length >= MAX_PER_OWNER) {
    return no(`One Warden watches ${MAX_PER_OWNER} services. That is not a licensing limit, it is a sweep that has to finish.`, 409);
  }

  // ── the ssh side, which is optional and is never a path from the browser ──
  let host = "local";
  let sshKey: string | null = null;
  let repo = b.repo ?? null;
  let process_ = b.process ?? null;
  let nodeBin = b.nodeBin ?? null;
  if (b.sshKeyName) {
    const path = sshKeyPath(b.sshKeyName);
    if (!path) return no("This Warden does not hold a key by that name.", 400, "sshKeyName");
    if (!b.host) return no("Which machine should Warden reach with that key? For example ubuntu@203.0.113.10.", 400, "host");
    const hostname = b.host.includes("@") ? b.host.slice(b.host.indexOf("@") + 1) : b.host;
    const verdict = checkHost(hostname);
    if (!verdict.ok) return no(verdict.reason!, 400, "host");
    host = b.host;
    sshKey = path;
  } else {
    // No key means every operation would run on the machine Warden itself is running on, and the
    // checkout and process name are the registrant's to choose — so this is where a stranger would
    // point read_file at Warden's own .env. Refused unless the operator has allowed it.
    const confined = confineLocal({ repo, process: process_, nodeBin });
    if (confined.refused) return no(confined.refused, 400, b.repo ? "repo" : "process");
    repo = confined.repo;
    process_ = confined.process;
    nodeBin = confined.nodeBin;
  }

  // Asked last, because what counts as "a way to tell" depends on what survived the rule above: a
  // service that asked for a process check it is not allowed to have still needs a URL.
  if (!b.url && !process_) {
    return no("Warden needs at least one way to tell whether this is alright: a URL it can ask, or a process it can look for.", 400, "url");
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
    repo,
    process: process_,
    nodeBin,
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
  // A certificate check comes free with an https URL, and it is the only check here that fails
  // before anything is broken. Nobody thinks to ask for it; everybody wants it at 3am.
  if (b.url?.startsWith("https:")) {
    addProbe({
      serviceId: service.id,
      kind: "tls",
      label: "the certificate is not about to expire",
      spec: { url: b.url, warnDays: 14 },
      everySeconds: 21_600,
      failuresToOpen: 1,
    });
  }

  if (process_) {
    addProbe({
      serviceId: service.id,
      kind: "process",
      label: "the process is up",
      spec: { process: process_ },
      everySeconds: b.everySeconds,
      failuresToOpen: 1,
    });
  }

  return ok({ id: service.id }, fresh);
}
