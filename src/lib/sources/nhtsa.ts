/**
 * NHTSA — three faces, all keyless and public (verified answering 2026-09-14).
 *
 *  - `recallsByVehicle`  year/make/model → safety recalls, with NHTSA's own parkIt / parkOutSide flags.
 *  - `campaignNumber`    one campaign → the SAME row shape plus `PotentialNumberofUnitsAffected`,
 *                        which the by-vehicle endpoint does not carry. That number lives here and
 *                        nowhere else, so Vigil fetches it here rather than inventing it.
 *  - vPIC decodevinvalues  a VIN → ~154 decoded fields.
 *
 * NHTSA answers a malformed query with HTTP 400 and a body that reads `{"Count":0,"results":[]}`.
 * `getJson` treats any non-2xx as a failure, so that trap can never render as "no recalls".
 */
import { z } from "zod";
import { getJson, withQuery, type GetJsonOptions } from "./http";
import {
  sourceFail,
  sourceOk,
  type NhtsaComplaintProduct,
  type NhtsaComplaintRow,
  type NhtsaRecallRow,
  type SourceResult,
  type VpicVehicleRow,
} from "./types";

export const NHTSA_RECALLS_BY_VEHICLE = "https://api.nhtsa.gov/recalls/recallsByVehicle";
export const NHTSA_RECALLS_BY_CAMPAIGN = "https://api.nhtsa.gov/recalls/campaignNumber";
export const NHTSA_COMPLAINTS_BY_VEHICLE = "https://api.nhtsa.gov/complaints/complaintsByVehicle";
export const VPIC_DECODE_VIN = "https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues";

export interface VehicleQuery {
  make: string;
  model: string;
  modelYear: string | number;
}

const str = z.string().optional().catch(undefined);
const bool = z.boolean().optional().catch(undefined);
const num = z.number().optional().catch(undefined);

/** `results` must be an array of objects; every field inside is optional so one odd row survives. */
const envelope = z.object({
  Count: num,
  count: num,
  Message: str,
  message: str,
  results: z.array(z.unknown()),
});

const recallSchema = z.object({
  Manufacturer: str,
  NHTSACampaignNumber: str,
  parkIt: bool,
  parkOutSide: bool,
  overTheAirUpdate: bool,
  ReportReceivedDate: str,
  Component: str,
  Summary: str,
  Consequence: str,
  Remedy: str,
  Notes: str,
  ModelYear: str,
  Make: str,
  Model: str,
  NHTSAActionNumber: str,
  // The real casing on the campaignNumber endpoint. The other two are accepted in case NHTSA
  // ever normalises it; none of them is invented — whichever is present is used, else undefined.
  PotentialNumberofUnitsAffected: num,
  PotentialNumberOfUnitsAffected: num,
  potentialNumberOfUnitsAffected: num,
});

const complaintProductSchema = z.object({
  type: str,
  productYear: str,
  productMake: str,
  productModel: str,
  manufacturer: str,
});

const complaintSchema = z.object({
  odiNumber: num,
  manufacturer: str,
  crash: bool,
  fire: bool,
  numberOfInjuries: num,
  numberOfDeaths: num,
  dateOfIncident: str,
  dateComplaintFiled: str,
  vin: str,
  components: str,
  summary: str,
  products: z.array(z.unknown()).optional().catch(undefined),
});

/** The per-record URL for a recall: the campaign endpoint itself, which shows exactly this campaign. */
export function recallSourceUrl(campaignNumber: string): string {
  return withQuery(NHTSA_RECALLS_BY_CAMPAIGN, { campaignNumber });
}

function mapRecall(raw: unknown): NhtsaRecallRow | undefined {
  const parsed = recallSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const r = parsed.data;
  const campaignNumber = r.NHTSACampaignNumber?.trim();
  if (!campaignNumber) return undefined;
  return {
    sourceId: campaignNumber,
    sourceUrl: recallSourceUrl(campaignNumber),
    raw,
    campaignNumber,
    manufacturer: r.Manufacturer,
    parkIt: r.parkIt,
    parkOutSide: r.parkOutSide,
    overTheAirUpdate: r.overTheAirUpdate,
    reportReceivedDate: r.ReportReceivedDate,
    component: r.Component,
    summary: r.Summary,
    consequence: r.Consequence,
    remedy: r.Remedy,
    notes: r.Notes,
    modelYear: r.ModelYear,
    make: r.Make,
    model: r.Model,
    nhtsaActionNumber: r.NHTSAActionNumber,
    potentialUnitsAffected:
      r.PotentialNumberofUnitsAffected ?? r.PotentialNumberOfUnitsAffected ?? r.potentialNumberOfUnitsAffected,
  };
}

