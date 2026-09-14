import { z } from "zod";
import { addChannel, listChannels } from "@/lib/db/warden";
import { checkProbeUrl } from "@/lib/net/targets";
import { no, ok, ownerForWrite, readJson } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where Warden should reach you. A URL it POSTs to — a Slack or Discord incoming webhook, or
 * anything you wrote yourself. Nothing but the URL is stored, which is what makes it safe to keep.
 */
const MAX = 5;

const Body = z.object({
  label: z.string().trim().min(1).max(60),
  url: z.string().trim().min(1).max(500),
  level: z.enum(["halt", "all"]).default("halt"),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await readJson<unknown>(req));
  if (!parsed.success) return no(parsed.error.issues[0]?.message ?? "Warden could not read that.", 400);
  const b = parsed.data;

  const verdict = checkProbeUrl(b.url);
  if (!verdict.ok) return no(verdict.reason!, 400, "url");

  const fresh = await ownerForWrite();
  if (listChannels(fresh.owner.key).length >= MAX) return no(`${MAX} places to be reached is already more than anyone reads.`, 409);

  const channel = addChannel({ ownerKey: fresh.owner.key, label: b.label, url: b.url, level: b.level });
  return ok({ id: channel.id }, fresh);
}
