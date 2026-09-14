/**
 * openFDA enforcement reports — the FDA's own recall records for food, drugs and devices
 * (https://api.fda.gov/{food,drug,device}/enforcement.json). Keyless; the FDA documents a limit of
 * 240 requests/minute per IP without a key, which is why Vigil caches and batches rather than
 * querying per household item.
 *
 * Verified 2026-09-14:
 *  - all three domains answer, same field set; `openfda` is populated on drug rows, `{}` on most
 *    food and device rows.
 *  - ZERO MATCHES IS AN HTTP 404 with `{"error":{"code":"NOT_FOUND","message":"No matches found!"}}`.
 *    That is a real answer — the FDA has nothing on this product — so it maps to `ok:true` with no
 *    rows. Caveat, documented rather than hidden: an unknown search FIELD produces exactly the same
 *    404, so a typo'd field reads as "nothing found" and there is no way to tell them apart from
 *    the response alone. Field names are therefore constants here, not free text.
 *  - `classification` ("Class I/II/III"), `status`, `reason_for_recall` are the FDA's own words.
 */
import { z } from "zod";
import { getJson, type GetJsonOptions } from "./http";
import { sourceFail, sourceOk, type OpenFdaEnforcementRow, type SourceResult } from "./types";

export type OpenFdaDomain = "food" | "drug" | "device";

export const OPENFDA_BASE = "https://api.fda.gov";
/** The searchable fields Vigil uses. Kept as constants because a typo'd field silently returns 404. */
export const OPENFDA_FIELDS = {
  productDescription: "product_description",
  reason: "reason_for_recall",
  firm: "recalling_firm",
  classification: "classification",
  recallNumber: "recall_number",
  reportDate: "report_date",
  status: "status",
} as const;

export interface OpenFdaQuery {
  /** food | drug | device. `area` is accepted as a synonym for callers that speak in areas. */
  domain?: OpenFdaDomain;
  area?: OpenFdaDomain;
  /** Lucene-ish query, e.g. `product_description:"infant formula"`. Build it with `fdaTerm`/`fdaAnd`. */
  search?: string;
  /** Plain words: each is matched against `product_description` and they are ANDed. `search` wins. */
  terms?: string[];
  /** 1-1000. Default 20. */
  limit?: number;
  skip?: number;
  sort?: string;
}

/** The domain a query names, whichever spelling it used. */
export function openFdaDomainOf(query: OpenFdaQuery): OpenFdaDomain | undefined {
  return query.domain ?? query.area;
}

/** The query string a call resolves to: an explicit `search`, else the ANDed `terms`. */
export function openFdaSearchOf(query: OpenFdaQuery): string | undefined {
  if (query.search?.trim()) return query.search;
  const terms = (query.terms ?? []).map((t) => t.trim()).filter((t) => t.length);
  if (!terms.length) return undefined;
  return fdaAnd(...terms.map((t) => fdaTerm(OPENFDA_FIELDS.productDescription, t)));
}

const str = z.string().optional().catch(undefined);

