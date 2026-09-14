import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { allServices, listEvents, logEvent, openIncidents, policyOf, targetOf } from "@/lib/db/warden";
import { breakableService } from "@/lib/demo-break";
import { sweepService, type SweepEmit } from "@/lib/ops/sweep";

const run = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * BREAK IT AND WATCH.
 *
 * The problem this solves is a presentation problem with a real cause: a working operator has a
 * boring board. Someone arriving here sees three green cards and a list of incidents that were
 * fixed before they got here, and has to take the interesting part on trust.
 *
 * So this stops a real service on the real machine. Not a simulation, not a seeded row — the same
 * `pm2 stop` a person would type. Warden's own probe then notices, an incident opens, and the
 * visitor watches the loop they were being asked to believe in.
 *
 * The care this needs:
 *   ONE service, named by the operator in WARDEN_DEMO_BREAKABLE — the choosing is in
 *   src/lib/demo-break.ts, with the reasons, and a test file attacks it directly.
 *   A cooldown, so it cannot be held down. Restarting in a loop is not a demo either.
 *   Stopping is NOT one of Warden's operations and is not reachable from the catalogue. Warden
 *   cannot stop anything; this is the room's hand on the switch, not the agent's.
 */
/**
 * How long between breakages — and it is deliberately derived from the service's own policy rather
 * than being a second constant that has to be remembered alongside it.
 *
 * If a visitor can break the service again sooner than Warden is allowed to act on it, then every
 * press produces a halt on `cooldown` instead of a fix: the agent works out exactly what to do, the
 * policy says "you acted a moment ago, this one is yours", and the run stops holding a question the
 * visitor has no context for. That is a real and correct policy decision, and it is the wrong first
 * impression — so the button is always the slower of the two.
 */
const MINIMUM_MINUTES = 8;
const breakCooldown = (policyCooldown: number) => Math.max(MINIMUM_MINUTES, policyCooldown + 2);

const breakable = () => breakableService(process.env.WARDEN_DEMO_BREAKABLE, allServices());

function minutesSinceLastBreak(serviceId: string): number | null {
  const last = listEvents(serviceId, 60).find((e) => e.kind === "demo.broken");
  return last ? (Date.now() - last.createdAt) / 60_000 : null;
}

export async function GET() {
  const service = breakable();
  const enc = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (e: SweepEmit | { kind: "note"; message: string } | { kind: "ready"; incidentId: string } | { kind: "error"; message: string }) => {
        if (!open) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };

      try {
        if (!service) {
          send({ kind: "error", message: "This Warden has no service set aside to be broken on purpose." });
          return;
        }
        const wait = breakCooldown(policyOf(service).cooldownMinutes);
        const since = minutesSinceLastBreak(service.id);
        if (since !== null && since < wait) {
          send({
            kind: "error",
            message: `${service.name} was broken ${Math.round(since)} minute${Math.round(since) === 1 ? "" : "s"} ago and is still settling. Try again in ${Math.ceil(wait - since)}.`,
          });
          return;
        }
        if (openIncidents(service.id).length) {
          send({ kind: "error", message: `${service.name} already has an open incident — watch that one rather than starting another.` });
          return;
        }

        const t = targetOf(service);
        const local = t.host === "local" || !t.host;
        send({
          kind: "note",
          message: `Stopping ${service.name}${local ? " on this machine" : ` on ${t.host}`}. This is the real process, not a simulation.`,
        });
        // The same shape the catalogue uses: a local target is spawned directly, a remote one over
        // ssh with argv — never a shell string, even here, where the arguments are not a model's.
        await (local
          ? run("pm2", ["stop", service.process!], { timeout: 60_000 })
          : run(
              "ssh",
              [
                ...(t.sshKey ? ["-i", t.sshKey] : []),
                "-o",
                "StrictHostKeyChecking=no",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                t.host,
                "--",
                `pm2 stop ${JSON.stringify(service.process!)}`,
              ],
              { timeout: 60_000 },
            ));
        logEvent(service.id, "human", "demo.broken", `A visitor stopped ${service.process} on purpose to watch Warden find it.`);

        send({ kind: "note", message: "Stopped. Now asking Warden's own checks, the same ones the cron asks every ten minutes." });
        // The site check opens on its second consecutive failure, so it takes two passes. That is
        // the real threshold, not a dramatic pause: one blip on a network is not an outage.
        await sweepService(service, send);
        await new Promise((r) => setTimeout(r, 1500));
        await sweepService(service, send);

        const incident = openIncidents(service.id).find((i) => i.title.includes("site")) ?? openIncidents(service.id)[0];
        if (!incident) {
          send({ kind: "error", message: "The checks have not opened an incident yet. Give the board a moment and reload." });
          return;
        }
        send({ kind: "ready", incidentId: incident.id });
      } catch (e) {
        send({ kind: "error", message: e instanceof Error ? e.message.slice(0, 200) : String(e) });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {
          /* the visitor went away */
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" },
  });
}
