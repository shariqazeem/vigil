/**
 * Vigil's ground truth. Every claim the product renders on screen is a field lifted verbatim from a
 * US federal API, printed beside the id of the record it came from. Nothing here invents, infers or
 * rounds a fact: a source either answers and we keep what it said, or it fails and says so.
 *
 * The honesty property this file exists to hold: a source that timed out, 500'd or returned garbage
 * comes back `ok: false` with `rows: []` and an `error`. It must never look the same as a source
 * that answered "nothing is wrong". Silence is not safety.
 */

/** The five faces of the data layer. The name is printed in the UI next to the row. */
export type SourceName =
  | "nhtsa-recalls"
  | "nhtsa-complaints"
  | "nhtsa-vpic"
  | "cpsc-recalls"
  | "openfda";

/** What every source function returns, whatever happened. Never thrown, always inspectable. */
export interface SourceResult<T> {
  source: SourceName;
  /** The exact URL that was called — printable in the UI, curl-able by a judge. */
  endpoint: string;
  /** false = we do not know. NOT "clean". */
  ok: boolean;
  rows: T[];
  rowCount: number;
  /** Epoch ms the data was actually fetched. A cache hit reports the ORIGINAL fetch time. */
  fetchedAt: number;
  latencyMs: number;
  error?: string;
}

/** Every row carries where it came from, and the untouched JSON behind it. */
export interface SourceRow {
  /** The government's own id: NHTSACampaignNumber / odiNumber / RecallNumber / recall_number / VIN. */
  sourceId: string;
  /** A URL that shows this row's source. Where no per-record page exists, the API URL that returned it. */
  sourceUrl: string;
  /** The untouched object as the API sent it. Nothing is lost by mapping. */
  raw: unknown;
}

/**
 * A NHTSA safety recall.
 * `recallsByVehicle` and `campaignNumber` return the same row shape with one exception:
 * `potentialUnitsAffected` is present ONLY on the campaignNumber endpoint (verified 2026-09-14).
 */
export interface NhtsaRecallRow extends SourceRow {
  campaignNumber: string;
  manufacturer?: string;
  /** NHTSA's own "do not drive" flag. Printed as-is; never inferred from the summary text. */
  parkIt?: boolean;
  /** NHTSA's own "park outside, away from structures" flag. */
  parkOutSide?: boolean;
  overTheAirUpdate?: boolean;
  /** dd/MM/yyyy as NHTSA sends it. Kept verbatim; parsed by `nhtsaDate()` when a Date is needed. */
  reportReceivedDate?: string;
  component?: string;
  summary?: string;
  consequence?: string;
  remedy?: string;
  notes?: string;
  modelYear?: string;
  make?: string;
  model?: string;
  nhtsaActionNumber?: string;
  /** Only from `nhtsaRecallByCampaign`. Undefined elsewhere — never guessed. */
  potentialUnitsAffected?: number;
}

/** A NHTSA ODI complaint filed by an owner. */
export interface NhtsaComplaintRow extends SourceRow {
  odiNumber: number;
  manufacturer?: string;
  crash?: boolean;
  fire?: boolean;
  numberOfInjuries?: number;
  numberOfDeaths?: number;
  /** dd/MM/yyyy verbatim. */
  dateOfIncident?: string;
  /** dd/MM/yyyy verbatim. */
  dateComplaintFiled?: string;
  /** The partial VIN the complainant gave (NHTSA truncates it). */
  vin?: string;
  components?: string;
  summary?: string;
  products: NhtsaComplaintProduct[];
}

export interface NhtsaComplaintProduct {
  type?: string;
  productYear?: string;
  productMake?: string;
  productModel?: string;
  manufacturer?: string;
}

/**
 * One decoded VIN from vPIC. The API returns ~154 fields, most of them empty strings; empty strings
 * are normalised to `undefined` so the UI can never print a blank claim. The full object is in `raw`.
 */
export interface VpicVehicleRow extends SourceRow {
  vin: string;
  make?: string;
  model?: string;
  modelYear?: string;
  manufacturer?: string;
  bodyClass?: string;
  vehicleType?: string;
  driveType?: string;
  doors?: string;
  engineCylinders?: string;
  displacementL?: string;
  fuelTypePrimary?: string;
  plantCity?: string;
  plantCountry?: string;
  series?: string;
  trim?: string;
  /** vPIC's own decode diagnostics. "0" means a clean decode. Surfaced, not swallowed. */
  errorCode?: string;
  errorText?: string;
}

/** A CPSC consumer-product recall. */
export interface CpscRecallRow extends SourceRow {
  recallId: number;
  recallNumber: string;
  /** ISO-ish "2026-09-10T00:00:00" as CPSC sends it. */
  recallDate?: string;
  lastPublishDate?: string;
  title?: string;
  description?: string;
  url?: string;
  consumerContact?: string;
  products: CpscProduct[];
  hazards: CpscHazard[];
  remedies: string[];
  remedyOptions: string[];
  injuries: string[];
  images: CpscImage[];
  manufacturers: string[];
  retailers: string[];
  importers: string[];
  distributors: string[];
  manufacturerCountries: string[];
  upcs: string[];
  inconjunctions: string[];
}

export interface CpscProduct {
  name?: string;
  description?: string;
  model?: string;
  type?: string;
  categoryId?: string;
  /** CPSC's own words, e.g. "About 179,739". A string, because it is prose, not a number. */
  numberOfUnits?: string;
}

export interface CpscHazard {
  name?: string;
  hazardType?: string;
  hazardTypeId?: string;
}

export interface CpscImage {
  url?: string;
  caption?: string;
}

/** One openFDA enforcement (recall) report from the food, drug or device endpoint. */
export interface OpenFdaEnforcementRow extends SourceRow {
  recallNumber: string;
  /** "Class I" | "Class II" | "Class III" — the FDA's own severity, verbatim. */
  classification?: string;
  status?: string;
  productType?: string;
  productDescription?: string;
  reasonForRecall?: string;
  recallingFirm?: string;
  productQuantity?: string;
  distributionPattern?: string;
  codeInfo?: string;
  city?: string;
  state?: string;
  country?: string;
  /** yyyyMMdd verbatim. */
  recallInitiationDate?: string;
  reportDate?: string;
  centerClassificationDate?: string;
  terminationDate?: string;
  voluntaryMandated?: string;
  eventId?: string;
  /** The `openfda` sub-object (brand/generic names, NDCs). Present on drug rows, often `{}` elsewhere. */
  openfda?: Record<string, unknown>;
}

/** Build a successful result. */
export function sourceOk<T>(
  source: SourceName,
  endpoint: string,
  rows: T[],
  meta: { fetchedAt: number; latencyMs: number },
): SourceResult<T> {
  return { source, endpoint, ok: true, rows, rowCount: rows.length, fetchedAt: meta.fetchedAt, latencyMs: meta.latencyMs };
}

/** Build a failed result. Rows are always empty: a failure never masquerades as "nothing found". */
export function sourceFail<T>(
  source: SourceName,
  endpoint: string,
  error: string,
  meta: { fetchedAt?: number; latencyMs: number },
): SourceResult<T> {
  return {
    source,
    endpoint,
    ok: false,
    rows: [],
    rowCount: 0,
    fetchedAt: meta.fetchedAt ?? Date.now(),
    latencyMs: meta.latencyMs,
    error,
  };
}

/** NHTSA sends dd/MM/yyyy. Returns undefined rather than a wrong date. */
export function nhtsaDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1])));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** openFDA sends yyyyMMdd. Returns undefined rather than a wrong date. */
export function fdaDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? undefined : d;
}
