/**
 * The one way Vigil talks to a government API.
 *
 * Rules it enforces so the sources above it can stay honest:
 *  - it never throws: a timeout, a DNS failure, a 500 and a page of XML all come back as a value;
 *  - a non-2xx is a FAILURE even when the body parses (NHTSA answers a malformed query with
 *    HTTP 400 and a body that reads `{"Count":0,"results":[]}` — believing that body would tell an
 *    owner their car is clean when nobody looked);
 *  - a cache hit reports the ORIGINAL fetch time, so the UI's "as of" is the truth, not the moment
 *    the page rendered;
 *  - the cache is a convenience, never a dependency: any read or write failure falls through to a
 *    live fetch.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Printed on every request so NHTSA/CPSC/FDA can see who is calling. */
export const USER_AGENT = "Vigil/0.1 (+https://github.com/shariqazeem/vigil)";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export interface GetJsonOptions {
  /** Per-attempt timeout. Default 15s. CPSC gets 45s. */
  timeoutMs?: number;
  /** Extra attempts after the first, on a network error, a timeout, a 5xx or a 429. Default 1. */
  retries?: number;
  /** How long a cached body stays usable. 0 disables the cache for this call. Default 6h. */
  cacheTtlMs?: number;
  /** Skip the cache read (a live call), still write the result back. */
  fresh?: boolean;
  /** Milliseconds between attempts. Default 400. */
  backoffMs?: number;
  headers?: Record<string, string>;
}

export interface JsonResult {
  /** true only for a 2xx whose body parsed as JSON. */
  ok: boolean;
  /** HTTP status, or 0 when the request never got an answer. */
  status: number;
  /** The parsed body. Present even on a non-2xx when the body was JSON, so callers can quote it. */
  body: unknown;
  error?: string;
  /** When this body was actually fetched from the network — preserved across cache hits. */
  fetchedAt: number;
  /** Wall time this call took. A cache hit is the disk read, not the original request. */
  latencyMs: number;
  fromCache: boolean;
}

interface CacheEntry {
  url: string;
  status: number;
  fetchedAt: number;
  body: unknown;
}

/** `VIGIL_CACHE_DIR`, else `var/cache` under the working directory (gitignored). */
export function cacheDir(): string {
  return process.env.VIGIL_CACHE_DIR ?? join(process.cwd(), "var", "cache");
}

export function cachePath(url: string): string {
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 32);
  return join(cacheDir(), `${hash}.json`);
}

async function readCache(url: string, ttlMs: number): Promise<CacheEntry | undefined> {
  if (ttlMs <= 0) return undefined;
  try {
    const text = await readFile(cachePath(url), "utf8");
    const entry = JSON.parse(text) as CacheEntry;
    if (typeof entry?.fetchedAt !== "number") return undefined;
    if (Date.now() - entry.fetchedAt > ttlMs) return undefined;
    return entry;
  } catch {
    // No cache, unreadable cache, half-written cache: all mean "go and ask".
    return undefined;
  }
}

async function writeCache(entry: CacheEntry): Promise<void> {
  try {
    const dir = cacheDir();
    await mkdir(dir, { recursive: true });
    const final = cachePath(entry.url);
    const tmp = `${final}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), "utf8");
    await rename(tmp, final);
  } catch {
    // A read-only disk must not break a lookup.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    // AbortSignal.timeout() rejects with a TimeoutError DOMException.
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timed out";
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

/**
 * GET a URL and parse JSON. Never throws.
 *
 * @param url the exact URL to call — it is also the cache key and what the UI prints.
 */
export async function getJson(url: string, options: GetJsonOptions = {}): Promise<JsonResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? 1;
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const backoffMs = options.backoffMs ?? 400;
  const started = Date.now();

  if (!options.fresh) {
    const hit = await readCache(url, ttlMs);
    if (hit) {
      return {
        ok: true,
        status: hit.status,
        body: hit.body,
        fetchedAt: hit.fetchedAt,
        latencyMs: Date.now() - started,
        fromCache: true,
      };
    }
  }

  let last: JsonResult | undefined;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const attemptStarted = Date.now();
    let status = 0;
    let text: string | undefined;
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        headers: { "user-agent": USER_AGENT, accept: "application/json", ...options.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      text = await res.text();
    } catch (err) {
      last = {
        ok: false,
        status: 0,
        body: undefined,
        error: describe(err),
        fetchedAt: Date.now(),
        latencyMs: Date.now() - started,
        fromCache: false,
      };
      if (attempt < retries) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      return last;
    }

    let body: unknown;
    let parseError: string | undefined;
    try {
      body = text.length ? JSON.parse(text) : undefined;
    } catch {
      parseError = `response was not JSON (${text.slice(0, 80).replace(/\s+/g, " ").trim()}…)`;
    }

    const retryable = status >= 500 || status === 429;
    if (retryable && attempt < retries) {
      last = {
        ok: false,
        status,
        body,
        error: `HTTP ${status}`,
        fetchedAt: Date.now(),
        latencyMs: Date.now() - started,
        fromCache: false,
      };
      await sleep(backoffMs * (attempt + 1));
      continue;
    }

    const fetchedAt = Date.now();
    if (status < 200 || status >= 300) {
      return {
        ok: false,
        status,
        body,
        error: `HTTP ${status}`,
        fetchedAt,
        latencyMs: fetchedAt - attemptStarted,
        fromCache: false,
      };
    }
    if (parseError) {
      return { ok: false, status, body: undefined, error: parseError, fetchedAt, latencyMs: fetchedAt - attemptStarted, fromCache: false };
    }

    if (ttlMs > 0) await writeCache({ url, status, fetchedAt, body });
    return { ok: true, status, body, fetchedAt, latencyMs: fetchedAt - attemptStarted, fromCache: false };
  }

  return last ?? {
    ok: false,
    status: 0,
    body: undefined,
    error: "no attempt was made",
    fetchedAt: Date.now(),
    latencyMs: Date.now() - started,
    fromCache: false,
  };
}

/** Build a URL with only the params that have a value. Keeps endpoints printable and stable. */
export function withQuery(base: string, params: Record<string, string | number | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
