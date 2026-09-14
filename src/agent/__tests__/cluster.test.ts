/**
 * The two pieces of arithmetic Vigil does for itself, so that no model ever has to.
 *
 *   `clusterComplaints` turns a pile of strangers' complaints into counts — crashes, fires,
 *   injuries, deaths — and a timeline. The model is later shown the counts and asked whether they
 *   describe ONE failure; it is never asked to do the counting.
 *
 *   `scoreCpsc` narrows a corpus of thousands of consumer-product recalls down to the handful worth
 *   reading. Code narrows; the model judges the shortlist.
 *
 * The federal sources are mocked here. Nothing in this file touches the network or a model.
 */
import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";

/** The DB path has to be set before anything under src/lib/db is imported, so it is set up here. */
const DB_FILE = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR ?? "/tmp").replace(/\/+$/, "");
  const path = `${tmp}/vigil-cluster-${process.pid}-${Date.now()}/vigil.db`;
  process.env.VIGIL_DB_PATH = path;
  (globalThis as { __vigilDb?: unknown }).__vigilDb = undefined;
  return path;
});

vi.mock("@/lib/sources", () => ({
  nhtsaRecallsByVehicle: vi.fn(),
  nhtsaRecallByCampaign: vi.fn(),
  nhtsaComplaintsByVehicle: vi.fn(),
  cpscRecent: vi.fn(),
  openFdaEnforcement: vi.fn(),
}));

import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { addThing, createHousehold, startPass } from "@/lib/db/vigil";
import type { Thing } from "@/lib/db/schema";
import { nhtsaComplaintsByVehicle } from "@/lib/sources";
import type { CpscRecallRow, NhtsaComplaintRow } from "@/lib/sources/types";
import { sourceOk } from "@/lib/sources/types";
import type { ToolContext } from "@strands-agents/sdk";
import { openContext, type Candidate, type PassContext, type PassEmit } from "../pass-context";
import { clusterComplaints, nhtsaComplaints, scoreCpsc } from "../tools";

afterAll(() => {
  rmSync(dirname(DB_FILE), { recursive: true, force: true });
});

/* ── fixtures ─────────────────────────────────────────────────────────────── */

const complaint = (p: Partial<NhtsaComplaintRow> & { odiNumber: number }): NhtsaComplaintRow => ({
  sourceId: String(p.odiNumber),
  sourceUrl: `https://api.nhtsa.gov/complaints/complaintsByVehicle#${p.odiNumber}`,
  raw: {},
  products: [],
  ...p,
});

const many = (n: number, make: (i: number) => Partial<NhtsaComplaintRow>, from = 0): NhtsaComplaintRow[] =>
  Array.from({ length: n }, (_, i) => complaint({ odiNumber: from + i, ...make(i) }));

const cpscRow = (p: Partial<CpscRecallRow>): CpscRecallRow => ({
  sourceId: "24-123",
  sourceUrl: "https://www.cpsc.gov/Recalls/2026/24-123",
  raw: {},
  recallId: 1,
  recallNumber: "24-123",
  products: [],
  hazards: [],
  remedies: [],
  remedyOptions: [],
  injuries: [],
  images: [],
  manufacturers: [],
  retailers: [],
  importers: [],
  distributors: [],
  manufacturerCountries: [],
  upcs: [],
  inconjunctions: [],
  ...p,
});

/* ── clusterComplaints ────────────────────────────────────────────────────── */

