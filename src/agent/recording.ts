import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PassEmit } from "./pass-context";

/**
 * EVERY PASS IS RECORDED, AND A RECORDING CAN BE PLAYED BACK.
 *
 * A pass takes minutes and costs money, and the thing worth showing someone is what the agent did,
 * not the waiting. So each pass writes its own event stream to disk with the real timings, and the
 * board can replay one at its original tempo.
 *
 * The rule this file exists to hold: a replay is NEVER dressed up as a live run. `replayPass` sets
 * `replay: true` on every event and the board says, in words, which pass it is playing and when
 * that pass actually ran. Nothing is generated here — a recording can only contain events a real
 * run emitted, and if there is no recording there is nothing to play.
 */

const DIR = process.env.VIGIL_PASS_DIR ?? join(process.cwd(), "var", "passes");

export interface Recording {
  passId: string;
  householdId: string;
  recordedAt: number;
  model: string;
  /** ms since the start of the pass, so a replay keeps the run's own rhythm */
  events: { at: number; event: PassEmit }[];
}

export function recorder(passId: string, householdId: string, model: string): { note: (e: PassEmit) => void; save: () => void } {
  const t0 = Date.now();
  const events: { at: number; event: PassEmit }[] = [];
  return {
    note: (event) => events.push({ at: Date.now() - t0, event }),
    save: () => {
      try {
        if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
        const rec: Recording = { passId, householdId, recordedAt: t0, model, events };
        writeFileSync(join(DIR, `${passId}.json`), JSON.stringify(rec));
      } catch {
        // A recording is a convenience. Losing one must never fail a pass.
      }
    },
  };
}

export function loadRecording(passId: string): Recording | null {
  try {
    const raw = readFileSync(join(DIR, `${passId}.json`), "utf8");
    return JSON.parse(raw) as Recording;
  } catch {
    return null;
  }
}

/** The most recent recorded pass for a household — what "watch the last real pass" plays. */
export function latestRecording(householdId: string): Recording | null {
  try {
    if (!existsSync(DIR)) return null;
    const recs = readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadRecording(f.replace(/\.json$/, "")))
      .filter((r): r is Recording => !!r && r.householdId === householdId)
      .sort((a, b) => b.recordedAt - a.recordedAt);
    return recs[0] ?? null;
  } catch {
    return null;
  }
}

export function listRecordings(): Recording[] {
  try {
    if (!existsSync(DIR)) return [];
    return readdirSync(DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => loadRecording(f.replace(/\.json$/, "")))
      .filter((r): r is Recording => !!r)
      .sort((a, b) => b.recordedAt - a.recordedAt);
  } catch {
    return [];
  }
}

/**
 * Play a recording back at its own pace, capped so nothing drags. Every event carries `replay: true`
 * and the board labels the whole run with the moment it really happened.
 */
export async function replayPass(rec: Recording, send: (e: PassEmit & { replay?: true }) => void, opts: { speed?: number; maxGapMs?: number; signal?: AbortSignal } = {}): Promise<void> {
  const speed = opts.speed ?? 1;
  const maxGap = opts.maxGapMs ?? 2200;
  let last = 0;
  for (const { at, event } of rec.events) {
    const gap = Math.min((at - last) / speed, maxGap);
    last = at;
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    if (opts.signal?.aborted) return;
    send({ ...event, replay: true });
  }
}
