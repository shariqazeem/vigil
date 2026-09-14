import { afterEach, describe, expect, it } from "vitest";
import { checkHost, checkProbeUrl } from "../targets";

/**
 * A PROBE IS A SERVER-SIDE FETCH ON A TIMER, AND ANYONE CAN REGISTER ONE.
 *
 * That sentence is the entire threat model of this file. Before the web could register a service,
 * pointing Warden at something meant editing a file on the machine it runs on; now "watch this URL
 * for me" is one form submission, and the interesting question for an attacker is whether they can
 * make it fetch something from inside the network it lives in.
 */
const PRIVATE = process.env.WARDEN_ALLOW_PRIVATE_TARGETS;
afterEach(() => {
  if (PRIVATE === undefined) delete process.env.WARDEN_ALLOW_PRIVATE_TARGETS;
  else process.env.WARDEN_ALLOW_PRIVATE_TARGETS = PRIVATE;
});

describe("the cloud metadata service, which is refused everywhere", () => {
  const METADATA = [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://[fd00:ec2::254]/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
  ];

  it.each(METADATA)("refuses %s", (url) => {
    expect(checkProbeUrl(url).ok).toBe(false);
  });

  it("refuses it even where private targets are deliberately allowed", () => {
    // This is the one rule an operator cannot switch off, because the thing on the other end is
    // the machine's own credentials and no watch has ever legitimately wanted them.
    process.env.WARDEN_ALLOW_PRIVATE_TARGETS = "1";
    for (const url of METADATA) expect(checkProbeUrl(url).ok, url).toBe(false);
  });
});

describe("private space, refused by default and allowed on purpose", () => {
  const INSIDE = [
    "http://localhost:3000/",
    "http://127.0.0.1/health",
    "http://10.0.0.5/",
    "http://192.168.1.10/",
    "http://172.16.4.2/",
    "http://[::1]/",
    "http://db.internal/",
    "http://printer.local/",
    "http://intranet/",
  ];

  it.each(INSIDE)("refuses %s on an instance strangers can reach", (url) => {
    delete process.env.WARDEN_ALLOW_PRIVATE_TARGETS;
    const v = checkProbeUrl(url);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("private");
  });

  it.each(INSIDE)("allows %s when the operator has said so", (url) => {
    process.env.WARDEN_ALLOW_PRIVATE_TARGETS = "1";
    expect(checkProbeUrl(url).ok, url).toBe(true);
  });
});

describe("what a watch is allowed to be", () => {
  it("accepts an ordinary public URL", () => {
    expect(checkProbeUrl("https://example.com/health").ok).toBe(true);
    expect(checkProbeUrl("http://example.com:8080/up").ok).toBe(true);
  });

  it("refuses a scheme that is not a request over http", () => {
    for (const url of ["file:///etc/passwd", "gopher://example.com/", "ftp://example.com/"]) {
      expect(checkProbeUrl(url).ok, url).toBe(false);
    }
  });

  it("refuses credentials in the URL, because the reading is written down", () => {
    const v = checkProbeUrl("https://user:hunter2@example.com/health");
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("credential");
  });

  it("refuses something that is not a URL at all", () => {
    expect(checkProbeUrl("example.com").ok).toBe(false);
    expect(checkProbeUrl("").ok).toBe(false);
  });

  it("is not fooled by a trailing dot or capitals, which resolve to the same host", () => {
    delete process.env.WARDEN_ALLOW_PRIVATE_TARGETS;
    expect(checkHost("LOCALHOST.").ok).toBe(false);
    expect(checkHost("127.0.0.1.").ok).toBe(false);
  });

  it("refuses an ssh destination inside the network the same way", () => {
    delete process.env.WARDEN_ALLOW_PRIVATE_TARGETS;
    expect(checkHost("10.0.0.9").ok).toBe(false);
    expect(checkHost("203.0.113.10").ok).toBe(true);
  });
});
