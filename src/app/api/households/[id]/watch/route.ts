import { canView, currentOwner } from "@/lib/auth/session";
import { getHousehold, getDecision } from "@/lib/db/vigil";
import { latestRecording, loadRecording, replayPass } from "@/agent/recording";
import { resumeWithAnswer, runPass } from "@/agent/watch";
import type { PassEmit } from "@/agent/pass-context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 900;

/**
 * The watch, live. One pass streamed to the board as it happens, so what the field draws and what
 * the agent did are the same thing rather than two lists that have to agree.
 *
 *   mode=run      do a pass now
 *   mode=resume   a human answered a question; the halted run continues from where it stopped
 *   mode=replay   play a recorded pass back at its own tempo — labelled as a replay, never as live
 *
 * One run per household at a time: a second request is told so rather than racing the first.
 */
const running = new Set<string>();

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const household = getHousehold(id);
  if (!household) return new Response("Not found", { status: 404 });
  const owner = await currentOwner();
  if (!canView(household.ownerKey, owner)) return new Response("Not found", { status: 404 });

  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "run";
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (e: PassEmit & { replay?: true }) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };

      try {
        if (mode === "replay") {
          const passId = url.searchParams.get("pass");
          const rec = passId ? loadRecording(passId) : latestRecording(id);
          if (!rec) {
            send({ kind: "error", message: "There is no recorded pass to play yet." });
            return;
          }
          send({ kind: "pass.start", passId: rec.passId, things: 0, model: rec.model });
          await replayPass(rec, send, { signal: req.signal });
          return;
        }

        if (running.has(id)) {
          send({ kind: "error", message: "Vigil is already looking at this household. Watch that run instead of starting another." });
          return;
        }
        running.add(id);
        try {
          if (mode === "resume") {
            const decisionId = url.searchParams.get("decision") ?? "";
            const answer = url.searchParams.get("answer") ?? "";
            const note = url.searchParams.get("note") ?? undefined;
            const decision = getDecision(decisionId);
            if (!decision || decision.householdId !== id) {
              send({ kind: "error", message: "That question does not belong to this household." });
              return;
            }
            if (!["yes", "no", "unknown", "send", "prepare"].includes(answer)) {
              send({ kind: "error", message: "That is not one of the answers offered." });
              return;
            }
            await resumeWithAnswer(decisionId, answer, note, send);
          } else {
            await runPass(id, "manual", send);
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
          /* already closed by the client going away */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // nginx buffers proxied responses by default, which would hold the whole pass back
      // until it finished and turn a live watch into a slideshow at the end.
      "x-accel-buffering": "no",
    },
  });
}