function mapComplaint(raw: unknown, endpoint: string): NhtsaComplaintRow | undefined {
  const parsed = complaintSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const c = parsed.data;
  if (typeof c.odiNumber !== "number") return undefined;
  const products: NhtsaComplaintProduct[] = (c.products ?? [])
    .map((p) => complaintProductSchema.safeParse(p))
    .flatMap((p) => (p.success ? [p.data] : []));
  return {
    sourceId: String(c.odiNumber),
    // NHTSA publishes no per-ODI record endpoint (`/complaints/odiNumber` answers 403), so the
    // honest link is the query that returned this complaint.
    sourceUrl: endpoint,
    raw,
    odiNumber: c.odiNumber,
    manufacturer: c.manufacturer,
    crash: c.crash,
    fire: c.fire,
    numberOfInjuries: c.numberOfInjuries,
    numberOfDeaths: c.numberOfDeaths,
    dateOfIncident: c.dateOfIncident,
    dateComplaintFiled: c.dateComplaintFiled,
    vin: c.vin,
    components: c.components,
    summary: c.summary,
    products,
  };
}

/** Parse a recalls body that has already been fetched. Exported so fixtures can be tested offline. */
export function parseNhtsaRecalls(
  body: unknown,
  endpoint: string,
  meta: { fetchedAt: number; latencyMs: number },
): SourceResult<NhtsaRecallRow> {
  const env = envelope.safeParse(body);
  if (!env.success) {
    return sourceFail("nhtsa-recalls", endpoint, `malformed response: ${env.error.issues[0]?.message ?? "unexpected shape"}`, meta);
  }
  const rows = env.data.results.flatMap((raw) => {
    const row = mapRecall(raw);
    return row ? [row] : [];
  });
  return sourceOk("nhtsa-recalls", endpoint, rows, meta);
}

export function parseNhtsaComplaints(
  body: unknown,
  endpoint: string,
  meta: { fetchedAt: number; latencyMs: number },
): SourceResult<NhtsaComplaintRow> {
  const env = envelope.safeParse(body);
  if (!env.success) {
    return sourceFail("nhtsa-complaints", endpoint, `malformed response: ${env.error.issues[0]?.message ?? "unexpected shape"}`, meta);
  }
  const rows = env.data.results.flatMap((raw) => {
    const row = mapComplaint(raw, endpoint);
    return row ? [row] : [];
  });
  return sourceOk("nhtsa-complaints", endpoint, rows, meta);
}

function badVehicle(query: VehicleQuery): string | undefined {
  if (!query.make?.trim()) return "make is required";
  if (!query.model?.trim()) return "model is required";
  const year = String(query.modelYear ?? "").trim();
  if (!/^\d{4}$/.test(year)) return "modelYear must be a four-digit year";
  return undefined;
}

