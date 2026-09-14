import { canView, currentOwner } from "@/lib/auth/session";
import { getDecision, getIncident, getService } from "@/lib/db/warden";
import { handleIncident, resumeWithAnswer } from "@/agent/warden";
import type { WardenEmit } from "@/agent/incident-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

/**
 * One incident, handled live. Everything the console draws comes down this stream, in the order it
 * actually happened, so the timeline on screen and the rows in the audit table cannot drift apart.
 *
 *   (no mode)      work the incident now
 *   mode=resume    a human answered; the halted run continues from where it stopped
 *
 * One run per incident: a second request is told so rather than racing the first.
 */
const running = new Set<string>();

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const incident = getIncident(id);
  if (!incident) return new Response("Not found", { status: 404 });
  const service = getService(incident.serviceId);
  if (!service) return new Response("Not found", { status: 404 });
  const owner = await currentOwner();
  if (!canView(service.ownerKey, owner)) return new Response("Not found", { status: 404 });

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode");
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (e: WardenEmit) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };

      try {
        if (running.has(id)) {
          send({ kind: "error", message: "Warden is already working on this incident. Watch that run rather than starting another." });
          return;
        }
        running.add(id);
        try {
          if (mode === "resume") {
            const decisionId = url.searchParams.get("decision") ?? "";
            const answer = url.searchParams.get("answer") ?? "";
            const note = url.searchParams.get("note") ?? undefined;
            const decision = getDecision(decisionId);
            if (!decision || decision.incidentId !== id) {
              send({ kind: "error", message: "That question does not belong to this incident." });
              return;
            }
            if (!["approve", "no"].includes(answer)) {
              send({ kind: "error", message: "That is not one of the answers offered." });
              return;
            }
            await resumeWithAnswer(decisionId, answer, note, send);
          } else {
            await handleIncident(id, send);
          }
        } finally {
          running.delete(id);
        }
      } catch (e) {
        send({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      } finally {
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
      // nginx buffers proxied responses by default, which would hold a five-minute investigation
      // back until it finished and turn a live console into a slideshow at the end.
      "x-accel-buffering": "no",
    },
  });
}
