/**
 * Government APIs return odd things: a string where an array belongs, a null row, a new casing, an
 * HTML error page with a 200. None of that may throw at a call site, and none of it may pass for
 * "we checked and your things are fine". Every case here must end as `ok:false, rows: []` with a
 * reason, or as a good result that quietly skipped the one unusable row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cpscRecalls, parseCpscRecalls } from "../cpsc";
import { nhtsaComplaintsByVehicle, nhtsaDecodeVin, nhtsaRecallByCampaign, nhtsaRecallsByVehicle, parseNhtsaComplaints, parseNhtsaRecalls, parseVpicDecode } from "../nhtsa";
import { openFdaEnforcement, parseOpenFda } from "../openfda";

const meta = { fetchedAt: 1_757_000_000_000, latencyMs: 7 };
const junk: unknown[] = [null, undefined, 42, "a string", [], {}, { results: "not an array" }, { results: null }, { Results: 7 }];

afterEach(() => vi.unstubAllGlobals());

describe("a malformed payload is ok:false, never a crash and never 'clean'", () => {
  it("NHTSA recalls", () => {
    for (const body of junk) {
      const res = parseNhtsaRecalls(body, "https://api.nhtsa.gov/recalls/recallsByVehicle?make=x", meta);
      expect(res.ok).toBe(false);
      expect(res.rows).toEqual([]);
      expect(res.rowCount).toBe(0);
      expect(res.error).toBeTruthy();
      expect(res.endpoint).toContain("nhtsa");
      expect(res.fetchedAt).toBe(meta.fetchedAt);
    }
  });

  it("NHTSA complaints", () => {
    for (const body of junk) {
      const res = parseNhtsaComplaints(body, "https://api.nhtsa.gov/complaints/complaintsByVehicle?make=x", meta);
      expect(res.ok).toBe(false);
      expect(res.rows).toEqual([]);
    }
  });

  it("vPIC", () => {
    for (const body of junk) {
      const res = parseVpicDecode(body, "https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/X?format=json", "X", meta);
      expect(res.ok).toBe(false);
      expect(res.rows).toEqual([]);
    }
  });

  it("CPSC (the endpoint returns a bare array, so an object is malformed)", () => {
    for (const body of [null, 42, "x", {}, { Recalls: [] }]) {
      const res = parseCpscRecalls(body, "https://www.saferproducts.gov/RestWebServices/Recall?format=json", meta);
      expect(res.ok).toBe(false);
      expect(res.rows).toEqual([]);
    }
  });

  it("openFDA", () => {
    for (const body of junk) {
      const res = parseOpenFda(body, "https://api.fda.gov/food/enforcement.json", "food", meta);
      expect(res.ok).toBe(false);
      expect(res.rows).toEqual([]);
    }
  });
});

describe("one odd row does not kill the response", () => {
  it("keeps the good NHTSA rows and drops the unusable one", () => {
    const body = {
      Count: 3,
      results: [
        { NHTSACampaignNumber: "24V123000", Component: "BRAKES", parkIt: true },
        null,
        "surprise",
        { Component: "no campaign number, so unusable as a citation" },
        { NHTSACampaignNumber: "24V999000", Component: 12345, Summary: null, parkIt: "yes please" },
      ],
    };
    const res = parseNhtsaRecalls(body, "https://api.nhtsa.gov/recalls/recallsByVehicle?make=x", meta);
    expect(res.ok).toBe(true);
    expect(res.rows.map((r) => r.campaignNumber)).toEqual(["24V123000", "24V999000"]);
    expect(res.rows[0].parkIt).toBe(true);
    // A field of the wrong type is dropped rather than coerced into a claim.
    expect(res.rows[1].component).toBeUndefined();
    expect(res.rows[1].parkIt).toBeUndefined();
    expect(res.rowCount).toBe(2);
  });

  it("keeps the good CPSC rows", () => {
    const body = [
      { RecallID: 1, RecallNumber: "26001", Title: "Fine", Hazards: "not a list" },
      { RecallID: 0, RecallNumber: null },
      { RecallNumber: "26002" },
      42,
    ];
    const res = parseCpscRecalls(body, "https://www.saferproducts.gov/RestWebServices/Recall?format=json", meta);
    expect(res.ok).toBe(true);
    expect(res.rows.map((r) => r.recallNumber)).toEqual(["26001"]);
    expect(res.rows[0].hazards).toEqual([]);
  });

  it("keeps the good openFDA rows", () => {
    const body = { meta: {}, results: [{ recall_number: "F-1-2026", classification: "Class I" }, {}, null] };
    const res = parseOpenFda(body, "https://api.fda.gov/food/enforcement.json", "food", meta);
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].classification).toBe("Class I");
  });
});

describe("bad input never reaches the network", () => {
  it("refuses an incomplete vehicle, a blank campaign, a bad VIN and a bad CPSC date", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const cases = await Promise.all([
      nhtsaRecallsByVehicle({ make: "", model: "accord", modelYear: 2019 }),
      nhtsaRecallsByVehicle({ make: "honda", model: "accord", modelYear: "twenty" }),
      nhtsaComplaintsByVehicle({ make: "honda", model: "", modelYear: 2019 }),
      nhtsaRecallByCampaign("  "),
      nhtsaDecodeVin("not a vin!"),
      cpscRecalls({ recallDateStart: "notadate" }),
    ]);

    for (const res of cases) {
      expect(res.ok).toBe(false);
      expect(res.rows).toEqual([]);
      expect(res.error).toBeTruthy();
      expect(res.endpoint.startsWith("https://")).toBe(true);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("a source that cannot be reached is not a source that found nothing", () => {
  it("every source function returns ok:false rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.nhtsa.gov");
    }));

    const results = await Promise.all([
      nhtsaRecallsByVehicle({ make: "honda", model: "accord", modelYear: 2019 }, { retries: 0, cacheTtlMs: 0 }),
      nhtsaComplaintsByVehicle({ make: "honda", model: "accord", modelYear: 2019 }, { retries: 0, cacheTtlMs: 0 }),
      nhtsaDecodeVin("1HGCV1F34KA123456", { retries: 0, cacheTtlMs: 0 }),
      cpscRecalls({ recallDateStart: "2026-06-01" }, { retries: 0, cacheTtlMs: 0 }),
      openFdaEnforcement({ domain: "food", terms: ["infant formula"] }, { retries: 0, cacheTtlMs: 0 }),
    ]);

    expect(results.map((r) => r.source)).toEqual(["nhtsa-recalls", "nhtsa-complaints", "nhtsa-vpic", "cpsc-recalls", "openfda"]);
    for (const res of results) {
      expect(res.ok).toBe(false);
      expect(res.rows).toEqual([]);
      expect(res.rowCount).toBe(0);
      expect(res.error).toContain("ENOTFOUND");
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("openFDA's 404 'no matches' is the one 4xx that means an answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "No matches found!" } }), { status: 404 })));
    const res = await openFdaEnforcement({ domain: "food", terms: ["nothing matches this"] }, { cacheTtlMs: 0 });
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBe(0);
    expect(res.error).toBeUndefined();
  });

  it("but a real openFDA error is still an error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "OVER_RATE_LIMIT" } }), { status: 429 })));
    const res = await openFdaEnforcement({ domain: "food", terms: ["x"] }, { retries: 0, cacheTtlMs: 0 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("HTTP 429");
  });
});