describe("clusterComplaints", () => {
  const rows: NhtsaComplaintRow[] = [
    complaint({ odiNumber: 1, components: "ELECTRICAL SYSTEM, ENGINE", dateOfIncident: "05/03/2024", crash: true, numberOfInjuries: 2 }),
    complaint({ odiNumber: 2, components: "ELECTRICAL SYSTEM", dateOfIncident: "01/01/2023", fire: true, numberOfDeaths: 1 }),
    complaint({
      odiNumber: 3,
      components: "electrical system, exterior lighting",
      dateOfIncident: "20/12/2025",
      numberOfInjuries: 1,
      summary: "THE CAR SHUT OFF COMPLETELY WHILE I WAS DRIVING ON THE MOTORWAY WITH MY TWO CHILDREN IN THE BACK SEAT.",
    }),
    complaint({ odiNumber: 4, components: "STEERING", dateOfIncident: "09/09/2024", crash: true }),
  ];

  it("groups by the first component token, case-folded, and sorts the biggest group first", () => {
    const clusters = clusterComplaints("th_1", rows);
    expect(clusters.map((c) => c.component)).toEqual(["ELECTRICAL SYSTEM", "STEERING"]);
    expect(clusters[0]!.key).toBe("th_1:ELECTRICAL SYSTEM");
    expect(clusters[0]!.count).toBe(3);
    expect(clusters[0]!.odiNumbers).toEqual(["1", "2", "3"]);
  });

  it("does the counting itself: crashes, fires, injuries, deaths", () => {
    const [electrical, steering] = clusterComplaints("th_1", rows);
    expect(electrical).toMatchObject({ crashes: 1, fires: 1, injuries: 3, deaths: 1 });
    expect(steering).toMatchObject({ count: 1, crashes: 1, fires: 0, injuries: 0, deaths: 0 });
  });

  it("reads NHTSA's dd/MM/yyyy the way NHTSA means it", () => {
    const [electrical] = clusterComplaints("th_1", rows);
    // 05/03/2024 is the fifth of March, not the third of May.
    expect(electrical!.firstAt).toBe("2023-01-01");
    expect(electrical!.lastAt).toBe("2025-12-20");
  });

  it("keeps a timeline of one point per real complaint, sorted ascending", () => {
    const [electrical] = clusterComplaints("th_1", rows);
    expect(electrical!.timeline).toEqual([Date.UTC(2023, 0, 1), Date.UTC(2024, 2, 5), Date.UTC(2025, 11, 20)]);
    expect([...electrical!.timeline].sort((a, b) => a - b)).toEqual(electrical!.timeline);
  });

  it("drops a date it cannot read rather than inventing one", () => {
    const [only] = clusterComplaints("th_1", [
      complaint({ odiNumber: 9, components: "BRAKES", dateOfIncident: "2024-03-05" }),
      complaint({ odiNumber: 10, components: "BRAKES", dateOfIncident: "11/11/2024" }),
      complaint({ odiNumber: 11, components: "BRAKES" }),
    ]);
    expect(only!.count).toBe(3);
    expect(only!.timeline).toEqual([Date.UTC(2024, 10, 11)]);
    expect(only!.firstAt).toBe("2024-11-11");
  });

  it("files a complaint with no component under UNSPECIFIED, and quotes a complaint long enough to be worth quoting", () => {
    const clusters = clusterComplaints("th_1", [complaint({ odiNumber: 12 }), ...rows]);
    expect(clusters.some((c) => c.component === "UNSPECIFIED")).toBe(true);
    const electrical = clusters.find((c) => c.component === "ELECTRICAL SYSTEM");
    expect(electrical!.quoteOdi).toBe("3");
    expect(electrical!.quote).toContain("SHUT OFF COMPLETELY");
    // The two short complaints in the same group are not quoted.
    expect(clusters.find((c) => c.component === "STEERING")!.quote).toBeNull();
  });
});

/* ── the caller's filter around it ────────────────────────────────────────── */

