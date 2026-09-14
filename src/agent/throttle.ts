import { InvokeModelStage, type LocalAgent, type Plugin } from "@strands-agents/sdk";

/**
 * ONE QUEUE FOR EVERY MODEL CALL IN THE PROCESS.
 *
 * Several incidents can be live at once, and each one is a graph that wants the model. That is the
 * right shape for the work and the wrong shape for a rate-limited endpoint — an earlier build of
 * this ran head first into `429 quota exceeded` and lost everything in flight.
 *
 * So the fan-out stays and the throttle goes underneath it, as Strands middleware on the model
 * stage: agents believe they are running in parallel, the gateway sees a queue. A 429 waits and
 * comes back rather than failing a node, because an operator that gives up on a rate limit is an
 * operator that quietly stops operating.
 */

const LIMIT = Number(process.env.WARDEN_MODEL_CONCURRENCY ?? 2);
const MAX_ATTEMPTS = Number(process.env.WARDEN_MODEL_ATTEMPTS ?? 6);

let inFlight = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (inFlight < LIMIT) {
    inFlight += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  inFlight += 1;
}

function release(): void {
  inFlight -= 1;
  waiting.shift()?.();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isRateLimited = (e: unknown): boolean => {
  const m = e instanceof Error ? e.message : String(e);
  return /\b(429|503|529)\b|rate.?limit|quota exceeded|too many requests|overloaded|temporarily busy|peak-hour/i.test(m);
};

/** What the throttle actually had to do, so the run can say so instead of looking effortless. */
export const throttleStats = { calls: 0, queued: 0, rateLimited: 0, waitedMs: 0 };

export class Throttled implements Plugin {
  readonly name = "vigil:throttled";

  initAgent(agent: LocalAgent): void {
    agent.addMiddleware(InvokeModelStage, async function* (context, next) {
      const queuedAt = Date.now();
      if (inFlight >= LIMIT) throttleStats.queued += 1;
      await acquire();
      throttleStats.waitedMs += Date.now() - queuedAt;
      throttleStats.calls += 1;
      try {
        for (let attempt = 1; ; attempt += 1) {
          try {
            return yield* next(context);
          } catch (e) {
            if (!isRateLimited(e) || attempt >= MAX_ATTEMPTS) throw e;
            throttleStats.rateLimited += 1;
            // Decorrelated backoff: 1.5s, 3s, 6s … with jitter, so retries do not re-collide.
            const base = Math.min(1500 * 2 ** (attempt - 1), 20_000);
            await sleep(base / 2 + Math.random() * (base / 2));
          }
        }
      } finally {
        release();
      }
    });
  }
}
