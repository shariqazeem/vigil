import { canView, currentOwner } from "@/lib/auth/session";
import { allServices, getService, listServices } from "@/lib/db/warden";
import { sweepService, type SweepEmit } from "@/lib/ops/sweep";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * CHECK NOW — the sweep, on demand, streamed as it happens.
 *
 * The same function the cron runs every ten minutes, so pressing this is not a different code path
 * pretending to be one. It asks each probe once and writes down the answer.
 *
 * What it deliberately does NOT do is hand a new incident to the agent. The cron does that, because
 * at four in the morning there is nobody to ask. Here there is someone — they are looking at the
 * screen — and an incident that appears with a "Hand it to Warden" button they chose to press is a
 * better product than one that starts spending their money because they pressed refresh.
 */
const sweeping = new Set<string>();

export async function GET(req: Request) {
  const url = new URL(req.url);
  const one = url.searchParams.get("service");
  const owner = await currentOwner();

  let targets = one ? [getService(one)].filter((s) => s !== null) : owner ? listServices(owner.key) : [];
  // With no services of your own, this checks the public fleet — which is the whole demo.
  if (!one && targets.length === 0) targets = allServices().filter((s) => s.ownerKey === "demo");
  targets = targets.filter((s) => canView(s.ownerKey, owner));
  // Paused means paused. The chip on the card says "no sweep touches this", and a button that
  // swept it anyway would make that sentence a lie — which is worse than not having the button.
  targets = targets.filter((s) => s.state === "watching");
  if (targets.length === 0) return new Response("Nothing to check", { status: 404 });

  const lock = one ?? owner?.key ?? "public";
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (e: SweepEmit | { kind: "sweep.done"; checked: number; opened: number } | { kind: "error"; message: string }) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };

      if (sweeping.has(lock)) {
        send({ kind: "error", message: "A check is already running. Watch that one rather than starting another." });
        open = false;
        controller.close();
        return;
      }
      sweeping.add(lock);
      let opened = 0;
      try {
        for (const service of targets) {
          send({ kind: "sweep.note", message: service.name });
          const r = await sweepService(service, send);
          opened += r.opened.length;
        }
        send({ kind: "sweep.done", checked: targets.length, opened });
      } catch (e) {
        send({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
        sweeping.delete(lock);
        open = false;
        try {
          controller.close();
        } catch {
          /* the client went away */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
