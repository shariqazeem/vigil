import { canView, currentOwner } from "@/lib/auth/session";
import { getHousehold, logEvent } from "@/lib/db/vigil";
import { readInventory } from "@/agent/intake";
import { absolute } from "@/lib/url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** More things for a household that already exists. Same intake, same refusal to guess. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const household = getHousehold(id);
  if (!household) return new Response("Not found", { status: 404 });
  const owner = await currentOwner();
  if (!canView(household.ownerKey, owner)) return new Response("Not found", { status: 404 });

  const form = await req.formData();
  const text = String(form.get("text") ?? "").trim();
  const vin = String(form.get("vin") ?? "").trim();
  const file = form.get("photo");
  const photo = file instanceof File && file.size > 0 ? file : null;
  if (!text && !photo && !vin) return new Response("Say what to add first.", { status: 400 });
  if (photo && photo.size > 6 * 1024 * 1024) return new Response("That photo is larger than 6MB.", { status: 413 });

  try {
    const written = [text, vin ? `Vehicle identification number: ${vin}` : ""].filter(Boolean).join("\n");
    if (photo) {
      const format = photo.type.includes("png") ? "png" : photo.type.includes("webp") ? "webp" : "jpeg";
      await readInventory({ householdId: id, caption: written || undefined, drop: { kind: "image", bytes: new Uint8Array(await photo.arrayBuffer()), format } });
    } else {
      await readInventory({ householdId: id, drop: { kind: "text", text: written } });
    }
  } catch (e) {
    logEvent(id, "intake", "failed", e instanceof Error ? e.message : String(e));
  }
  return Response.redirect(absolute(`/h/${id}`, req), 303);
}
