import { Agent, StructuredOutputError, type ContentBlockData } from "@strands-agents/sdk";
import { addThing, logEvent, type ThingInput } from "@/lib/db/vigil";
import { nhtsaDecodeVin } from "@/lib/sources";
import type { Thing } from "@/lib/db/schema";
import { makeModel, retryStrategy } from "./model";
import { Throttled } from "./throttle";
import { InventorySchema, type Inventory } from "./schemas";

/**
 * INTAKE. A photo of a shelf, a receipt, a VIN typed on a phone, or three words in a hurry, turned
 * into things Vigil can keep watch over.
 *
 * The one thing it must not do is be confident. A recall notice is a promise about a specific unit,
 * and a household inventory built out of guesses produces either false alarms about other people's
 * objects or, far worse, silence about your own. So the schema forces it to declare what it could
 * NOT read, and a thing with unknowns is still watched — Vigil just asks, later, rather than
 * inventing a model year.
 *
 * A VIN is never interpreted by the model. It goes to NHTSA's vPIC decoder and comes back as fact.
 */

const INTAKE_PROMPT = `You are Vigil's intake. You turn what someone dropped on you into a list of the physical
objects in their home that a safety regulator could ever issue a notice about.

What counts: vehicles, child car seats, cots and cribs, strollers, high chairs, heaters, fans, kettles,
air fryers, power tools, furniture that can tip, batteries and chargers, toys with small or button-cell
parts, food, supplements, medicines, medical devices.

What does not: software, services, clothes without a hazard, anything that is not a physical object.

Rules:
· Read what is actually there. If the box says "Graco 4Ever DLX" then make is "Graco" and model is
  "4Ever DLX". If the year is not written anywhere, year is null — NEVER estimate one.
· A registration plate is not a VIN. A VIN is 17 characters. Put it in identifier and leave make, model
  and year null if you are not certain of them; they will be decoded from the VIN by NHTSA, not by you.
· "unknowns" is the important field. List, in plain words, what you would need to be told: "the model year
  is not visible", "there is no serial number on this photo". An honest gap beats a confident guess.
· Set confidence below 0.7 for anything you are reading off a blurry photo or inferring from context.
· category should be the words a regulator uses: "child restraint", "crib", "portable heater", "stroller",
  "dietary supplement", "button cell battery toy".
· The summary is two plain sentences to the owner, in the second person. No preamble.`;

export interface IntakeInput {
  householdId: string;
  caption?: string;
  drop: { kind: "text"; text: string } | { kind: "image"; bytes: Uint8Array; format: "png" | "jpeg" | "webp" };
}

export interface IntakeResult {
  inventory: Inventory;
  things: Thing[];
  decoded: number;
  model: string;
}

const VIN = /^[A-HJ-NPR-Z0-9]{17}$/i;

export async function readInventory(input: IntakeInput): Promise<IntakeResult> {
  const made = makeModel("intake");
  const agent = new Agent({
    id: "intake",
    name: "Intake",
    description: "Turns a drop into an inventory Vigil can watch.",
    model: made.instance,
    systemPrompt: INTAKE_PROMPT,
    structuredOutputSchema: InventorySchema,
    retryStrategy: retryStrategy(),
    plugins: [new Throttled()],
    traceAttributes: { "vigil.node": "intake", "vigil.household_id": input.householdId },
    printer: false,
  });

  const lead = input.caption ? `The owner added: "${input.caption}". ` : "";
  const blocks: ContentBlockData[] =
    input.drop.kind === "text"
      ? [{ text: `${lead}Read this into the things in their home:\n\n${input.drop.text}` }]
      : [{ text: `${lead}Read this photo into the things in their home.` }, { image: { format: input.drop.format, source: { bytes: input.drop.bytes } } }];

  let inventory: Inventory;
  try {
    const result = await agent.invoke(blocks);
    inventory = InventorySchema.parse(result.structuredOutput);
  } catch (e) {
    if (e instanceof StructuredOutputError) throw new Error(`Vigil could not read that into a list of things: ${e.message}`);
    throw e;
  }

  const saved: Thing[] = [];
  let decoded = 0;
  for (const t of inventory.things) {
    const patch: ThingInput = {
      kind: t.kind,
      label: t.label,
      make: t.make,
      model: t.model,
      year: t.year,
      identifier: t.identifier,
      category: t.category,
      secondHand: t.secondHand,
      note: t.note,
      confidence: t.confidence,
      unknowns: t.unknowns,
      addedVia: input.drop.kind === "image" ? "photo" : "typed",
    };

    // A VIN is decoded by NHTSA, never by the model.
    if (t.identifier && VIN.test(t.identifier.trim())) {
      const res = await nhtsaDecodeVin(t.identifier.trim().toUpperCase());
      const row = res.rows[0];
      if (res.ok && row) {
        decoded += 1;
        patch.make = row.make ?? patch.make;
        patch.model = row.model ?? patch.model;
        patch.year = row.modelYear ? Number(row.modelYear) : patch.year;
        patch.kind = "vehicle";
        patch.decoded = row.raw;
        patch.addedVia = "vin";
        patch.confidence = 1;
        patch.unknowns = t.unknowns.filter((u) => !/year|make|model/i.test(u));
      }
    }
    saved.push(addThing(input.householdId, patch));
  }

  logEvent(input.householdId, "intake", "read", `${saved.length} thing(s)${decoded ? `, ${decoded} VIN decoded by NHTSA` : ""}`);
  return { inventory, things: saved, decoded, model: made.id };
}
