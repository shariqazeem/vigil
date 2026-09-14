import { desc, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { allServices } from "@/lib/db/warden";

export interface TickerLine {
  id: string;
  at: number;
  text: string;
  tone?: "ok" | "down" | "warn" | "accent";
}

/**
 * THE TICKER — the last twelve things that really happened across the demo fleet, in plain words.
 *
 * Checks (the readings table) and events (opened, back, halted, a person changing something) are
 * merged by time. No ids, no jargon: a line here is read by somebody on the landing page who has
 * never seen the product.
 */
export function tickerLines(): TickerLine[] {
  const demo = allServices().filter((s) => s.ownerKey === "demo");
  if (demo.length === 0) return [];
  const ids = demo.map((s) => s.id);
  const name = new Map(demo.map((s) => [s.id, s.name]));

  const evs = db.select().from(schema.events).where(inArray(schema.events.serviceId, ids)).orderBy(desc(schema.events.createdAt)).limit(12).all();
  const reads = db.select().from(schema.readings).where(inArray(schema.readings.serviceId, ids)).orderBy(desc(schema.readings.at)).limit(12).all();

  const lines: TickerLine[] = [
    ...reads.map((r) => ({
      id: `r${r.id}`,
      at: r.at,
      text: `checked ${name.get(r.serviceId) ?? "a service"} · ${r.detail}${r.latencyMs && !/\d+\s*ms/.test(r.detail) ? ` in ${r.latencyMs}ms` : ""}`,
      tone: (r.ok ? "ok" : "down") as TickerLine["tone"],
    })),
    ...evs.map((e) => ({ id: `e${e.id}`, at: e.createdAt, ...say(e.kind, name.get(e.serviceId) ?? "a service", e.detail) })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 12);

  return lines;
}

function say(kind: string, svc: string, detail: string | null): { text: string; tone?: TickerLine["tone"] } {
  switch (kind) {
    case "incident.open": return { text: `problem opened on ${svc}`, tone: "down" };
    case "incident.resolved": case "resolved": return { text: `${svc} is back`, tone: "ok" };
    case "not-fixed": return { text: `acted on ${svc}, but the check still fails`, tone: "warn" };
    case "halted": return { text: `stopped to ask about ${svc}`, tone: "warn" };
    case "escalated": return { text: `handed ${svc} to a person`, tone: "warn" };
    case "run.start": return { text: `started working on ${svc}`, tone: "accent" };
    case "demo.broken": return { text: `someone broke ${svc} on purpose`, tone: "down" };
    case "policy.changed": return { text: `the rules for ${svc} changed` };
    case "probe.added": return { text: `a new check on ${svc}` };
    case "probe.retired": return { text: `a check on ${svc} was retired` };
    case "paused": return { text: `${svc} is no longer watched` };
    case "resumed": return { text: `${svc} is being watched again` };
    case "answered": return { text: `a person answered about ${svc}`, tone: "accent" };
    case "notified": return { text: `told someone about ${svc}` };
    case "graph.failed": return { text: `the run on ${svc} broke`, tone: "down" };
    default: return { text: detail ? `${svc} · ${detail.slice(0, 80)}` : `${svc} · ${kind.replace(/\./g, " ")}` };
  }
}
