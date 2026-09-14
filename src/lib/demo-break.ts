import type { Service } from "@/lib/db/schema";

/**
 * WHICH SERVICE A STRANGER IS ALLOWED TO STOP.
 *
 * "Break it and watch" stops a real process on a real machine at the request of anyone who loads
 * the page. That is the right call for the one service an operator has set aside for it, and a
 * catastrophic one for either of the others on this fleet: SAGE belongs to somebody else and is
 * entered in two competitions, and Warden's own console is what the visitor is watching through —
 * stopping it would take the evidence down with the service.
 *
 * Four questions, and the last two are belt and braces against a mistyped environment variable,
 * because the cost of getting it wrong is somebody else's production.
 */
export function breakableService(named: string | undefined, services: Service[]): Service | null {
  if (!named) return null;
  const service = services.find((s) => s.id === named) ?? services.find((s) => s.name === named) ?? null;
  if (!service) return null;
  // Never anything a visitor registered — only the public fleet is on this switch.
  if (service.ownerKey !== "demo") return null;
  // Never the console the visitor is watching through, and never somebody else's production.
  if (!service.process || service.process === "warden" || service.name.toLowerCase().includes("sage")) return null;
  return service;
}
