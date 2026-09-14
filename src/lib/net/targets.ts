/**
 * WHAT WARDEN MAY BE POINTED AT.
 *
 * Registering a service used to mean editing a script on the machine Warden runs on, so whoever did
 * it already had a shell there and this file would have been pointless. Now anyone can register one
 * from the web, and "watch this URL for me" is one keystroke away from "fetch this URL for me from
 * inside your network" — the shape of every SSRF there has ever been. A probe is a server-side
 * fetch on a timer, which is precisely the thing an attacker wants.
 *
 * So a target registered through the web is checked here, once, at the point it is written down.
 *
 * The cloud metadata addresses are refused always and everywhere, on any instance, because there is
 * no legitimate reason to point a watch at them and the consequence of getting it wrong is the
 * machine's credentials. Everything else private — localhost, 10/8, 192.168, a .local name — is
 * refused by default and allowed by WARDEN_ALLOW_PRIVATE_TARGETS=1, which is exactly right for
 * somebody running Warden on their own network and exactly wrong for a public instance.
 */

/** The addresses that answer with instance credentials. Refused on every instance, always. */
const METADATA = new Set(["169.254.169.254", "fd00:ec2::254", "metadata.google.internal", "metadata.goog"]);

const privateV4 = (h: string): boolean => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // not an address at all
  return (
    a === 0 || a === 10 || a === 127 || // this network, private, loopback
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, which is where metadata lives
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast and reserved
  );
};

const privateV6 = (h: string): boolean => {
  const x = h.replace(/^\[|\]$/g, "").toLowerCase();
  if (!x.includes(":")) return false;
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("::ffff:");
};

const privateName = (h: string): boolean =>
  h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa") || !h.includes(".");

export const privateTargetsAllowed = (): boolean => process.env.WARDEN_ALLOW_PRIVATE_TARGETS === "1";

export interface TargetVerdict {
  ok: boolean;
  /** why not, addressed to the person who typed it */
  reason?: string;
}

/** Is this host somewhere this instance should be willing to send a request? */
export function checkHost(raw: string): TargetVerdict {
  // URL.hostname keeps the brackets on an IPv6 literal, so "[fd00:ec2::254]" is not the string
  // "fd00:ec2::254" and a set lookup silently misses it. That is how the IPv6 metadata address got
  // past the always-refuse rule while private targets were enabled.
  const host = raw.trim().toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, reason: "There is no host in that." };
  if (METADATA.has(host)) {
    return { ok: false, reason: "That is a cloud metadata address. Warden will not be pointed at one, on any instance — it answers with the machine's own credentials." };
  }
  const isPrivate = privateV4(host) || privateV6(host) || privateName(host);
  if (isPrivate && !privateTargetsAllowed()) {
    return {
      ok: false,
      reason: `${raw} is on a private or local network, and this Warden watches public addresses only. Run your own with WARDEN_ALLOW_PRIVATE_TARGETS=1 to watch things inside your network.`,
    };
  }
  return { ok: true };
}

/** A URL a probe may be pointed at: http or https, a host that passes, no credentials in it. */
export function checkProbeUrl(raw: string): TargetVerdict {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "That is not a URL. It needs to start with http:// or https://." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `Warden checks things over http and https. It cannot check ${url.protocol.replace(":", "")}.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "Take the username and password out of the URL. Warden writes down what it checked, and that record should not contain a credential." };
  }
  return checkHost(url.hostname);
}

/** The origin a probe URL belongs to, which is what the agent is later allowed to look at. */
export function originOf(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}