/** Safety recalls for one year/make/model. No `potentialUnitsAffected` here — see `nhtsaRecallByCampaign`. */
export async function nhtsaRecallsByVehicle(
  query: VehicleQuery,
  options: GetJsonOptions = {},
): Promise<SourceResult<NhtsaRecallRow>> {
  const endpoint = withQuery(NHTSA_RECALLS_BY_VEHICLE, {
    make: query.make?.trim().toLowerCase(),
    model: query.model?.trim().toLowerCase(),
    modelYear: String(query.modelYear ?? "").trim(),
  });
  const problem = badVehicle(query);
  if (problem) return sourceFail("nhtsa-recalls", endpoint, problem, { latencyMs: 0 });
  const res = await getJson(endpoint, options);
  if (!res.ok) {
    return sourceFail("nhtsa-recalls", endpoint, res.error ?? "request failed", { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
  }
  return parseNhtsaRecalls(res.body, endpoint, { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
}

/**
 * One recall campaign, by its NHTSA campaign number.
 *
 * This is the ONLY endpoint that carries `PotentialNumberofUnitsAffected` (verified: absent from
 * recallsByVehicle for honda/ford/tesla/toyota; present here as 135995 for 20V314000). It returns one
 * row per affected make/model/year in the campaign — 14 rows for 20V314000 — all with the same
 * campaign number and the same units-affected figure.
 */
export async function nhtsaRecallByCampaign(
  campaignNumber: string,
  options: GetJsonOptions = {},
): Promise<SourceResult<NhtsaRecallRow>> {
  const id = campaignNumber?.trim().toUpperCase() ?? "";
  const endpoint = withQuery(NHTSA_RECALLS_BY_CAMPAIGN, { campaignNumber: id });
  if (!id) return sourceFail("nhtsa-recalls", endpoint, "campaignNumber is required", { latencyMs: 0 });
  const res = await getJson(endpoint, options);
  if (!res.ok) {
    return sourceFail("nhtsa-recalls", endpoint, res.error ?? "request failed", { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
  }
  return parseNhtsaRecalls(res.body, endpoint, { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
}

/**
 * How many units a campaign covers, straight from NHTSA. `undefined` means NHTSA did not say —
 * never a zero, never an estimate. `ok:false` on the result means we could not ask.
 */
export async function nhtsaUnitsAffected(
  campaignNumber: string,
  options: GetJsonOptions = {},
): Promise<{ units?: number; result: SourceResult<NhtsaRecallRow> }> {
  const result = await nhtsaRecallByCampaign(campaignNumber, options);
  const units = result.rows.find((r) => typeof r.potentialUnitsAffected === "number")?.potentialUnitsAffected;
  return { units, result };
}

/** Owner-filed ODI complaints for one year/make/model. Hundreds of rows is normal. */
export async function nhtsaComplaintsByVehicle(
  query: VehicleQuery,
  options: GetJsonOptions = {},
): Promise<SourceResult<NhtsaComplaintRow>> {
  const endpoint = withQuery(NHTSA_COMPLAINTS_BY_VEHICLE, {
    make: query.make?.trim().toLowerCase(),
    model: query.model?.trim().toLowerCase(),
    modelYear: String(query.modelYear ?? "").trim(),
  });
  const problem = badVehicle(query);
  if (problem) return sourceFail("nhtsa-complaints", endpoint, problem, { latencyMs: 0 });
  const res = await getJson(endpoint, options);
  if (!res.ok) {
    return sourceFail("nhtsa-complaints", endpoint, res.error ?? "request failed", { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
  }
  return parseNhtsaComplaints(res.body, endpoint, { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
}

const vpicEnvelope = z.object({
  Count: num,
  Message: str,
  Results: z.array(z.record(z.string(), z.unknown())),
});

/** vPIC fills unknown fields with "" (and sometimes "Not Applicable"). "" becomes undefined. */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

export function parseVpicDecode(
  body: unknown,
  endpoint: string,
  vin: string,
  meta: { fetchedAt: number; latencyMs: number },
): SourceResult<VpicVehicleRow> {
  const env = vpicEnvelope.safeParse(body);
  if (!env.success) {
    return sourceFail("nhtsa-vpic", endpoint, `malformed response: ${env.error.issues[0]?.message ?? "unexpected shape"}`, meta);
  }
  const rows = env.data.Results.map((raw): VpicVehicleRow => ({
    sourceId: text(raw.VIN) ?? vin,
    sourceUrl: endpoint,
    raw,
    vin: text(raw.VIN) ?? vin,
    make: text(raw.Make),
    model: text(raw.Model),
    modelYear: text(raw.ModelYear),
    manufacturer: text(raw.Manufacturer),
    bodyClass: text(raw.BodyClass),
    vehicleType: text(raw.VehicleType),
    driveType: text(raw.DriveType),
    doors: text(raw.Doors),
    engineCylinders: text(raw.EngineCylinders),
    displacementL: text(raw.DisplacementL),
    fuelTypePrimary: text(raw.FuelTypePrimary),
    plantCity: text(raw.PlantCity),
    plantCountry: text(raw.PlantCountry),
    series: text(raw.Series),
    trim: text(raw.Trim),
    errorCode: text(raw.ErrorCode),
    errorText: text(raw.ErrorText),
  }));
  return sourceOk("nhtsa-vpic", endpoint, rows, meta);
}

/**
 * Decode a VIN (full 17 characters, or a partial one — vPIC decodes what it can and says so in
 * ErrorCode/ErrorText, which we surface rather than swallow).
 */
export async function nhtsaDecodeVin(vin: string, options: GetJsonOptions = {}): Promise<SourceResult<VpicVehicleRow>> {
  const clean = (vin ?? "").trim().toUpperCase();
  const endpoint = `${VPIC_DECODE_VIN}/${encodeURIComponent(clean)}?format=json`;
  if (!/^[A-Z0-9*]{1,17}$/.test(clean)) {
    return sourceFail("nhtsa-vpic", endpoint, "vin must be 1-17 letters or digits", { latencyMs: 0 });
  }
  const res = await getJson(endpoint, options);
  if (!res.ok) {
    return sourceFail("nhtsa-vpic", endpoint, res.error ?? "request failed", { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
  }
  return parseVpicDecode(res.body, endpoint, clean, { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
}
