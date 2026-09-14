import { canOperate, hasMachine } from "./local";

/**
 * WHETHER A NEW INCIDENT GOES STRAIGHT TO THE AGENT.
 *
 * It does, nearly always — that is the product. Pure, so the sweep script stays a loop and the rule
 * has a test. The one thing that stops a handover is the daily ceiling per owner, which bounds what a
 * URL that is always down can cost in model calls.
 *
 * A service with no machine and no hook still gets handed over: the network reads are a real
 * investigation ("the name does not resolve", "Cloudflare answers 502 so the origin is down") and a
 * diagnosis is worth a model call even when there is no act to follow it. The note says so, so the
 * log reads as a choice rather than an oversight.
 */
export type Handover = { hand: true; note: string | null } | { hand: false; rule: "auto.capped"; note: string };

export function handoverVerdict(
  service: { host: string; repo?: string | null; process?: string | null; hookUrl?: string | null },
  usedToday: number,
  daily: number,
): Handover {
  if (usedToday >= daily) {
    return {
      hand: false,
      rule: "auto.capped",
      note: `Warden has investigated ${usedToday} problems for this owner in a day, which is the ceiling. This one was left for a person to hand over.`,
    };
  }
  if (!canOperate(service)) return { hand: true, note: "network only and no hook — Warden will diagnose, and hand it back" };
  if (!hasMachine(service)) return { hand: true, note: "network only, with a deploy hook — the one act Warden has here" };
  return { hand: true, note: null };
}
