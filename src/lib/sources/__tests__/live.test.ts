/**
 * The only test that touches the internet. Off by default so CI and a plane stay green:
 *
 *   VIGIL_LIVE_TESTS=1 npx vitest run src/lib/sources
 *
 * It asks the five real endpoints the same questions `scripts/sources-smoke.ts` asks, and holds the
 * one claim the product makes about NHTSA's shape: the units-affected number exists on the campaign
 * endpoint and does not exist on the by-vehicle endpoint.
 */
import { describe, expect, it } from "vitest";
import { cpscRecent, isoDaysAgo } from "../cpsc";
import { nhtsaComplaintsByVehicle, nhtsaDecodeVin, nhtsaRecallByCampaign, nhtsaRecallsByVehicle } from "../nhtsa";
import { openFdaEnforcement } from "../openfda";

const live = process.env.VIGIL_LIVE_TESTS ? describe : describe.skip;
const fresh = { fresh: true } as const;

live("live federal sources", () => {
  it("NHTSA recalls answer for a 2019 Honda Accord", { timeout: 60_000 }, async () => {
    const res = await nhtsaRecallsByVehicle({ make: "honda", model: "accord", modelYear: 2019 }, fresh);
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBeGreaterThan(0);
    expect(res.rows[0].campaignNumber).toMatch(/^\d{2}[A-Z]\d+$/);
    // Verified 2026-09-14: this endpoint does not carry the units-affected figure.
    expect(res.rows.every((r) => r.potentialUnitsAffected === undefined)).toBe(true);
  });

  it("the campaign endpoint is where the units-affected number lives", { timeout: 60_000 }, async () => {
    const res = await nhtsaRecallByCampaign("20V314000", fresh);
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBeGreaterThan(0);
    expect(res.rows.some((r) => typeof r.potentialUnitsAffected === "number")).toBe(true);
  });

  it("NHTSA complaints answer", { timeout: 60_000 }, async () => {
    const res = await nhtsaComplaintsByVehicle({ make: "honda", model: "accord", modelYear: 2019 }, fresh);
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBeGreaterThan(0);
    expect(Number.isInteger(res.rows[0].odiNumber)).toBe(true);
  });

  it("vPIC decodes a VIN", { timeout: 60_000 }, async () => {
    const res = await nhtsaDecodeVin("1HGCV1F34KA123456", fresh);
    expect(res.ok).toBe(true);
    expect(res.rows[0].make).toBe("HONDA");
    expect(res.rows[0].modelYear).toBe("2019");
  });

  it("CPSC returns a recent corpus", { timeout: 90_000 }, async () => {
    const res = await cpscRecent(isoDaysAgo(90), fresh);
    expect(res.ok).toBe(true);
    expect(res.rowCount).toBeGreaterThan(0);
    expect(res.rows[0].recallNumber.length).toBeGreaterThan(0);
    expect(res.rows[0].sourceUrl.startsWith("https://")).toBe(true);
  });

  it("openFDA answers, and says so honestly when nothing matches", { timeout: 60_000 }, async () => {
    const hit = await openFdaEnforcement({ domain: "food", terms: ["infant formula"], limit: 5 }, fresh);
    expect(hit.ok).toBe(true);
    expect(hit.rowCount).toBeGreaterThan(0);
    expect(hit.rows[0].classification).toMatch(/^Class /);

    const miss = await openFdaEnforcement({ domain: "food", terms: ["zzzzqqqnotathing"], limit: 5 }, fresh);
    expect(miss.ok).toBe(true);
    expect(miss.rowCount).toBe(0);
    expect(miss.error).toBeUndefined();
  });
});
