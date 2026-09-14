import { z } from "zod";
import { anonymousOwner, currentOwner, fromRecoveryKey, ownerCookie, recoveryKey } from "@/lib/auth/session";
import { listServices } from "@/lib/db/warden";
import { no, ok, readJson } from "@/lib/api";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * WHO YOU ARE HERE — which is deliberately the smallest thing that works.
 *
 * There is no account, no password and no email. What there is: a signed statement of an identity,
 * kept in a cookie, and the same string written down so it can be carried to another machine. The
 * one thing this has to get right is that a recovery key is exactly as powerful as the cookie, so
 * it is returned once, to the person who just created it, and never listed anywhere afterwards.
 */
const Body = z.object({
  action: z.enum(["claim", "restore"]),
  name: z.string().trim().max(40).optional(),
  key: z.string().trim().max(600).optional(),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await readJson<unknown>(req));
  if (!parsed.success) return no("Warden could not read that.", 400);
  const b = parsed.data;

  if (b.action === "restore") {
    if (!b.key) return no("Paste the key you were given.", 400, "key");
    const owner = fromRecoveryKey(b.key);
    if (!owner) {
      return no("That key is not one Warden issued, or it has been altered. Check you copied all of it.", 400, "key");
    }
    const res = NextResponse.json({ ok: true, name: owner.name ?? null, services: listServices(owner.key).length });
    res.cookies.set(ownerCookie(owner));
    return res;
  }

  // claim: name the identity you already have, or mint one if this is a first visit
  const existing = await currentOwner();
  const owner = existing ?? anonymousOwner();
  const named = { ...owner, ...(b.name ? { name: b.name } : {}) };
  const res = NextResponse.json({ ok: true, key: recoveryKey(named), name: named.name ?? null, services: listServices(named.key).length });
  res.cookies.set(ownerCookie(named));
  return res;
}

/** Who Warden currently thinks you are. Never returns the key — that is issued once, on claim. */
export async function GET() {
  const owner = await currentOwner();
  return ok({ signedIn: !!owner, name: owner?.name ?? null, services: owner ? listServices(owner.key).length : 0 });
}