describe("the filter the complaints tool puts around the clusters", () => {
  const household = createHousehold({ ownerKey: "test:cluster", name: "the test house" });
  const car: Thing = addThing(household.id, { kind: "vehicle", label: "the Accord", make: "Honda", model: "Accord", year: 2019 });

  let ctx: PassContext;
  let emitted: PassEmit[];

  const recallCandidate: Candidate = {
    sourceId: "20V314000",
    source: "nhtsa-recalls",
    sourceUrl: null,
    thingId: car.id,
    title: "Battery cable may short",
    summary: "The battery cable may short.",
    consequence: null,
    remedy: null,
    component: "ELECTRICAL SYSTEM:12V/24V/48V BATTERY:CABLE",
    unitsAffected: null,
    date: null,
    raw: {},
  };

  beforeEach(() => {
    emitted = [];
    const pass = startPass(household.id, "manual");
    ctx = openContext({
      passId: pass.id,
      householdId: household.id,
      things: [car],
      standing: [],
      expected: [],
      emit: (e) => emitted.push(e),
    });
    ctx.candidates.push({ ...recallCandidate });
    vi.mocked(nhtsaComplaintsByVehicle).mockResolvedValue(
      sourceOk(
        "nhtsa-complaints",
        "https://api.nhtsa.gov/complaints/complaintsByVehicle?make=honda&model=accord&modelYear=2019",
        [
          ...many(13, () => ({ components: "ELECTRICAL SYSTEM, ENGINE", dateOfIncident: "05/03/2024" }), 100),
          ...many(12, () => ({ components: "STEERING", dateOfIncident: "06/03/2024" }), 200),
          ...many(11, () => ({ components: "SUSPENSION", dateOfIncident: "07/03/2024" }), 300),
          ...many(14, () => ({ components: "UNKNOWN OR OTHER", dateOfIncident: "08/03/2024" }), 400),
        ],
        { fetchedAt: 1_757_000_000_000, latencyMs: 12 },
      ),
    );
  });

  /** The tool only reads `invocationState` off its context; nothing else here is exercised. */
  const context = (): ToolContext => ({ invocationState: { passId: ctx.passId } }) as unknown as ToolContext;

  it("drops the component a recall already covers, the groups too small to mean anything, and UNKNOWN OR OTHER", async () => {
    const out = (await nhtsaComplaints.invoke({ thingId: car.id }, context())) as { ok: boolean; complaints: number; clusters: { component: string; count: number }[] };
    expect(out.ok).toBe(true);
    expect(out.complaints).toBe(50);
    // ELECTRICAL SYSTEM is already covered by campaign 20V314000; SUSPENSION has 11, under the floor
    // of 12; UNKNOWN OR OTHER is NHTSA's shrug. Only STEERING is a pattern worth showing.
    expect(out.clusters.map((c) => c.component)).toEqual(["STEERING"]);
    expect(out.clusters[0]!.count).toBe(12);
    expect(ctx.clusters.map((c) => c.component)).toEqual(["STEERING"]);
    expect(emitted.filter((e) => e.kind === "cluster")).toHaveLength(1);
  });

  it("keeps the component once no recall covers it", async () => {
    ctx.candidates.length = 0;
    const out = (await nhtsaComplaints.invoke({ thingId: car.id }, context())) as { clusters: { component: string }[] };
    expect(out.clusters.map((c) => c.component)).toEqual(["ELECTRICAL SYSTEM", "STEERING"]);
  });

  it("records the check before it looks at a single row", async () => {
    await nhtsaComplaints.invoke({ thingId: car.id }, context());
    expect(ctx.done.has(`${car.id}::nhtsa-complaints`)).toBe(true);
    expect(emitted.filter((e) => e.kind === "check.done")).toHaveLength(1);
  });
});

/* ── scoreCpsc ────────────────────────────────────────────────────────────── */

describe("scoreCpsc", () => {
  const graco = cpscRow({
    title: "Graco Recalls 4Ever DLX Child Restraint Systems",
    description: "This recall involves Graco 4Ever DLX 4-in-1 car seats.",
    products: [{ name: "Child restraint system", model: "4Ever DLX" }],
    manufacturers: ["Graco Children's Products Inc."],
  });
  const heater = cpscRow({
    recallNumber: "24-999",
    title: "Lasko Recalls Ceramic Space Heaters",
    description: "The heater's base can overheat.",
    products: [{ name: "Space heater" }],
    manufacturers: ["Lasko Products LLC"],
  });

  it("scores a whole multi-word phrase above a single word", () => {
    expect(scoreCpsc(graco, ["graco 4ever"])).toBe(3);
    expect(scoreCpsc(graco, ["graco"])).toBe(2);
    expect(scoreCpsc(graco, ["graco 4ever"])).toBeGreaterThan(scoreCpsc(graco, ["graco"]));
  });

  it("gives an unrelated record nothing at all", () => {
    expect(scoreCpsc(heater, ["graco 4ever", "child restraint"])).toBe(0);
  });

  it("ignores casing and surrounding whitespace on both sides", () => {
    expect(scoreCpsc(graco, ["  GRACO 4Ever  "])).toBe(3);
    expect(scoreCpsc(graco, ["CHILD RESTRAINT"])).toBe(3);
  });

  it("gives a half point per long word when the phrase itself is not there", () => {
    // "graco stroller" is not in the record; "graco" is, "stroller" is not.
    expect(scoreCpsc(graco, ["graco stroller"])).toBe(0.5);
    // Words of three letters or fewer are too cheap to count.
    expect(scoreCpsc(graco, ["car nope"])).toBe(0);
  });

  it("adds the terms up, so the corpus sorts by how much of the thing a record names", () => {
    expect(scoreCpsc(graco, ["graco 4ever", "child restraint", "car seat"])).toBe(9);
    expect(scoreCpsc(graco, [""])).toBe(0);
  });

  it("reads the manufacturer list, not just the title", () => {
    expect(scoreCpsc(graco, ["lasko"])).toBe(0);
    expect(scoreCpsc(heater, ["lasko products"])).toBe(3);
  });
});
