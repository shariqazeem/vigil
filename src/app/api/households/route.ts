import { anonymousOwner, currentOwner, ownerCookie } from "@/lib/auth/session";
import { createHousehold, logEvent } from "@/lib/db/vigil";
import { readInventory } from "@/agent/intake";
import { absolute } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

const MAX_IMAGE = 6 * 1024 * 1024;
const MAX_TEXT = 12_000;

/**
 * The drop. Someone says what is in their home — in a sentence, a list, a receipt or a photo — and
 * intake turns it into things Vigil can keep watch over. Nobody signs up: the household belongs to
 * whoever holds the cookie this hands back.
 */
export async function POST(req: Request) {
  const form = await req.formData();
  const text = String(form.get("text") ?? "").trim();
  const name = String(form.get("name") ?? "").trim() || "My home";
  const vin = String(form.get("vin") ?? "").trim();
  const file = form.get("photo");
  const photo = file instanceof File && file.size > 0 ? file : null;

  if (!text && !photo && !vin) return new Response("Tell Vigil what is in your home first.", { status: 400 });
  if (text.length > MAX_TEXT) return new Response("That is longer than Vigil reads in one go.", { status: 413 });
  if (photo && photo.size > MAX_IMAGE) return new Response("That photo is larger than 6MB.", { status: 413 });

  const owner = (await currentOwner()) ?? anonymousOwner();
  const household = createHousehold({ ownerKey: owner.key, name });

  try {
    const written = [text, vin ? `Vehicle identification number: ${vin}` : ""].filter(Boolean).join("\n");
    if (photo) {
      const format = photo.type.includes("png") ? "png" : photo.type.includes("webp") ? "webp" : "jpeg";
      await readInventory({
        householdId: household.id,
        caption: written || undefined,
        drop: { kind: "image", bytes: new Uint8Array(await photo.arrayBuffer()), format },
      });
    } else {
      await readInventory({ householdId: household.id, drop: { kind: "text", text: written } });
    }
  } catch (e) {
    // The household exists and is empty rather than silently swallowing the drop; the board says so.
    logEvent(household.id, "intake", "failed", e instanceof Error ? e.message : String(e));
  }

  const res = Response.redirect(absolute(`/h/${household.id}`, req), 303);
  const out = new Response(res.body, res);
  const c = ownerCookie(owner);
  out.headers.append(
    "set-cookie",
    `${c.name}=${c.value}; Path=${c.path}; Max-Age=${c.maxAge}; HttpOnly; SameSite=Lax${c.secure ? "; Secure" : ""}`,
  );
  return out;
}
