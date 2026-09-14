/**
 * How a problem's status is said out loud, in one place. One word each, so a chip reads at a glance.
 *
 * There are two ways a run can end without a fix and they are not the same thing, which is the
 * whole reason this file exists. `waiting` means Warden worked out what to do, the owner's rules said the
 * decision was the owner's, and the run is genuinely stopped mid-flight holding that question.
 * `escalated` means it is handing the problem back: it could not find a cause, or nothing it was
 * allowed to do helped, or it acted and the check still fails. A product whose headline claim is
 * "it stops and asks you" cannot show both of those with the same word.
 *
 * Every chip in the app reads from here. The statuses and the words that describe them were two
 * lists before, and they had already drifted.
 */
export type Tone = "ok" | "warn" | "down" | "accent";

export interface StatusChip {
  label: string;
  tone: Tone;
}

export function statusChip(status: string): StatusChip {
  switch (status) {
    case "resolved":
      return { label: "fixed", tone: "ok" };
    case "waiting":
      return { label: "needs you", tone: "warn" };
    case "escalated":
      return { label: "handed back", tone: "warn" };
    case "investigating":
      return { label: "looking", tone: "accent" };
    case "acting":
      return { label: "fixing", tone: "accent" };
    case "verifying":
      return { label: "checking", tone: "accent" };
    case "open":
      return { label: "new", tone: "down" };
    default:
      return { label: status, tone: "down" };
  }
}

/** The run stopped on a question rather than finishing. */
export const isHalted = (status: string): boolean => status === "waiting";

export const chipClass = (status: string): string => `chip is-${statusChip(status).tone}`;
