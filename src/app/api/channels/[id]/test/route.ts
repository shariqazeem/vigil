import { currentOwner } from "@/lib/auth/session";
import { getChannel, recordDelivery } from "@/lib/db/warden";
import { checkProbeUrl } from "@/lib/net/targets";
import { no, ok } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Send one now, so a person finds out their webhook is wrong here rather than at three in the
 * morning during the one incident it was added for. Warden reports exactly what came back.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const channel = getChannel(id);
  if (!channel) return no("No such channel.", 404);
  const owner = await currentOwner();
  if (!owner || owner.key !== channel.ownerKey) return no("That is not yours to change.", 403);

  const verdict = checkProbeUrl(channel.url);
  if (!verdict.ok) {
    recordDelivery(id, false, verdict.reason ?? "that address is not allowed");
    return no(verdict.reason!, 400);
  }

  const line = "This is Warden checking it can reach you. Nothing is wrong.";
  try {
    const res = await fetch(channel.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ warden: "1", level: "test", title: "test", body: line, text: line, content: line, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(8000),
    });
    const detail = res.ok ? `${res.status}` : `${res.status} ${(await res.text().catch(() => "")).slice(0, 140)}`;
    recordDelivery(id, res.ok, detail);
    return res.ok ? ok({ ok: true, detail }) : no(`That address answered ${detail}.`, 502);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    recordDelivery(id, false, why);
    return no(`Warden could not reach it: ${why}`, 502);
  }
}
