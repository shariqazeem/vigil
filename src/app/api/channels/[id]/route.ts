import { currentOwner } from "@/lib/auth/session";
import { getChannel, retireChannel } from "@/lib/db/warden";
import { no, ok } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const channel = getChannel(id);
  if (!channel) return no("No such channel.", 404);
  const owner = await currentOwner();
  if (!owner || owner.key !== channel.ownerKey) return no("That is not yours to change.", 403);
  retireChannel(id);
  return ok({ ok: true });
}
