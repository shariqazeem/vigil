/**
 * The transport, and the two properties the product rests on:
 *  - a cache hit reports the ORIGINAL fetch time, so "as of" on screen is never a lie;
 *  - anything short of a 2xx with parseable JSON is a FAILURE, never an empty-and-therefore-clean
 *    answer. NHTSA's HTTP 400 body literally reads `{"Count":0,"results":[]}`; if that ever renders
 *    as "no recalls for your car", the product has lied to someone about a car they drive.
 */
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cachePath, getJson, USER_AGENT, withQuery } from "../http";
import { nhtsaRecallsByVehicle } from "../nhtsa";

const URL_A = "https://example.test/a";

let cacheDir: string;
const originalCacheDir = process.env.VIGIL_CACHE_DIR;

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "vigil-cache-"));
  process.env.VIGIL_CACHE_DIR = cacheDir;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalCacheDir === undefined) delete process.env.VIGIL_CACHE_DIR;
  else process.env.VIGIL_CACHE_DIR = originalCacheDir;
});

function jsonOnce(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("getJson caching", () => {
  it("returns the ORIGINAL fetchedAt on a cache hit, and does not call out again", async () => {
    const fetchMock = jsonOnce({ hello: "world" });
    vi.stubGlobal("fetch", fetchMock);

    const first = await getJson(URL_A);
    expect(first.ok).toBe(true);
    expect(first.fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 5));

    const second = await getJson(URL_A);
    expect(second.fromCache).toBe(true);
    expect(second.body).toEqual({ hello: "world" });
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.fetchedAt).toBeLessThan(Date.now());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the Vigil user agent", async () => {
    const fetchMock = jsonOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await getJson(URL_A);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["user-agent"]).toBe(USER_AGENT);
  });

  it("goes live when the entry is older than the TTL", async () => {
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      cachePath(URL_A),
      JSON.stringify({ url: URL_A, status: 200, fetchedAt: Date.now() - 10 * 60 * 60 * 1000, body: { stale: true } }),
      "utf8",
    );
    const fetchMock = jsonOnce({ stale: false });
    vi.stubGlobal("fetch", fetchMock);

    const withinTtl = await getJson(URL_A, { cacheTtlMs: 12 * 60 * 60 * 1000 });
    expect(withinTtl.body).toEqual({ stale: true });
    expect(fetchMock).not.toHaveBeenCalled();

    const beyondTtl = await getJson(URL_A, { cacheTtlMs: 60 * 1000 });
    expect(beyondTtl.body).toEqual({ stale: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("`fresh` skips the read but still writes the entry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ n: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ n: 2 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await getJson(URL_A);
    const fresh = await getJson(URL_A, { fresh: true });
    expect(fresh.body).toEqual({ n: 2 });
    const cached = await getJson(URL_A);
    expect(cached.fromCache).toBe(true);
    expect(cached.body).toEqual({ n: 2 });
    expect(cached.fetchedAt).toBe(fresh.fetchedAt);
  });

  it("degrades to a live fetch when the cache directory cannot be used", async () => {
    // A file where the directory should be: every read and write throws.
    const bogus = join(cacheDir, "not-a-dir");
    await writeFile(bogus, "x", "utf8");
    process.env.VIGIL_CACHE_DIR = bogus;
    const fetchMock = jsonOnce({ fine: true });
    vi.stubGlobal("fetch", fetchMock);

    const res = await getJson(URL_A);
    expect(res.ok).toBe(true);
    expect(res.body).toEqual({ fine: true });
    const again = await getJson(URL_A);
    expect(again.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ Count: 0, results: [] }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ Count: 1, results: [{}] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const bad = await getJson(URL_A);
    expect(bad.ok).toBe(false);
    const good = await getJson(URL_A);
    expect(good.ok).toBe(true);
    expect(good.fromCache).toBe(false);
  });
});

describe("getJson honesty", () => {
  it("a non-2xx is a failure even when the body parses", async () => {
    vi.stubGlobal("fetch", jsonOnce({ Count: 0, Message: "Results returned successfully", results: [] }, 400));
    const res = await getJson(URL_A);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
    expect(res.error).toBe("HTTP 400");
    // The body is kept so a caller can quote it, but ok:false is what decides.
    expect(res.body).toEqual({ Count: 0, Message: "Results returned successfully", results: [] });
  });

  it("NHTSA's 400-that-looks-clean never becomes 'no recalls'", async () => {
    vi.stubGlobal("fetch", jsonOnce({ Count: 0, Message: "Results returned successfully", results: [] }, 400));
    const res = await nhtsaRecallsByVehicle({ make: "honda", model: "accord", modelYear: 2019 });
    expect(res.ok).toBe(false);
    expect(res.rows).toEqual([]);
    expect(res.rowCount).toBe(0);
    expect(res.error).toBe("HTTP 400");
    expect(res.endpoint).toContain("recallsByVehicle");
  });

  it("a body that is not JSON fails with what it actually got", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<Recalls><Recall>…</Recall></Recalls>", { status: 200 })));
    const res = await getJson(URL_A);
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not JSON");
  });

  it("retries once on a network error, then reports it", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getJson(URL_A, { backoffMs: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(0);
    expect(res.error).toContain("fetch failed");
    expect(res.body).toBeUndefined();
  });

  it("retries a 5xx and keeps the good answer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("upstream is sad", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await getJson(URL_A, { backoffMs: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(true);
    expect(res.body).toEqual({ ok: 1 });
  });

  it("reports a timeout as a timeout", async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await getJson(URL_A, { retries: 0 });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("timed out");
  });
});

describe("withQuery", () => {
  it("drops empty params and keeps the URL printable", () => {
    expect(withQuery("https://api.nhtsa.gov/recalls/recallsByVehicle", { make: "honda", model: "accord", modelYear: 2019, extra: undefined })).toBe(
      "https://api.nhtsa.gov/recalls/recallsByVehicle?make=honda&model=accord&modelYear=2019",
    );
  });
});
