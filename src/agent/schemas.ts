import { z } from "zod";

/**
 * The shapes the models are FORCED to produce. Strands turns each of these into a forced tool call
 * and validates it with zod before Vigil ever sees it, so a malformed reading is retried with the
 * validation error rather than acted on.
 */

/* ── intake: a drop becomes an inventory ──────────────────────────────────── */

export const ThingReadSchema = z.object({
  kind: z.enum(["vehicle", "product", "ingestible"]).describe("vehicle for anything with a VIN; ingestible for food, supplements, medicine, medical devices; product for everything else"),
  label: z.string().describe("what the owner would call it, in their words — 'Ayesha's car seat', not a SKU"),
  make: z.string().nullable().describe("the brand exactly as written on the object or the receipt, or null"),
  model: z.string().nullable().describe("the model name or number exactly as written, or null"),
  year: z.number().int().nullable().describe("model year if it is stated or decodable, else null. Never estimate a year."),
  identifier: z.string().nullable().describe("VIN, serial number, lot code or model number if visible, else null"),
  category: z.string().nullable().describe("the plain category a regulator would use: 'child restraint', 'crib', 'space heater', 'stroller', 'dietary supplement'"),
  secondHand: z.boolean().describe("true only if the source says it was bought used, inherited or handed down"),
  confidence: z.number().min(0).max(1).describe("how sure you are this object is what you say it is. Below 0.7 Vigil will ask rather than guess."),
  unknowns: z.array(z.string()).describe("what you could NOT read and would need to be told — e.g. 'the model year is not visible on the box'. Empty if nothing is missing."),
  note: z.string().nullable().describe("anything the owner said about it that matters, or null"),
});

export const InventorySchema = z.object({
  summary: z.string().describe("one or two plain sentences saying what you saw, in the second person: 'You've got a 2019 Honda Accord, a cot and…'"),
  things: z.array(ThingReadSchema).describe("one entry per distinct physical object. Do not invent objects that are not evidenced."),
});
export type Inventory = z.infer<typeof InventorySchema>;

/* ── triage: which federal source can possibly know about this thing ──────── */

export const TriageSchema = z.object({
  plan: z.array(
    z.object({
      thingId: z.string(),
      sources: z.array(z.enum(["nhtsa-recalls", "nhtsa-complaints", "cpsc-recalls", "openfda"])),
      /** the search terms the product lane should use — the model's real contribution here */
      terms: z.array(z.string()).describe("for cpsc-recalls and openfda: the words most likely to appear in a recall notice for this object. Brand and product noun first."),
      why: z.string().describe("one short clause: why these sources and not others"),
    }),
  ),
});
export type Triage = z.infer<typeof TriageSchema>;

/* ── match: does this government record cover THIS unit ───────────────────── */

export const MatchSchema = z.object({
  verdicts: z.array(
    z.object({
      thingId: z.string(),
      sourceId: z.string().describe("the government id of the record you are ruling on. It MUST be one you were shown."),
      verdict: z.enum(["covers", "clear", "unsure"]).describe("covers = this record is about this exact unit; clear = it is not; unsure = you cannot tell without knowing something the owner has not told you"),
      confidence: z.number().min(0).max(1),
      reason: z.string().describe("cite the fields you matched on and the fields that did not line up. Quote the record, do not paraphrase it."),
      missing: z.string().nullable().describe("if unsure: the ONE thing you would need to know to decide — a date code, a model year, a serial range. Else null."),
      severity: z.enum(["critical", "high", "watch"]).describe("critical only when the record itself says do-not-drive, fire, or risk of serious injury or death"),
    }),
  ),
});
export type Match = z.infer<typeof MatchSchema>;

/* ── patterns: strangers reporting the same failure, before any recall ────── */

export const PatternSchema = z.object({
  patterns: z.array(
    z.object({
      thingId: z.string(),
      clusterKey: z.string().describe("the cluster key you were shown"),
      real: z.boolean().describe("true only when these complaints describe ONE failure mode, not a grab-bag"),
      failure: z.string().describe("the failure in plain words, drawn from the complaints themselves"),
      severity: z.enum(["critical", "high", "watch"]),
      reason: z.string(),
    }),
  ),
});
export type Pattern = z.infer<typeof PatternSchema>;
