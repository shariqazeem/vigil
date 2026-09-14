/**
 * CPSC — every consumer-product recall the US government has published (cribs, heaters, strollers,
 * button-cell toys). One keyless endpoint: https://www.saferproducts.gov/RestWebServices/Recall
 *
 * Verified 2026-09-14 by calling it:
 *  - `format=json` is REQUIRED. Without it the service answers XML with HTTP 200.
 *  - Working filters: `RecallDateStart`, `RecallDateEnd` (yyyy-MM-dd), `ProductName`, `RecallTitle`,
 *    `RecallNumber`. Unknown parameters are ignored silently (no error, no filtering).
 *  - `ProductName` and `RecallTitle` are substring searches over the whole archive back to the
 *    1970s — `ProductName=stroller` returned 111 rows, the oldest dated 1977-12-16.
 *  - A malformed date is the dangerous case: HTTP 200 with ONE fake row,
 *    `{"RecallID":0,"RecallNumber":null,"Title":"Error retrieving Recalls: …"}`. Left alone that
 *    reads as "one recall". `parseCpscRecalls` turns it into `ok:false`.
 *
 * Vigil matches many household things against ONE recent corpus rather than querying per product,
 * so `cpscRecent()` pulls the window once and caches it for 24h.
 */
import { z } from "zod";
import { getJson, withQuery, type GetJsonOptions } from "./http";
import {
  sourceFail,
  sourceOk,
  type CpscHazard,
  type CpscImage,
  type CpscProduct,
  type CpscRecallRow,
  type SourceResult,
} from "./types";

export const CPSC_RECALL_ENDPOINT = "https://www.saferproducts.gov/RestWebServices/Recall";
/** CPSC is the slow one: seconds, occasionally tens of seconds, for a wide date window. */
export const CPSC_TIMEOUT_MS = 45_000;
export const CPSC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CpscQuery {
  /** yyyy-MM-dd */
  recallDateStart?: string;
  /** yyyy-MM-dd */
  recallDateEnd?: string;
  /** Substring match on product name, across the whole archive. */
  productName?: string;
  /** Substring match on the recall title. */
  recallTitle?: string;
  recallNumber?: string;
}

const str = z.string().optional().catch(undefined);

const named = z.object({ Name: str });
const productSchema = z.object({
  Name: str,
  Description: str,
  Model: str,
  Type: str,
  CategoryID: str,
  NumberOfUnits: str,
});
const hazardSchema = z.object({ Name: str, HazardType: str, HazardTypeID: str });
const imageSchema = z.object({ URL: str, Caption: str });

const recallSchema = z.object({
  RecallID: z.number().optional().catch(undefined),
  RecallNumber: str,
  RecallDate: str,
  LastPublishDate: str,
  Description: str,
  URL: str,
  Title: str,
  ConsumerContact: str,
  Products: z.array(z.unknown()).optional().catch(undefined),
  Hazards: z.array(z.unknown()).optional().catch(undefined),
  Remedies: z.array(z.unknown()).optional().catch(undefined),
  RemedyOptions: z.array(z.unknown()).optional().catch(undefined),
  Injuries: z.array(z.unknown()).optional().catch(undefined),
  Images: z.array(z.unknown()).optional().catch(undefined),
  Manufacturers: z.array(z.unknown()).optional().catch(undefined),
  Retailers: z.array(z.unknown()).optional().catch(undefined),
  Importers: z.array(z.unknown()).optional().catch(undefined),
  Distributors: z.array(z.unknown()).optional().catch(undefined),
  ManufacturerCountries: z.array(z.unknown()).optional().catch(undefined),
  ProductUPCs: z.array(z.unknown()).optional().catch(undefined),
  Inconjunctions: z.array(z.unknown()).optional().catch(undefined),
});

function names(list: unknown[] | undefined): string[] {
  return (list ?? []).flatMap((x) => {
    const p = named.safeParse(x);
    return p.success && p.data.Name ? [p.data.Name] : [];
  });
}

function pluck(list: unknown[] | undefined, key: string): string[] {
  return (list ?? []).flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const value = (x as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim().length ? [value] : [];
  });
}

/** CPSC's own error sentinel: a row with id 0 and the error in the Title. */
const ERROR_TITLE = /^Error retrieving Recalls/i;

