import { z } from "zod";
import { canEdit, currentOwner } from "@/lib/auth/session";
import { addProbe, getService, listProbes, logEvent } from "@/lib/db/warden";
import { checkProbeUrl } from "@/lib/net/targets";
import { no, ok, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ADDING A CHECK. A probe is a question with a right answer, asked on a clock.
 *
 * `failuresToOpen` differs by kind on purpose and the UI explains it rather than exposing it: a
 * request over a network fails for reasons that are not an outage, so two in a row; a process that
 * pm2 says is gone is gone on the first look.
 */
const MAX_PROBES = 12;

const Body = z.object({
  kind: z.enum(["http", "process"]),
  label: z.string().trim().min(1).max(60),
  url: z.string().trim().max(400).optional().nullable(),
  expectStatus: z.coerce.number().int().min(100).max(599).default(200),
  expectContains: z.string().trim().max(200).optional().nullable(),
  process: z.string().trim().max(80).optional().nullable(),
  everySeconds: z.coerce.number().int().min(60).max(86_400).default(300),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const service = getService(id);
  if (!service) return no("No such service.", 404);
  const owner = await currentOwner();
  if (!canEdit(service.ownerKey, owner)) return no("That is not yours to change.", 403);

  const parsed = Body.safeParse(await readJson<unknown>(req));
  if (!parsed.success) return no(parsed.error.issues[0]?.message ?? "Warden could not read that check.", 400);
  const b = parsed.data;

  if (listProbes(id).length >= MAX_PROBES) return no(`${MAX_PROBES} checks on one service is already more than anyone reads.`, 409);

  if (b.kind === "http") {
    if (!b.url) return no("A check over http needs a URL to ask.", 400, "url");
    const verdict = checkProbeUrl(b.url);
    if (!verdict.ok) return no(verdict.reason!, 400, "url");
    const probe = addProbe({
      serviceId: id,
      kind: "http",
      label: b.label,
      spec: { url: b.url, expectStatus: b.expectStatus, expectContains: b.expectContains || null },
      everySeconds: b.everySeconds,
      failuresToOpen: 2,
    });
    logEvent(id, "human", "probe.added", `${b.label} — GET ${b.url}`);
    return ok({ id: probe.id });
  }

  const name = b.process || service.process;
  if (!name) return no("Which process should Warden look for? pm2 lists them by name.", 400, "process");
  const probe = addProbe({ serviceId: id, kind: "process", label: b.label, spec: { process: name }, everySeconds: b.everySeconds, failuresToOpen: 1 });
  logEvent(id, "human", "probe.added", `${b.label} — pm2 process "${name}"`);
  return ok({ id: probe.id });
}
