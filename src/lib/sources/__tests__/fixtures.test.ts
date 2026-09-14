/**
 * The fixtures under `fixtures/sources/` are REAL responses, recorded with curl on 2026-09-14;
 * `fixtures/sources/_recorded.json` says which URL produced each one and which two were truncated
 * (only by dropping trailing rows — no field was edited). These tests hold the mapping to them, so
 * the day a federal API changes its shape the test fails instead of the product inventing a fact.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCpscRecalls } from "../cpsc";
import { parseNhtsaComplaints, parseNhtsaRecalls, parseVpicDecode } from "../nhtsa";
import { isOpenFdaNotFound, openFdaEndpoint, parseOpenFda } from "../openfda";
import { fdaDate, nhtsaDate } from "../types";

const meta = { fetchedAt: 1_757_000_000_000, latencyMs: 42 };

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../../../fixtures/sources/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("NHTSA recalls (recallsByVehicle, honda accord 2019)", () => {
  const endpoint = "https://api.nhtsa.gov/recalls/recallsByVehicle?make=honda&model=accord&modelYear=2019";
  const res = parseNhtsaRecalls(fixture("nhtsa-recalls-by-vehicle.json"), endpoint, meta);

  it("maps every row and keeps the source's own numbers", () => {
    expect(res.ok).toBe(true);
    expect(res.source).toBe("nhtsa-recalls");
    expect(res.endpoint).toBe(endpoint);
    expect(res.rowCount).toBe(6);
    expect(res.rows).toHaveLength(res.rowCount);
    expect(res.fetchedAt).toBe(meta.fetchedAt);
  });

  it("lifts fields verbatim, including NHTSA's own park-it flags", () => {
    const first = res.rows[0];
    expect(first.sourceId).toBe("20V314000");
    expect(first.campaignNumber).toBe("20V314000");
    expect(first.sourceUrl).toBe("https://api.nhtsa.gov/recalls/campaignNumber?campaignNumber=20V314000");
    expect(first.component).toBe("FUEL SYSTEM, GASOLINE:DELIVERY:FUEL PUMP");
    expect(first.parkIt).toBe(false);
    expect(first.parkOutSide).toBe(false);
    expect(first.overTheAirUpdate).toBe(false);
    expect(first.reportReceivedDate).toBe("28/05/2020");
    expect(first.consequence?.startsWith("If the fuel pump fails")).toBe(true);
    expect(first.make).toBe("HONDA");
    expect(first.modelYear).toBe("2019");
  });

  it("keeps the untouched JSON on every row", () => {
    const raws = (fixture("nhtsa-recalls-by-vehicle.json") as { results: unknown[] }).results;
    expect(res.rows[0].raw).toEqual(raws[0]);
    expect(res.rows.every((r) => typeof r.raw === "object" && r.raw !== null)).toBe(true);
  });

  it("never guesses the units affected: this endpoint does not carry it", () => {
    expect(res.rows.every((r) => r.potentialUnitsAffected === undefined)).toBe(true);
  });

  it("parses NHTSA's dd/MM/yyyy without inventing a date", () => {
    expect(nhtsaDate("28/05/2020")?.toISOString()).toBe("2020-05-28T00:00:00.000Z");
    expect(nhtsaDate("2020-05-28")).toBeUndefined();
    expect(nhtsaDate(undefined)).toBeUndefined();
  });
});

describe("NHTSA recalls (campaignNumber 20V314000)", () => {
  const endpoint = "https://api.nhtsa.gov/recalls/campaignNumber?campaignNumber=20V314000";
  const res = parseNhtsaRecalls(fixture("nhtsa-recall-by-campaign.json"), endpoint, meta);

  it("returns one row per affected vehicle in the campaign", () => {
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBe(14);
    expect(res.rows.every((r) => r.campaignNumber === "20V314000")).toBe(true);
  });

  it("is the only place the units-affected number lives", () => {
    expect(res.rows.every((r) => r.potentialUnitsAffected === 135995)).toBe(true);
  });
});

describe("NHTSA complaints (complaintsByVehicle, honda accord 2019)", () => {
  const endpoint = "https://api.nhtsa.gov/complaints/complaintsByVehicle?make=honda&model=accord&modelYear=2019";
  const res = parseNhtsaComplaints(fixture("nhtsa-complaints-by-vehicle.truncated.json"), endpoint, meta);

  it("maps the recorded rows", () => {
    expect(res.ok).toBe(true);
    expect(res.source).toBe("nhtsa-complaints");
    expect(res.rowCount).toBe(10);
  });

  it("keeps the ODI number, the harm counts and the products", () => {
    const first = res.rows[0];
    expect(first.odiNumber).toBe(11763349);
    expect(first.sourceId).toBe("11763349");
    // NHTSA has no per-complaint record endpoint, so the row points at the query that returned it.
    expect(first.sourceUrl).toBe(endpoint);
    expect(first.crash).toBe(false);
    expect(first.fire).toBe(false);
    expect(first.numberOfInjuries).toBe(0);
    expect(first.numberOfDeaths).toBe(0);
    expect(first.dateOfIncident).toBe("07/03/2024");
    expect(first.components).toBe("ENGINE");
    expect(first.vin).toBe("1HGCV1F34KA");
    expect(first.products[0]).toEqual({
      type: "Vehicle",
      productYear: "2019",
      productMake: "HONDA",
      productModel: "ACCORD",
      manufacturer: "Honda (American Honda Motor Co.)",
    });
  });
});

describe("vPIC VIN decode", () => {
  const endpoint = "https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/1HGCV1F34KA123456?format=json";
  const res = parseVpicDecode(fixture("nhtsa-vpic-decodevin.json"), endpoint, "1HGCV1F34KA123456", meta);

  it("decodes one vehicle", () => {
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBe(1);
    const v = res.rows[0];
    expect(v.vin).toBe("1HGCV1F34KA123456");
    expect(v.make).toBe("HONDA");
    expect(v.model).toBe("Accord");
    expect(v.modelYear).toBe("2019");
    expect(v.bodyClass).toBe("Sedan/Saloon");
    expect(v.trim).toBe("Sport");
  });

  it("turns vPIC's empty strings into undefined rather than blank claims", () => {
    const raw = (fixture("nhtsa-vpic-decodevin.json") as { Results: Record<string, string>[] }).Results[0];
    expect(raw.Series).toBe("");
    expect(res.rows[0].series).toBeUndefined();
  });

  it("surfaces vPIC's own decode diagnostics instead of hiding them", () => {
    expect(res.rows[0].errorCode).toBe("1");
    expect(res.rows[0].errorText).toContain("Check Digit");
  });

  it("keeps all 154 decoded fields in raw", () => {
    expect(Object.keys(res.rows[0].raw as Record<string, unknown>)).toHaveLength(154);
  });
});

describe("CPSC recalls", () => {
  const endpoint = "https://www.saferproducts.gov/RestWebServices/Recall?format=json&RecallDateStart=2026-06-01";
  const res = parseCpscRecalls(fixture("cpsc-recalls-recent.truncated.json"), endpoint, meta);

  it("maps the recorded corpus", () => {
    expect(res.ok).toBe(true);
    expect(res.source).toBe("cpsc-recalls");
    expect(res.rowCount).toBe(5);
  });

  it("keeps CPSC's own id, page, hazard text and unit count", () => {
    const first = res.rows[0];
    expect(first.recallId).toBe(10967);
    expect(first.recallNumber).toBe("26761");
    expect(first.sourceId).toBe("26761");
    expect(first.sourceUrl.startsWith("https://www.cpsc.gov/Recalls/")).toBe(true);
    expect(first.recallDate).toBe("2026-09-10T00:00:00");
    expect(first.products[0].numberOfUnits).toBe("About 179,739");
    expect(first.hazards[0].name).toContain("button cell");
    expect(first.injuries).toEqual(["None reported."]);
    expect(first.manufacturerCountries).toEqual(["China"]);
    expect(first.images.length).toBeGreaterThan(0);
    expect(first.remedies[0]).toContain("stop using the recalled toys");
  });

  it("flattens the name-wrapped lists CPSC uses", () => {
    // CPSC wraps every list item in an object: [{Name}], [{Country}], [{UPC}], [{Option}].
    expect(res.rows[0].retailers).toContain("California Cade Electronic, LLC, of Hacienda Heights, California");
    expect(res.rows.every((r) => r.retailers.every((x) => typeof x === "string"))).toBe(true);
    expect(res.rows.every((r) => r.remedyOptions.every((x) => typeof x === "string"))).toBe(true);
    // Only 10 of the 177 recorded rows carry UPCs and none is in the 5-row fixture, so the UPC
    // shape is asserted against a row in CPSC's own format instead of a claim about the fixture.
    const upcRow = [{
      RecallID: 1,
      RecallNumber: "26999",
      ProductUPCs: [{ UPC: "840059614922" }, { UPC: "840059615370" }],
      RemedyOptions: [{ Option: "Refund" }],
    }];
    const parsed = parseCpscRecalls(upcRow, endpoint, meta);
    expect(parsed.rows[0].upcs).toEqual(["840059614922", "840059615370"]);
    expect(parsed.rows[0].remedyOptions).toEqual(["Refund"]);
  });

  it("treats CPSC's 200-with-an-error-row as a failure, not as one recall", () => {
    // Recorded live: a malformed RecallDateStart earns HTTP 200 and a single row with RecallID 0
    // whose Title is the error. Believing it would tell an owner a heater recall exists.
    const bad = parseCpscRecalls(fixture("cpsc-error-row.json"), endpoint, meta);
    expect(bad.ok).toBe(false);
    expect(bad.rows).toEqual([]);
    expect(bad.rowCount).toBe(0);
    expect(bad.error).toContain("Error retrieving Recalls");
  });
});

describe("openFDA enforcement", () => {
  const endpoint = 'https://api.fda.gov/food/enforcement.json?search=product_description:"infant formula"&limit=3';
  const res = parseOpenFda(fixture("openfda-food-enforcement.json"), endpoint, "food", meta);

  it("maps the FDA's own classification and words", () => {
    expect(res.ok).toBe(true);
    expect(res.source).toBe("openfda");
    expect(res.rowCount).toBeGreaterThan(0);
    const first = res.rows[0];
    expect(first.sourceId).toBe(first.recallNumber);
    expect(first.recallNumber.length).toBeGreaterThan(0);
    expect(first.classification).toMatch(/^Class (I|II|III)$/);
    expect(typeof first.reasonForRecall).toBe("string");
    expect(first.productType).toBe("Food");
    expect(first.sourceUrl).toContain(encodeURIComponent(`recall_number:"${first.recallNumber}"`).replace(/%3A/g, ":").replace(/%22/g, "%22"));
  });

  it("points each row at the API record that proves it", () => {
    const url = openFdaEndpoint({ domain: "food", search: 'recall_number:"F-1021-2020"', limit: 1 });
    expect(url.startsWith("https://api.fda.gov/food/enforcement.json?search=")).toBe(true);
    expect(url).toContain("limit=1");
  });

  it("reads the FDA's 404 'no matches' as an answer, not a failure", () => {
    expect(isOpenFdaNotFound(404, fixture("openfda-not-found.json"))).toBe(true);
    expect(isOpenFdaNotFound(404, { error: { code: "SOMETHING_ELSE" } })).toBe(false);
    expect(isOpenFdaNotFound(500, fixture("openfda-not-found.json"))).toBe(false);
  });

  it("parses the FDA's yyyyMMdd without inventing a date", () => {
    expect(fdaDate("20260318")?.toISOString()).toBe("2026-03-18T00:00:00.000Z");
    expect(fdaDate("2026-03-18")).toBeUndefined();
  });
});
