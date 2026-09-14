import {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  HookOrder,
  InterventionActions,
  InterventionHandler,
  type LocalAgent,
  type Plugin,
} from "@strands-agents/sdk";
import { contextFor, type PassContext } from "./pass-context";

/**
 * The rules Vigil will not break, written where a model cannot argue with them.
 *
 * A system prompt is a request. These are refusals. Each one is a property you can test, and
 * `src/agent/__tests__/guards.test.ts` tests them by feeding a deliberately jailbroken tool call
 * through the real path and asserting nothing reaches the board.
 *
 *   1. NO INVENTED RECORDS. A verdict may only name a government record that came back from a real
 *      HTTP response during this pass. Checked here at the hook layer and again inside the tool.
 *   2. NO ALARM ON A HUNCH. A `covers` verdict under the confidence floor is refused and the model
 *      is told to ask the owner instead. Vigil does not tell a parent their child's car seat is
 *      recalled because it thinks so.
 *   3. SEVERITY MUST BE EVIDENCED. `critical` is only allowed when the record's own text carries a
 *      critical marker — the government's flag, or its words about death, injury, fire or a crash.
 *      The model may not escalate a tone.
 *   4. NO CLEARING A BRAND MATCH. In a safety product the errors are not symmetric: a false alarm
 *      wastes five minutes, a false all-clear leaves a recalled dresser in a child's room. So when
 *      a record names the same brand as the thing, "clear" is refused outright. The agent must
 *      either say it covers, or ask. This one has already caught a real miss: a Babysense monitor
 *      recall was ruled clear because the label read VBM55RX and the household's said VBM55. It
 *      takes a brand match AND a word about the object itself, or every vitafusion recall in the
 *      corpus would become a question about one bottle of melatonin.
 *   5. NO COVERING A DATE WINDOW YOU CANNOT CHECK. Consumer-product recalls are usually scoped to a
 *      manufacture window, a lot or a serial range. If the record is scoped that way and nobody has
 *      told Vigil which unit this is, "covers" is refused — the honest answer is to ask the owner to
 *      go and look at the label. This is the most common reason Vigil stops and wakes someone.
 *   6. ONE SETTLED VERDICT PER RECORD. A second, contradicting "covers" or "clear" on the same
 *      record is refused — the first answer stands rather than being silently overwritten. An
 *      earlier "unsure" is not a verdict but an open question, and may still be settled.
 */

export const CONFIDENCE_FLOOR = 0.6;

/** A record scoped to a specific run of units rather than to a whole model. */
const WINDOWED = /(manufactur\w*\s+(from|between|in|during)|date\s?code|lot\s?number|tracking\s?(and|number)|serial\s?number|batch\s?number|printed on a label|sold between|purchased? (between|before|after))/i;

const CRITICAL_WORDS = /\b(death|die|fatal|serious injury|serious burn|strangulation|suffocation|entrapment|fire|burn hazard|crash|do not drive|park (it|outside)|ingestion)\b/i;

function candidateFor(ctx: PassContext, thingId: unknown, sourceId: unknown) {
  return ctx.candidates.find((c) => c.sourceId === sourceId && c.thingId === thingId);
}

function passOf(invocationState: Record<string, unknown> | undefined): PassContext | null {
  const passId = (invocationState as { passId?: string } | undefined)?.passId;
  if (!passId) return null;
  try {
    return contextFor(passId);
  } catch {
    return null;
  }
}

/** Hook-layer enforcement. Runs before the SDK's own handling, so a refusal costs nothing. */
export class VigilGuards implements Plugin {
  readonly name = "vigil:guards";
  /** every refusal, so the run can say honestly how often the guards fired. Bounded: this is a
   *  long-lived server process, and a diagnostic that grows forever is a leak. */
  static readonly refusals: { rule: string; detail: string }[] = [];
  private static note(rule: string, detail: string): void {
    VigilGuards.refusals.push({ rule, detail });
    if (VigilGuards.refusals.length > 200) VigilGuards.refusals.splice(0, VigilGuards.refusals.length - 200);
  }