const rowSchema = z.object({
  recall_number: str,
  classification: str,
  status: str,
  product_type: str,
  product_description: str,
  reason_for_recall: str,
  recalling_firm: str,
  product_quantity: str,
  distribution_pattern: str,
  code_info: str,
  city: str,
  state: str,
  country: str,
  recall_initiation_date: str,
  report_date: str,
  center_classification_date: str,
  termination_date: str,
  voluntary_mandated: str,
  event_id: str,
  openfda: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

const envelope = z.object({
  meta: z.unknown().optional(),
  results: z.array(z.unknown()),
});

const errorEnvelope = z.object({
  error: z.object({ code: z.string().optional(), message: z.string().optional() }),
});

/** `field:"value"`, with the quotes the FDA needs and any inner quote stripped. */
export function fdaTerm(field: string, value: string): string {
  return `${field}:"${value.replace(/["\\]/g, " ").trim()}"`;
}

export function fdaAnd(...terms: string[]): string {
  return terms.filter((t) => t.trim().length).join("+AND+");
}

/** `report_date:[20260101+TO+20261231]` — the FDA's own range syntax. */
export function fdaDateRange(field: string, fromYyyyMmDd: string, toYyyyMmDd: string): string {
  return `${field}:[${fromYyyyMmDd}+TO+${toYyyyMmDd}]`;
}

export function openFdaEndpoint(query: OpenFdaQuery): string {
  const base = `${OPENFDA_BASE}/${openFdaDomainOf(query) ?? "food"}/enforcement.json`;
  // `search` is built by the callers above and already carries the FDA's `+AND+` / `[a+TO+b]`
  // punctuation, which URLSearchParams would re-encode into something the API rejects.
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.skip !== undefined) params.set("skip", String(query.skip));
  if (query.sort) params.set("sort", query.sort);
  const tail = params.toString();
  const resolved = openFdaSearchOf(query);
  const search = resolved ? `search=${encodeURIComponent(resolved).replace(/%2B/g, "+").replace(/%3A/g, ":").replace(/%5B/g, "[").replace(/%5D/g, "]")}` : "";
  const qs = [search, tail].filter((s) => s.length).join("&");
  return qs.length ? `${base}?${qs}` : base;
}

export function parseOpenFda(
  body: unknown,
  endpoint: string,
  domain: OpenFdaDomain,
  meta: { fetchedAt: number; latencyMs: number },
): SourceResult<OpenFdaEnforcementRow> {
  const env = envelope.safeParse(body);
  if (!env.success) {
    return sourceFail("openfda", endpoint, `malformed response: ${env.error.issues[0]?.message ?? "unexpected shape"}`, meta);
  }
  const rows = env.data.results.flatMap((raw): OpenFdaEnforcementRow[] => {
    const parsed = rowSchema.safeParse(raw);
    if (!parsed.success) return [];
    const r = parsed.data;
    const recallNumber = r.recall_number?.trim();
    if (!recallNumber) return [];
    return [{
      sourceId: recallNumber,
      // No public FDA page is keyed by recall_number; the honest link is the API record itself.
      sourceUrl: openFdaEndpoint({ domain, search: fdaTerm(OPENFDA_FIELDS.recallNumber, recallNumber), limit: 1 }),
      raw,
      recallNumber,
      classification: r.classification,
      status: r.status,
      productType: r.product_type,
      productDescription: r.product_description,
      reasonForRecall: r.reason_for_recall,
      recallingFirm: r.recalling_firm,
      productQuantity: r.product_quantity,
      distributionPattern: r.distribution_pattern,
      codeInfo: r.code_info,
      city: r.city,
      state: r.state,
      country: r.country,
      recallInitiationDate: r.recall_initiation_date,
      reportDate: r.report_date,
      centerClassificationDate: r.center_classification_date,
      terminationDate: r.termination_date,
      voluntaryMandated: r.voluntary_mandated,
      eventId: r.event_id,
      openfda: r.openfda,
    }];
  });
  return sourceOk("openfda", endpoint, rows, meta);
}

/** True when a 404 body is the FDA's "no matches" answer rather than a broken request. */
export function isOpenFdaNotFound(status: number, body: unknown): boolean {
  if (status !== 404) return false;
  const parsed = errorEnvelope.safeParse(body);
  return parsed.success && parsed.data.error.code === "NOT_FOUND";
}

export async function openFdaEnforcement(
  query: OpenFdaQuery,
  options: GetJsonOptions = {},
): Promise<SourceResult<OpenFdaEnforcementRow>> {
  const domain = openFdaDomainOf(query);
  // `{limit: 20, ...query}` would be undone by an explicit `limit: undefined`, and openFDA's own
  // default is 1 row — quietly hiding recalls. Resolve it before the URL is built.
  const endpoint = openFdaEndpoint({ ...query, limit: query.limit ?? 20 });
  if (!domain) {
    return sourceFail("openfda", endpoint, "domain must be food, drug or device", { latencyMs: 0 });
  }
  const res = await getJson(endpoint, options);
  if (!res.ok) {
    if (isOpenFdaNotFound(res.status, res.body)) {
      // The FDA looked and has nothing. An answer, not a failure.
      return sourceOk("openfda", endpoint, [], { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
    }
    return sourceFail("openfda", endpoint, res.error ?? "request failed", { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
  }
  return parseOpenFda(res.body, endpoint, domain, { fetchedAt: res.fetchedAt, latencyMs: res.latencyMs });
}

/** The common case: "has anything matching these words been recalled?" */
export async function openFdaByProduct(
  domain: OpenFdaDomain,
  productText: string,
  options: GetJsonOptions & { limit?: number } = {},
): Promise<SourceResult<OpenFdaEnforcementRow>> {
  const { limit, ...http } = options;
  return openFdaEnforcement(
    { domain, search: fdaTerm(OPENFDA_FIELDS.productDescription, productText), limit: limit ?? 20 },
    http,
  );
}
