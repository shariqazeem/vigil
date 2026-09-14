import { getService, listChannels, logEvent, recordDelivery } from "@/lib/db/warden";
import { checkProbeUrl } from "@/lib/net/targets";

/**
 * REACHING A PERSON.
 *
 * "Wakes you only when the decision is genuinely yours" was, until this file existed, a description
 * of a screen: the run halted, a card appeared, and it sat there until somebody happened to look.
 * An operator that cannot reach you has not woken you.
 *
 * A channel is a URL Warden POSTs JSON to. Slack and Discord incoming webhooks are exactly that,
 * and so is anything written in an afternoon, so no credential is stored and no integration has to
 * be approved by anyone. The payload carries the same fields in every case and a `text` field that
 * the two common receivers happen to render, which is the whole trick.
 *
 * Two rules that matter more than the feature:
 *   Delivery NEVER fails a run. A broken webhook must not turn a fixed incident into an error.
 *   Every attempt is written down, success or not, so a hook that silently stopped working is
 *   visible on the page rather than being mistaken for a quiet night.
 */
export type Level = "halt" | "all";

export interface Notice {
  level: Level;
  serviceId: string;
  /** the one line a phone will show */
  title: string;
  body: string;
  /** where to go to do something about it */
  url?: string;
}

const TIMEOUT = 8000;

const base = (): string => (process.env.WARDEN_BASE_URL ?? "http://localhost:3100").replace(/\/$/, "");

export function noticeUrl(path: string): string {
  return `${base()}${path}`;
}

/**
 * Tell whoever owns this service. Resolves when every channel has been tried; it does not throw,
 * and callers are not expected to await it before doing something more important.
 */
export async function notify(n: Notice): Promise<void> {
  const service = getService(n.serviceId);
  if (!service) return;
  const channels = listChannels(service.ownerKey).filter((c) => c.level === "all" || n.level === "halt");
  if (channels.length === 0) return;

  const payload = {
    warden: "1",
    level: n.level,
    service: service.name,
    serviceId: service.id,
    title: n.title,
    body: n.body,
    url: n.url,
    at: new Date().toISOString(),
    // Slack and Discord both render this field, so one payload reaches both without a per-vendor
    // adapter. Anything else receives the structured fields above and can ignore it.
    text: `*${service.name}* — ${n.title}\n${n.body}${n.url ? `\n${n.url}` : ""}`,
    content: `**${service.name}** — ${n.title}\n${n.body}${n.url ? `\n${n.url}` : ""}`,
  };

  await Promise.all(
    channels.map(async (c) => {
      // The URL was checked when it was added; it is checked again here because a stored row
      // outlives the form that made it, and this is the one place Warden makes an outbound request
      // to somewhere a person typed.
      const verdict = checkProbeUrl(c.url);
      if (!verdict.ok) {
        recordDelivery(c.id, false, verdict.reason ?? "that address is not allowed");
        return;
      }
      try {
        const res = await fetch(c.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT),
        });
        recordDelivery(c.id, res.ok, res.ok ? `${res.status}` : `${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
        if (res.ok) logEvent(service.id, "system", "notified", `${c.label} — ${n.title}`);
      } catch (e) {
        // A timeout, a DNS failure, a hook that was deleted. None of it is Warden's problem to
        // solve mid-incident; all of it is worth showing on the settings page.
        recordDelivery(c.id, false, e instanceof Error ? e.message : String(e));
      }
    }),
  );
}

/** Fire and forget, for the places where waiting on someone else's webhook would be absurd. */
export function notifyInBackground(n: Notice): void {
  void notify(n).catch(() => {});
}