  initAgent(agent: LocalAgent): void {
    agent.addHook(
      BeforeToolCallEvent,
      (e) => {
        if (e.toolUse.name !== "rule_on_candidate") return;
        const ctx = passOf(e.invocationState);
        if (!ctx) return;
        const input = (e.toolUse.input ?? {}) as { thingId?: string; sourceId?: string; verdict?: string; confidence?: number; severity?: string };
        const cand = candidateFor(ctx, input.thingId, input.sourceId);

        if (!cand) {
          VigilGuards.note("no-invented-records", String(input.sourceId));
          e.cancel = `Refused: no record "${input.sourceId}" came back for ${input.thingId} in this pass. Vigil writes findings only from records it actually fetched. Call list_candidates and rule on those.`;
          return;
        }
        if (input.verdict === "covers" && (input.confidence ?? 0) < CONFIDENCE_FLOOR) {
          VigilGuards.note("no-alarm-on-a-hunch", `${input.sourceId} at ${input.confidence}`);
          e.cancel = `Refused: ${Math.round((input.confidence ?? 0) * 100)}% is below Vigil's floor of ${CONFIDENCE_FLOOR * 100}% for telling someone their thing is recalled. Rule "unsure" instead and name the one fact that would settle it.`;
          return;
        }
        if (input.verdict === "clear") {
          const thing = ctx.things.find((t) => t.id === input.thingId);
          const brand = thing?.make?.trim().toLowerCase();
          const hay = `${cand.title} ${cand.summary}`.toLowerCase();
          // The brand alone is not enough: vitafusion Melatonin and vitafusion Fiber Well are the
          // same brand and different objects. It takes the brand AND something about the object.
          const tokens = [thing?.model, thing?.category, thing?.label]
            .filter((x): x is string => !!x)
            .flatMap((x) => x.toLowerCase().split(/[^a-z0-9]+/))
            .filter(Boolean);
          const long = tokens.filter((w) => w.length > 3);
          // A thing described only in short words ("cot", "car") must not fall out of this rule by
          // accident: with nothing long to match on, the brand alone is enough to make it ask.
          const alsoTheObject = long.length ? long.some((w) => hay.includes(w)) : true;
          if (brand && brand.length > 2 && hay.includes(brand) && alsoTheObject) {
            VigilGuards.note("no-clearing-a-brand-match", `${input.sourceId} names ${brand}`);
            e.cancel = `Refused: ${cand.sourceId} names "${thing?.make}", the same brand as this thing. A wrong all-clear leaves a dangerous object in someone's home, so Vigil does not allow one on a brand match. Rule "covers" if it fits, or "unsure" and name the ONE fact that would settle it.`;
            return;
          }
        }
        // "unsure" is not a verdict, it is a question. A later ruling may settle it; a second
        // "covers" or "clear" may not overwrite the first.
        const priorVerdict = ctx.ruled.get(`${input.thingId}::${input.sourceId}`);
        if (priorVerdict && priorVerdict !== "unsure") {
          VigilGuards.note("one-verdict-per-record", `${input.sourceId} already ${priorVerdict}`);
          e.cancel = `Refused: ${cand.sourceId} has already been ruled "${priorVerdict}" for this thing in this pass. A record gets one verdict. Move on to a record that has none.`;
          return;
        }
        if (input.verdict === "covers" && cand.source !== "nhtsa-recalls") {
          const thing = ctx.things.find((t) => t.id === input.thingId);
          const windowed = WINDOWED.test(`${cand.summary} ${cand.title}`);
          // A standing rule only settles the window if the owner actually said this unit matches.
          // Merely mentioning the record — "stop asking me about 26522" — does not.
          const settled = ctx.standing.some((r) => {
            const t = r.toLowerCase();
            return t.includes(cand.sourceId.toLowerCase()) && /answered\s+"?yes/.test(t);
          });
          const knowsWhichUnit = Boolean(thing?.acquiredAt) || settled;
          if (windowed && !knowsWhichUnit) {
            VigilGuards.note("no-covering-an-unchecked-window", cand.sourceId);
            e.cancel = `Refused: ${cand.sourceId} only covers units from a particular run — the record names a manufacture window, lot or serial. Nobody has told Vigil which unit this is, so you cannot say it covers. Rule "unsure" and put the exact thing the owner has to go and look at in "missing" — quote the record's own words about where the label is.`;
            return;
          }
        }
        if (input.severity === "critical") {
          const evidence = `${cand.summary} ${cand.consequence ?? ""} ${cand.title}`;
          if (!cand.parkIt && !cand.parkOutSide && !CRITICAL_WORDS.test(evidence)) {
            VigilGuards.note("severity-must-be-evidenced", String(input.sourceId));
            e.cancel = `Refused: "critical" is not supported by the record. ${cand.sourceId} carries no do-not-drive flag and its own words do not describe death, serious injury, fire or a crash. Use the severity the record supports.`;
          }
        }
      },
      { order: HookOrder.SDK_FIRST - 1 },
    );

    // A tool that refused itself is a correctable mistake, not a dead end: hand the reason back
    // exactly once, so a model that keeps insisting cannot spin.
    const retried = new Set<string>();
    agent.addHook(AfterToolCallEvent, (e) => {
      const r = e.result?.content?.[0];
      if (!r || r.type !== "textBlock") return;
      const key = e.toolUse.toolUseId;
      if (r.text.includes('"rejected":true') && !retried.has(key)) {
        retried.add(key);
        e.retry = true;
      }
    });
  }
}

/**
 * The declarative half of the same policy, as a Strands intervention. It states the boundary the
 * product is built around: Vigil may look at anything public, and may say anything it likes to the
 * person whose house it is — but nothing leaves this household without a human pressing a button.
 * `ask_owner` is allowed precisely because it is the stopping-and-asking tool.
 */
export class NothingLeavesTheHouse extends InterventionHandler {
  readonly name = "vigil:nothing-leaves-the-house";
  private static readonly OUTBOUND = /^(send_|post_|file_|submit_|email_|notify_)/;

  override beforeToolCall(event: BeforeToolCallEvent) {
    const name = event.toolUse.name;
    if (name === "ask_owner") return InterventionActions.proceed();
    if (NothingLeavesTheHouse.OUTBOUND.test(name)) {
      return InterventionActions.deny(
        "Vigil never speaks to anyone outside this household on its own. Use ask_owner: show the owner exactly what would be sent, and let them decide.",
      );
    }
    return InterventionActions.proceed();
  }
}
