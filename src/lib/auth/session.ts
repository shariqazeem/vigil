import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Who is using Warden right now. There is no sign-up: a service is yours because a signed cookie
 * says so. Nothing about watching your own services should require an account to be created before the agent
 * can start, and nothing here is worth more to an attacker than the list of your own
 * services — so the identity is one HMAC-signed random key, held for a year.
 */
export interface Owner {
  key: string;
  kind: "anon";
}

const COOKIE = "warden_owner";
const YEAR = 60 * 60 * 24 * 365;

function secret(): string {
  return process.env.WARDEN_SESSION_SECRET?.trim() || "warden-dev-secret";
}
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");
const sign = (payload: string) => createHmac("sha256", secret()).update(payload).digest("base64url");

export function encodeOwner(o: Owner): string {
  const payload = b64(JSON.stringify(o));
  return `${payload}.${sign(payload)}`;
}

export function decodeOwner(raw: string | undefined): Owner | null {
  if (!raw) return null;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return null;
  const expect = sign(payload);
  if (sig.length !== expect.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const o = JSON.parse(unb64(payload)) as Owner;
    return typeof o.key === "string" && o.kind === "anon" ? o : null;
  } catch {
    return null;
  }
}

/** The current owner, or null when there is no cookie yet. Safe in pages and route handlers. */
export async function currentOwner(): Promise<Owner | null> {
  const jar = await cookies();
  return decodeOwner(jar.get(COOKIE)?.value);
}

export function anonymousOwner(): Owner {
  return { key: `anon:${randomBytes(12).toString("base64url")}`, kind: "anon" };
}

/** Cookie attributes for a Set-Cookie on a Response. Route handlers use this; pages cannot set cookies. */
export function ownerCookie(o: Owner): { name: string; value: string; httpOnly: true; sameSite: "lax"; secure: boolean; path: "/"; maxAge: number } {
  return { name: COOKIE, value: encodeOwner(o), httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: YEAR };
}
export const OWNER_COOKIE = COOKIE;

/**
 * A service is shown to its owner. The one exception is the fleet registered under the literal
 * owner key "demo", which is public on purpose: anyone with the link can watch Warden work on real
 * services without signing in or setting anything up.
 */
export function canView(ownerKey: string, owner: Owner | null): boolean {
  if (ownerKey === "demo") return true;
  return owner?.key === ownerKey;
}
