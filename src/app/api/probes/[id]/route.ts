import { canEdit, currentOwner } from "@/lib/auth/session";
import { getProbe, getService, logEvent, retireProbe } from "@/lib/db/warden";
import { no, ok } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Retiring a check. Its readings stay: they are the record of what was true while it ran. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const probe = getProbe(id);
  if (!probe) return no("No such check.", 404);
  const service = getService(probe.serviceId);
  if (!service) return no("No such check.", 404);
  const owner = await currentOwner();
  if (!canEdit(service.ownerKey, owner)) return no("That is not yours to change.", 403);

  retireProbe(id);
  logEvent(service.id, "human", "probe.retired", probe.label);
  return ok({ ok: true });
}