export function parseCpscRecalls(
  body: unknown,
  endpoint: string,
  meta: { fetchedAt: number; latencyMs: number },
): SourceResult<CpscRecallRow> {
  const list = z.array(z.unknown()).safeParse(body);
  if (!list.success) {
    return sourceFail("cpsc-recalls", endpoint, "malformed response: expected an array of recalls", meta);
  }

  const rows: CpscRecallRow[] = [];
  for (const raw of list.data) {
    const parsed = recallSchema.safeParse(raw);
    if (!parsed.success) continue;
    const r = parsed.data;
    if (r.Title && ERROR_TITLE.test(r.Title)) {
      // CPSC answered 200 with its own error text. That is a failure, not a recall.
      return sourceFail("cpsc-recalls", endpoint, r.Title.slice(0, 300), meta);
    }
    const recallNumber = r.RecallNumber?.trim();
    if (!recallNumber || typeof r.RecallID !== "number" || r.RecallID === 0) continue;

    const products: CpscProduct[] = (r.Products ?? []).flatMap((p) => {
      const q = productSchema.safeParse(p);
      return q.success
        ? [{
            name: q.data.Name,
            description: q.data.Description,
            model: q.data.Model,
            type: q.data.Type,
            categoryId: q.data.CategoryID,
            numberOfUnits: q.data.NumberOfUnits,
          }]
        : [];
    });
    const hazards: CpscHazard[] = (r.Hazards ?? []).flatMap((h) => {
      const q = hazardSchema.safeParse(h);
      return q.success ? [{ name: q.data.Name, hazardType: q.data.HazardType, hazardTypeId: q.data.HazardTypeID }] : [];
    });
    const images: CpscImage[] = (r.Images ?? []).flatMap((i) => {
      const q = imageSchema.safeParse(i);
      return q.success ? [{ url: q.data.URL, caption: q.data.Caption }] : [];
    });

    rows.push({
      sourceId: recallNumber,
      // CPSC ships the human page in the payload; fall back to the query that returned the row.
      sourceUrl: r.URL?.trim() || endpoint,
      raw,
      recallId: r.RecallID,
      recallNumber,
      recallDate: r.RecallDate,
      lastPublishDate: r.LastPublishDate,
      title: r.Title,
      description: r.Description,
      url: r.URL,
      consumerContact: r.ConsumerContact,
      products,
      hazards,
      remedies: names(r.Remedies),
      remedyOptions: pluck(r.RemedyOptions, "Option"),
      injuries: names(r.Injuries),
      images,
      manufacturers: names(r.Manufacturers),
      retailers: names(r.Retailers),
      importers: names(r.Importers),
      distributors: names(r.Distributors),
      manufacturerCountries: pluck(r.ManufacturerCountries, "Country"),
      upcs: pluck(r.ProductUPCs, "UPC"),
      inconjunctions: pluck(r.Inconjunctions, "URL"),
    });
  }
  return sourceOk("cpsc-recalls", endpoint, rows, meta);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function cpscEndpoint(query: CpscQuery): string {
  return withQuery(CPSC_RECALL_ENDPOINT, {
    format: "json",
    RecallDateStart: query.recallDateStart,
    RecallDateEnd: query.recallDateEnd,
    ProductName: query.productName,
    RecallTitle: query.recallTitle,
    RecallNumber: query.recallNumber,
  });
}

/** Any CPSC query. Defaults: 45s timeout, 24h cache — override per call. */
export async function cpscRecalls(query: CpscQuery = {}, options: GetJsonOptions = {}): Promise<SourceResult<CpscRecallRow>> {
  const endpoint = cpscEndpoint(query);
  for (const [label, value] of [["recallDateStart", query.recallDateStart], ["recallDateEnd", query.recallDateEnd]] as const) {
    if (value !== undefined && !ISO_DATE.test(value)) {
      // Sending this would earn a 200 with a fake error row; refuse locally instead.
      return sourceFail("cpsc-recalls", endpoint, `${label} must be yyyy-MM-dd`, { latencyMs: 0 });
    }
  }
  const res = await getJson(endpoint, {
    timeoutMs: CPSC_TIMEOUT_MS,
    cacheTtlMs: CPSC_CACHE_TTL_MS,
    ...options,
  });
  if (!res.ok) {
    return sourceFail("cpsc-recalls", endpoint, res.error ?? "request failed", { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
  }
  return parseCpscRecalls(res.body, endpoint, { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
}

/** Days back from today, as yyyy-MM-dd. */
export function isoDaysAgo(days: number, now: Date = new Date()): string {
  const d = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/**
 * The recent corpus, fetched once and cached for 24h, for matching a whole household against.
 * Default window: the last 180 days (177 recalls for 2026-06-01 onward on 2026-09-14).
 */
export async function cpscRecent(sinceISO: string = isoDaysAgo(180), options: GetJsonOptions = {}): Promise<SourceResult<CpscRecallRow>> {
  return cpscRecalls({ recallDateStart: sinceISO }, options);
}
