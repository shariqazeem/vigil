import { describe, expect, it } from "vitest";
import { execute } from "../operations";
import { DEFAULT_POLICY, OBSERVE_ONLY, decide } from "../policy";

/**
 * THE ONE CHECK THAT FAILS BEFORE ANYTHING IS BROKEN.
 *
 * A certificate that expires at 3am takes a service down completely, from perfectly healthy, with no
 * deploy and no crash to investigate — and the fix takes minutes if anybody knows in time. So this
 * one fails while there are still days left, which makes its incident a warning rather than an
 * outage, and makes it the only probe Warden can raise that is not already too late.
 *
 * These tests reach the network on purpose, against hosts that exist to be reached this way. They
 * are the only tests in the suite that do, and each one is skipped rather than failed when there is
 * no network, because a test that fails on a train is a test people learn to ignore.
 */
const TARGET = { host: "local", sshKey: null, repo: null, process: null, nodeBin: null };
const online = async () => {
  try {
    await fetch("https://example.com/", { method: "HEAD", signal: AbortSignal.timeout(4000) });
    return true;
  } catch {
    return false;
  }
};

describe("reading a certificate", () => {
  it("reports the days left on a healthy one", async () => {
    if (!(await online())) return;
    const r = await execute("tls_expiry", { url: "https://example.com/", warnDays: 1 }, TARGET);
    expect(r.ok).toBe(true);
    expect(r.stdout).toMatch(/\d+ days left, until \d{4}-\d{2}-\d{2}/);
    expect((r.data as { days: number }).days).toBeGreaterThan(0);
  }, 20_000);

  it("fails on an expired one and says when it expired", async () => {
    if (!(await online())) return;
    // badssl.com maintains this host precisely so that things like this can be tested.
    const r = await execute("tls_expiry", { url: "https://expired.badssl.com/", warnDays: 14 }, TARGET);
    expect(r.ok).toBe(false);
    expect(r.stdout).toMatch(/expired \d+ days ago, on \d{4}-\d{2}-\d{2}/);
  }, 20_000);

  it("fails while there is still time, which is the entire point", async () => {
    if (!(await online())) return;
    // The same healthy certificate, asked for more notice than it has left.
    const r = await execute("tls_expiry", { url: "https://example.com/", warnDays: 365 }, TARGET);
    expect(r.ok).toBe(false);
    expect(r.stdout).toMatch(/expires in \d+ days?, on /);
    expect((r.data as { days: number }).days).toBeGreaterThan(0);
  }, 20_000);

  it("says there is nothing to watch on an http URL rather than failing", async () => {
    const r = await execute("tls_expiry", { url: "http://example.com/" }, TARGET);
    expect(r.ok).toBe(true);
    expect(r.stdout).toContain("no certificate to expire");
  });

  it("fails, without throwing, when nothing answers", async () => {
    const r = await execute("tls_expiry", { url: "https://127.0.0.1:9/", timeoutMs: 2000 }, TARGET);
    expect(r.ok).toBe(false);
    expect(r.stdout || r.error).toMatch(/could not read the certificate|did not answer/);
  }, 15_000);

  it("refuses a threshold that is not a number of days", async () => {
    expect((await execute("tls_expiry", { url: "https://example.com/", warnDays: 3650 }, TARGET)).ok).toBe(false);
    expect((await execute("tls_expiry", { url: "https://example.com/", warnDays: 0 }, TARGET)).ok).toBe(false);
  });
});

describe("where it sits in the policy", () => {
  it("is a read, so watching only still grants it", () => {
    expect(decide("tls_expiry", OBSERVE_ONLY, { actionsTaken: 0, minutesSinceLastAction: null }).verdict).toBe("allow");
    expect(decide("tls_expiry", DEFAULT_POLICY, { actionsTaken: 0, minutesSinceLastAction: null }).verdict).toBe("allow");
  });

  it("works on a service with no machine, because it is a question about the network", async () => {
    const r = await execute("tls_expiry", { url: "http://example.com/" }, { host: "local", sshKey: null, repo: null, process: null, nodeBin: null });
    expect(r.error ?? "").not.toContain("asks about a machine");
  });
});
